import { logError, logWarn } from '~/lib/observability/logger';

/**
 * B0-370 — bounded retry for transient OpenAI transport faults.
 *
 * Ten dead runs (0.11%) came from upstream transport faults, not our logic: `TypeError: fetch
 * failed` (×8), one OpenAI 500, one `Connection error.`, one `Request timed out.` — six of them
 * inside a single 58-minute window. Those turns died with `final_output = {"error": "TypeError:
 * fetch failed"}` and the user got nothing.
 *
 * This module is deliberately provider-agnostic: it classifies a thrown value and re-runs a
 * caller-chosen closure. It does **not** know what a model call is, so each runtime keeps ownership
 * of *where* the retry boundary sits (see `runResponsesWithToolLoop` and `runAiSdkWithToolLoop`) —
 * the part that has to be reasoned about per runtime, because retrying across a boundary where a
 * tool already ran would duplicate that tool's side effects.
 *
 * It lives under `~/lib/openai/` because that is the existing lowest common ancestor of the two
 * runtimes (`~/lib/bex/ai-sdk-runtime` already imports its shared types from
 * `~/lib/openai/responses-runtime`), and both runtimes ultimately talk to OpenAI. Nothing here
 * imports the `ai` package, so the AI-SDK-specific middleware stays in the AI SDK runtime.
 *
 * Note on `~/lib/utils.ts#withRetry`: it exists but is not reusable here — it retries *every*
 * error class unconditionally, which this ticket explicitly forbids (a 4xx validation error must
 * never be replayed).
 */

/** Total attempts (first try + retries). 3 attempts = at most 2 retries. */
const DEFAULT_ATTEMPTS = 3;
/** First backoff step before jitter. Kept sub-second: this runs inside a user-facing request. */
const DEFAULT_BASE_DELAY_MS = 250;
/**
 * Backoff ceiling. `Retry-After` is deliberately NOT honoured — a provider may ask for tens of
 * seconds, and we are on a latency-budgeted request path, so a bounded sub-second backoff plus a
 * clean retry-able message beats holding the request open.
 */
const DEFAULT_MAX_DELAY_MS = 2_000;

/**
 * What the user sees instead of a raw `TypeError: fetch failed` once retries are exhausted.
 * Phrased as an explicit invitation to resend, because the turn is not recoverable server-side.
 */
export const UPSTREAM_RETRY_USER_MESSAGE =
  'Bex could not reach the AI service just now — this looks like a temporary upstream problem, not a problem with your question. Please send it again in a moment.';

export type RetryRuntimeTag = 'responses' | 'ai_sdk';

/** Why a thrown value was (or was not) treated as a transient transport fault. */
export type TransportFaultReason =
  | 'network'
  | 'timeout'
  | 'http_429'
  | 'http_5xx'
  | 'http_408'
  | 'provider_retryable'
  | 'not_retryable';

export type TransportFaultClassification = {
  retryable: boolean;
  reason: TransportFaultReason;
  statusCode?: number;
  message: string;
};

/**
 * Terminal error for a transport fault that survived every attempt. `message` is already the
 * user-facing text, so any caller that surfaces `err.message` (the product-support workflow's
 * `catch` does exactly that) shows the retry-able wording without further changes; the raw
 * provider text stays available on `rawMessage`/`cause` for debugging.
 */
export class UpstreamTransportError extends Error {
  /** Structural tag — survives duplicate module instances where `instanceof` can fail. */
  readonly isUpstreamTransportError = true;
  readonly rawMessage: string;
  readonly attempts: number;
  readonly runtime: RetryRuntimeTag;
  readonly reason: TransportFaultReason;
  readonly statusCode?: number;

  constructor(input: {
    rawMessage: string;
    attempts: number;
    runtime: RetryRuntimeTag;
    reason: TransportFaultReason;
    statusCode?: number;
    cause: unknown;
  }) {
    super(UPSTREAM_RETRY_USER_MESSAGE, { cause: input.cause });
    this.name = 'UpstreamTransportError';
    this.rawMessage = input.rawMessage;
    this.attempts = input.attempts;
    this.runtime = input.runtime;
    this.reason = input.reason;
    this.statusCode = input.statusCode;
  }
}

export function isUpstreamTransportError(err: unknown): err is UpstreamTransportError {
  return (
    err instanceof UpstreamTransportError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { isUpstreamTransportError?: unknown }).isUpstreamTransportError === true)
  );
}

/**
 * Message a caller should show for a thrown value: the retry-able wording for an exhausted
 * transport fault, the raw message for everything else (a real defect must stay legible).
 */
export function toUserFacingErrorMessage(err: unknown, fallback?: string): string {
  if (isUpstreamTransportError(err)) {
    return UPSTREAM_RETRY_USER_MESSAGE;
  }
  return err instanceof Error ? err.message : (fallback ?? String(err));
}

