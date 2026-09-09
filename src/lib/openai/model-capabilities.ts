/**
 * B0-606 — which models accept sampling controls (`temperature`), and how to send them safely.
 *
 * Every gpt-5.5 / gpt-5.6 run failed with
 * `400 Unsupported parameter: 'temperature' is not supported with this model.` because
 * `runResponsesWithToolLoop` sent `temperature` unconditionally. Worse than a plain failure: the
 * turn died in the agent loop *after* a retrieval tool call had already run and been paid for.
 *
 * Verified against the live API on 2026-08-20, and it is NOT a version pattern — a `/^gpt-5/`
 * regex would be wrong in both directions:
 *
 *   gpt-5, gpt-5-mini ............. reject
 *   gpt-5.1, gpt-5.2, gpt-5.4 ..... ACCEPT
 *   gpt-5.4-mini .................. accept
 *   gpt-5.5, gpt-5.6 .............. reject
 *   o3-mini ....................... reject
 *   every gpt-4.x ................. accept
 *
 * `top_p` is likewise rejected by the same models, and `temperature: 1` (the API default) is
 * accepted by all of them — but this codebase never sends `top_p` and never sends 1, so
 * `temperature` is the entire blast radius.
 *
 * B0-908 — every `claude-*` id is denied too. Claude Opus 5 / Sonnet 5 return 400 on ANY sampling
 * control (`temperature`, `top_p`, `top_k` were removed alongside `budget_tokens`), and the older
 * 4.x ids only tolerate them; we never send a sampling control to Anthropic on any tier.
 */

import { logWarn } from '~/lib/observability/logger';

/**
 * Model id prefixes verified to reject `temperature`. Prefixes (not exact ids) so dated snapshots
 * like `gpt-5.5-2026-04-23` and tiers like `gpt-5.5-pro` are covered by their family entry.
 *
 * ORDERING MATTERS: matched by prefix, so `gpt-5.` families that DO accept sampling must never be
 * listed here, and a bare `gpt-5` entry would wrongly swallow `gpt-5.1`/`gpt-5.2`/`gpt-5.4`. That
 * is why `gpt-5-` is hyphen-terminated and `gpt-5` is handled as an exact id below.
 */
const SAMPLING_UNSUPPORTED_PREFIXES = [
  'gpt-5-', // gpt-5-mini, gpt-5-nano, gpt-5-pro, dated gpt-5-2025-08-07 …
  'gpt-5.5',
  'gpt-5.6',
  'o1',
  'o3',
  'o4',
  // B0-908 — every Anthropic id. Opus 5 / Sonnet 5 400 on any sampling control; never send one.
  'claude-',
] as const;

/** Exact ids that reject sampling but whose bare name would over-match as a prefix. */
const SAMPLING_UNSUPPORTED_EXACT = ['gpt-5'] as const;

/**
 * Models discovered at runtime to reject `temperature`, so the process stops sending it after the
 * first rejection instead of failing every subsequent turn.
 *
 * This is the part that matters long-term: the denylist above is a point-in-time snapshot and WILL
 * go stale — a stale parameter list is exactly how B0-606 happened. With this, an unfamiliar model
 * costs one failed request rather than a total outage on that model.
 */
const learnedUnsupported = new Set<string>();

function normalize(model: string): string {
  return model.trim().toLowerCase();
}

export function supportsSamplingControls(model: string): boolean {
  const id = normalize(model);
  if (!id) {
    return true;
  }
  if (learnedUnsupported.has(id)) {
    return false;
  }
  if ((SAMPLING_UNSUPPORTED_EXACT as readonly string[]).includes(id)) {
    return false;
  }
  return !SAMPLING_UNSUPPORTED_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Spread this instead of setting `temperature` directly:
 *
 *   ...samplingParamsFor(model, { temperature: 0 })
 *
 * Returns `{}` for a model that rejects it, so the key is absent from the request body rather than
 * present-and-undefined (the API rejects the parameter on presence, not on value).
 */
export function samplingParamsFor(
  model: string,
  params: { temperature?: number },
): { temperature?: number } {
  if (!supportsSamplingControls(model)) {
    return {};
  }
  return params.temperature === undefined ? {} : { temperature: params.temperature };
}

/** True when an API error is specifically the unsupported-`temperature` rejection. */
export function isTemperatureUnsupportedError(err: unknown): boolean {
  const message =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown })?.message === 'string'
          ? String((err as { message: string }).message)
          : '';
  return /unsupported parameter/i.test(message) && /'?temperature'?/i.test(message);
}

/**
 * Records that `model` rejects `temperature`, so later calls in this process omit it. Returns true
 * when this is newly learned (i.e. the caller should retry), false when already known — which also
 * makes the caller's retry non-looping.
 */
export function recordTemperatureRejection(model: string): boolean {
  const id = normalize(model);
  if (!id || learnedUnsupported.has(id) || !supportsSamplingControls(id)) {
    return false;
  }
  learnedUnsupported.add(id);
  logWarn('model_sampling_unsupported_learned', {
    model: id,
    detail:
      'Model rejected `temperature`; omitting it for the rest of this process. Add it to SAMPLING_UNSUPPORTED_PREFIXES in model-capabilities.ts to avoid the first failed request.',
  });
  return true;
}

/** Test-only: clears runtime-learned state so cases cannot leak into each other. */
export function __resetLearnedSamplingSupport(): void {
  learnedUnsupported.clear();
}
