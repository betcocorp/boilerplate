/**
 * B0-966 — getting a cron's self-call past Vercel Deployment Protection.
 *
 * Several crons deliberately drive their work over real HTTP calls back into their OWN deployment
 * rather than importing the handler functions directly (see the module headers on
 * `~/lib/observability/run-golden-test-sweep` and `~/lib/observability/pending-report-sweeper`):
 * the round trip is what guarantees a sweep can never drift from what a human clicking the same
 * button gets. That design has one consequence nobody hit until Deployment Protection was switched
 * on.
 *
 * Vercel admits the INBOUND cron request through protection because Vercel signs it. The outbound
 * `fetch` the function then makes back to the same host is a brand-new request that inherits none
 * of that trust, and the `Authorization: Bearer bex_<env>_…` header it forwards is an APPLICATION
 * token that Vercel's protection layer knows nothing about. The edge rejects it before the route
 * handler ever runs, with:
 *
 *     {"code":"401","message":"Protected deployment"}
 *
 * which surfaced as five `dispatch_create` failures on the 2026-09-12 golden sweep.
 *
 * The fix is the documented Protection Bypass for Automation header. `VERCEL_AUTOMATION_BYPASS_SECRET`
 * is a Vercel SYSTEM environment variable: once the secret exists in the project's Deployment
 * Protection settings it is injected automatically, so it must NOT also be added as a project env
 * var — a second copy silently goes stale the first time the secret is rotated.
 *
 * Header only, never the `?x-vercel-protection-bypass=` query-parameter form Vercel also accepts:
 * a query string lands in access logs, `Referer` headers and browser history, and this secret
 * bypasses protection on production AND every preview deployment.
 */

/** The header Vercel's protection layer reads. */
export const VERCEL_PROTECTION_BYPASS_HEADER = 'x-vercel-protection-bypass';

/**
 * Why a self-call is or is not carrying the bypass header. Recorded on sweep outcomes so a missing
 * secret is distinguishable from a rejected one — before this, both looked like the same opaque
 * upstream 401, and telling them apart meant going and reading the Vercel dashboard.
 */
export type DeploymentProtectionBypassState =
  /** Secret present; the header is attached. */
  | 'attached'
  /**
   * No secret in the environment AND nothing to protect: a `localhost` origin is never behind
   * Deployment Protection, so this is the normal, healthy local-development case.
   */
  | 'not_required_local'
  /**
   * No secret, but the call targets a deployed origin that may well be protected. The request is
   * still attempted — protection may simply be off — but if it comes back 401 this is the reason,
   * and it means either the secret was never generated in Deployment Protection settings or the
   * project is not exposing system environment variables to the deployment.
   */
  | 'missing';

export type DeploymentProtectionBypass = {
  state: DeploymentProtectionBypassState;
  /** Spread into a `fetch` init's `headers`. Empty unless `state` is `attached`. */
  headers: Record<string, string>;
};

/** A `localhost` / loopback origin is never fronted by Vercel's edge. */
function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    // An unparseable origin is not something we can call "local" — treat it as deployed so a
    // missing secret is reported rather than silently excused.
    return false;
  }
}

/**
 * Resolve the bypass header for a self-call to `origin`.
 *
 * Deliberately never throws and never blocks the request: protection may be off entirely, and a
 * hard failure here would break local development and any unprotected environment for no reason.
 * The caller attaches `headers` and reports `state` alongside whatever the request returns.
 */
export function resolveDeploymentProtectionBypass(origin: string): DeploymentProtectionBypass {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

  if (secret) {
    return {
      state: 'attached',
      headers: { [VERCEL_PROTECTION_BYPASS_HEADER]: secret },
    };
  }

  return {
    state: isLocalOrigin(origin) ? 'not_required_local' : 'missing',
    headers: {},
  };
}

/**
 * One sentence explaining a `missing` bypass. Never includes the secret itself.
 */
export const DEPLOYMENT_PROTECTION_BYPASS_MISSING_HINT =
  'VERCEL_AUTOMATION_BYPASS_SECRET is not set in this environment, so the self-call carried no Deployment Protection bypass. Generate the secret under Vercel Project Settings > Deployment Protection > Protection Bypass for Automation, and confirm the project exposes system environment variables to the deployment.';

/**
 * The counterpart: a secret WAS sent and the edge still refused. Distinguishing these two is the
 * whole point — before B0-966 both looked like the same opaque 401.
 */
export const DEPLOYMENT_PROTECTION_BYPASS_REJECTED_HINT =
  'A Deployment Protection bypass secret was sent and still rejected. VERCEL_AUTOMATION_BYPASS_SECRET is likely stale (rotated in Vercel without a redeploy) — regenerate it under Project Settings > Deployment Protection and redeploy.';

/**
 * Explain a failed self-call's status ONLY when Deployment Protection is a plausible cause.
 *
 * Scoped to 401 on purpose. Appending a protection hint to every failure would staple
 * "VERCEL_AUTOMATION_BYPASS_SECRET is not set" onto a network timeout or a 500 from our own route
 * handler, which sends the reader somewhere irrelevant. A 4xx that is not 401 is the application's
 * own auth talking (the request reached the handler), so it is left alone too.
 *
 * Returns '' when there is nothing useful to add, so callers can append unconditionally.
 */
export function describeDeploymentProtectionFailure(
  status: number,
  bypass: Pick<DeploymentProtectionBypass, 'state'>,
): string {
  if (status !== 401) return '';

  if (bypass.state === 'missing') return ` ${DEPLOYMENT_PROTECTION_BYPASS_MISSING_HINT}`;
  if (bypass.state === 'attached') return ` ${DEPLOYMENT_PROTECTION_BYPASS_REJECTED_HINT}`;

  // `not_required_local` — a 401 from localhost is the app's own auth, not the edge's.
  return '';
}