/** Node/undici socket-level failures. `fetch failed` surfaces as a TypeError wrapping one of these. */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ENETUNREACH',
  'ENETRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Error class names the OpenAI SDK / fetch stacks use for transport faults. */
const RETRYABLE_ERROR_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'APIUserAbortError_Timeout',
  'ConnectTimeoutError',
  'FetchError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'SocketError',
  'TimeoutError',
]);

/**
 * Substrings for faults that arrive as a bare `Error` with no code — exactly the shape the three
 * non-`fetch failed` production failures had (`Connection error.`, `Request timed out.`).
 */
const RETRYABLE_MESSAGE_FRAGMENTS = [
  'fetch failed',
  'connection error',
  'cannot connect to api',
  'request timed out',
  'timed out',
  'timeout',
  'socket hang up',
  'network error',
  'premature close',
  'terminated',
  'other side closed',
  'read econnreset',
  'server disconnected',
];

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  isRetryable?: unknown;
  cause?: unknown;
  response?: { status?: unknown };
};

function asErrorLike(err: unknown): ErrorLike {
  return typeof err === 'object' && err !== null ? (err as ErrorLike) : {};
}

/** HTTP status across the shapes we see: OpenAI SDK (`status`), AI SDK `APICallError` (`statusCode`). */
function readStatusCode(err: unknown): number | undefined {
  const candidate = asErrorLike(err);
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function messageOf(err: unknown): string {
  const candidate = asErrorLike(err);
  return typeof candidate.message === 'string' ? candidate.message : String(err);
}

/**
 * A user-initiated abort must never be retried; an abort fired by a *timeout* is a transport fault.
 * Node's `AbortError` carries no status, so the wording is the only available signal.
 */
function isTimeoutFlavouredAbort(err: unknown): boolean {
  const candidate = asErrorLike(err);
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  if (name !== 'AbortError' && name !== 'APIUserAbortError') {
    return false;
  }
  return /time(d)?\s*out|timeout/i.test(messageOf(err));
}

/** Walks `cause` (undici nests the real socket error under `TypeError: fetch failed`). */
function collectErrorChain(err: unknown, maxDepth = 4): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < maxDepth && current != null; depth += 1) {
    chain.push(current);
    const next = asErrorLike(current).cause;
    if (next === current) {
      break;
    }
    current = next;
  }
  return chain;
}

/**
 * Classifies a thrown value. HTTP status wins over message sniffing, so a 4xx whose body happens to
 * mention "timeout" is still refused — a validation error must never be replayed.
 */
export function classifyTransportError(err: unknown): TransportFaultClassification {
  const message = messageOf(err);
  const statusCode = readStatusCode(err);

  if (typeof statusCode === 'number') {
    if (statusCode >= 500) {
      return { retryable: true, reason: 'http_5xx', statusCode, message };
    }
    if (statusCode === 429) {
      return { retryable: true, reason: 'http_429', statusCode, message };
    }
    // 408 is a transport timeout by definition, never a validation failure; the OpenAI SDK's own
    // policy retries it too. Every other 4xx is a hard stop.
    if (statusCode === 408) {
      return { retryable: true, reason: 'http_408', statusCode, message };
    }
    if (statusCode >= 400) {
      return { retryable: false, reason: 'not_retryable', statusCode, message };
    }
  }

  const chain = collectErrorChain(err);

  /**
   * Pass 1 — structural signals anywhere in the chain. These are checked before message sniffing so
   * the *precise* fault wins: undici reports `TypeError: fetch failed` on the outside and the real
   * code (`ECONNRESET` vs `UND_ERR_CONNECT_TIMEOUT`) on the cause, and the distinction is what makes
   * the `reason` field useful for incident triage.
   */
  for (const link of chain) {
    const candidate = asErrorLike(link);

    // The AI SDK marks network faults and retryable HTTP codes on `APICallError.isRetryable`.
    if (candidate.isRetryable === true) {
      return { retryable: true, reason: 'provider_retryable', statusCode, message };
    }

    if (typeof candidate.code === 'string' && RETRYABLE_ERROR_CODES.has(candidate.code)) {
      const timeoutish = candidate.code.includes('TIMEOUT') || candidate.code === 'ETIMEDOUT';
      return {
        retryable: true,
        reason: timeoutish ? 'timeout' : 'network',
        statusCode,
        message,
      };
    }

    if (typeof candidate.name === 'string' && RETRYABLE_ERROR_NAMES.has(candidate.name)) {
      const timeoutish = candidate.name.toLowerCase().includes('timeout');
      return { retryable: true, reason: timeoutish ? 'timeout' : 'network', statusCode, message };
    }

    if (isTimeoutFlavouredAbort(link)) {
      return { retryable: true, reason: 'timeout', statusCode, message };
    }
  }

  // Pass 2 — wording only, for faults that arrive as a bare `Error` (`Connection error.`).
  for (const link of chain) {
    const linkMessage = messageOf(link).toLowerCase();
    if (RETRYABLE_MESSAGE_FRAGMENTS.some((fragment) => linkMessage.includes(fragment))) {
      const timeoutish = linkMessage.includes('time');
      return {
        retryable: true,
        reason: timeoutish ? 'timeout' : 'network',
        statusCode,
        message,
      };
    }
  }

  return { retryable: false, reason: 'not_retryable', statusCode, message };
}

export function isRetryableTransportError(err: unknown): boolean {
  return classifyTransportError(err).retryable;
}

/**
 * Knobs a runtime forwards from its own options (and tests inject `sleep`/`random` so the suite
 * neither waits on real timers nor depends on jitter).
 */
export type TransportRetryTuning = {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: {
    attempt: number;
    attempts: number;
    delayMs: number;
    classification: TransportFaultClassification;
  }) => void;
};

/**
 * B0-550 — per-attempt request timeout for `client.responses.create`/`.stream` calls. The OpenAI
 * SDK's own default (10 minutes) is itself RETRIED by the SDK's default `maxRetries: 2` (see that
 * option's own doc comment: "you may wait much longer than this timeout before the promise
 * succeeds or fails") — production stalls of 2,000-6,200 SECONDS were observed with no bound at
 * all, because none of these call sites overrode either default. Every call site now also passes
 * `maxRetries: 0` to the SDK, so `retryTransportFaults` above is the ONE bounded-retry policy, and
 * this timeout is the only thing bounding a single attempt's wall-clock time.
 *
 * Configurable via `BEX_OPENAI_REQUEST_TIMEOUT_MS` without a redeploy; falls back to the default
 * on anything that is not a positive finite number.
 */
export const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 60_000;

export function resolveOpenAiRequestTimeoutMs(): number {
  const raw = process.env.BEX_OPENAI_REQUEST_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_OPENAI_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OPENAI_REQUEST_TIMEOUT_MS;
}

export type RetryTransportOptions = TransportRetryTuning & {
  runtime: RetryRuntimeTag;
  /** Human label for logs, e.g. `responses.create round 2`. */
  label: string;
  /**
   * Extra veto applied *after* the error classifies as retryable — the runtime's escape hatch for
   * "this particular attempt is no longer safe to replay" (the streaming runtimes use it to refuse
   * a replay once user-visible text has already been emitted).
   */
  canRetry?: (info: { attempt: number; error: unknown }) => boolean;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Equal jitter: half the exponential step is fixed, half is random. Full jitter can collapse to
 * ~0ms, which is useless against a provider that needs a beat to recover; no jitter at all
 * synchronises every in-flight run into the same retry spike during an incident.
 */
export function computeJitteredDelayMs(input: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random: () => number;
}): number {
  const exponential = Math.min(
    input.maxDelayMs,
    input.baseDelayMs * 2 ** Math.max(0, input.attempt - 1),
  );
  const half = exponential / 2;
  return Math.round(half + input.random() * half);
}

/**
 * Runs `fn` up to `attempts` times, retrying only transient transport faults.
 *
 * - a non-retryable error (any 4xx that isn't 408/429) propagates **unchanged** on the first
 *   failure, so genuine defects keep their original message and stack;
 * - a retryable error that runs out of attempts (or is vetoed by `canRetry`) is wrapped in
 *   `UpstreamTransportError`, whose message is the user-facing retry-able text.
 *
 * `fn` receives the 1-based attempt number. It MUST be safe to run more than once — that is the
 * caller's responsibility, and the reason the boundary is chosen per runtime rather than here.
 */
export async function retryTransportFaults<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryTransportOptions,
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      const classification = classifyTransportError(err);

      // Not a transport fault — a 4xx validation error, a bug, anything else. Never replayed.
      if (!classification.retryable) {
        throw err;
      }

      const vetoed = options.canRetry ? !options.canRetry({ attempt, error: err }) : false;
      const exhausted = attempt >= attempts;

      if (exhausted || vetoed) {
        logError('upstream_transport_exhausted', {
          runtime: options.runtime,
          label: options.label,
          attempt,
          attempts,
          reason: classification.reason,
          status_code: classification.statusCode,
          vetoed,
          // Raw provider text is preserved here because the thrown error's message is replaced
          // with the user-facing wording.
          message: classification.message,
        });

        throw new UpstreamTransportError({
          rawMessage: classification.message,
          attempts: attempt,
          runtime: options.runtime,
          reason: classification.reason,
          statusCode: classification.statusCode,
          cause: err,
        });
      }

      const delayMs = computeJitteredDelayMs({ attempt, baseDelayMs, maxDelayMs, random });
      logWarn('upstream_transport_retry', {
        runtime: options.runtime,
        label: options.label,
        attempt,
        attempts,
        delay_ms: delayMs,
        reason: classification.reason,
        status_code: classification.statusCode,
        message: classification.message,
      });
      options.onRetry?.({ attempt, attempts, delayMs, classification });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws on its final attempt.
  throw new Error('retryTransportFaults exited without a result.');
}
