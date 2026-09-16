import { z } from 'zod';

import { classifyTransportError, isUpstreamTransportError } from '~/lib/openai/transport-retry';

/**
 * B0-1014 — tell an INFRASTRUCTURE refusal apart from a bad answer.
 *
 * On 2026-09-14 ~19:25 UTC the Betco OpenAI organization ran out of credits. Every eval item after
 * that threw `You have no credits remaining…`; `runSingleTurnTestItem` stamped it as
 * `status: 'failed', passed: false` exactly like a wrong answer, so the 2026-09-15 00:00 UTC golden
 * sweep recorded 0/106 across all five golden sets and a letter grade was computed off it.
 *
 * This module is the one place that decides "the provider refused us" and it is deliberately pure:
 * no I/O, no DB, no logger, so the runner, the per-run reducer and the run-health surfaces all read
 * the same verdict from the same function.
 *
 * Conservative by construction. A wrong answer, a Zod failure, a tool error and an empty response
 * MUST classify as `null`: mislabelling a quality failure as an outage would hide a real regression,
 * which is a worse bug than the one this fixes.
 */

export const PROVIDER_FAULT_KINDS = [
  'insufficient_quota',
  'invalid_credentials',
  'rate_limited',
  'provider_unavailable',
] as const;

export const providerFaultKindSchema = z.enum(PROVIDER_FAULT_KINDS);

export type ProviderFaultKind = (typeof PROVIDER_FAULT_KINDS)[number];

export function isProviderFaultKind(value: string): value is ProviderFaultKind {
  return (PROVIDER_FAULT_KINDS as readonly string[]).includes(value);
}

/** Human wording for admin surfaces. Kept here so every renderer says the same thing. */
export const PROVIDER_FAULT_LABEL: Record<ProviderFaultKind, string> = {
  insufficient_quota: 'Out of credits / quota exhausted',
  invalid_credentials: 'Invalid API credentials',
  rate_limited: 'Rate limited by the provider',
  provider_unavailable: 'Provider unavailable',
};

/**
 * How many CONSECUTIVE provider-faulted items end a run. Three is well past any single transient
 * blip (the retry policy in `~/lib/openai/transport-retry` has already burned its attempts on each
 * one) and stops the remaining items from being attempted — and billed — once the provider has
 * shown it will refuse every request in the run.
 */
export const PROVIDER_FAULT_ABORT_STREAK = 3;

/**
 * Structural quota signals, checked BEFORE any wording. Probed live from the still-active outage on
 * 2026-09-15: OpenAI answers `429` with
 * `{"error":{"type":"insufficient_quota","code":"credit_balance_exhausted", …}}`, and the SDK
 * surfaces `type`/`code` on the thrown error. A machine-readable code outlives the prose around it,
 * which is the same precedent `classifyTransportError` sets with its own structural pass.
 */
const INSUFFICIENT_QUOTA_CODES = new Set([
  'credit_balance_exhausted',
  'insufficient_quota',
]);

type ProviderErrorLike = {
  type?: unknown;
  code?: unknown;
  cause?: unknown;
  error?: unknown;
};

function asProviderErrorLike(value: unknown): ProviderErrorLike {
  return typeof value === 'object' && value !== null ? (value as ProviderErrorLike) : {};
}

/**
 * Walks both `cause` (how `UpstreamTransportError` and undici nest) and `error` (how the OpenAI SDK
 * hangs the parsed response body off the thrown error), so a code buried one level down still reads.
 */
function collectProviderErrorChain(error: unknown, maxDepth = 4): unknown[] {
  const chain: unknown[] = [];
  const queue: unknown[] = [error];

  while (queue.length > 0 && chain.length < maxDepth) {
    const current = queue.shift();
    if (current == null || chain.includes(current)) continue;
    chain.push(current);
    const candidate = asProviderErrorLike(current);
    queue.push(candidate.cause, candidate.error);
  }

  return chain;
}

function hasInsufficientQuotaCode(error: unknown): boolean {
  return collectProviderErrorChain(error).some((link) => {
    const candidate = asProviderErrorLike(link);
    return [candidate.type, candidate.code].some(
      (value) => typeof value === 'string' && INSUFFICIENT_QUOTA_CODES.has(value),
    );
  });
}

/** Quota/credit exhaustion — the 2026-09-14 incident's own wording, plus the OpenAI error code. */
const INSUFFICIENT_QUOTA_FRAGMENTS = [
  'no credits remaining',
  'insufficient_quota',
  'insufficient quota',
  'exceeded your current quota',
];

const INVALID_CREDENTIALS_FRAGMENTS = ['invalid api key', 'incorrect api key', 'unauthorized'];

const PROVIDER_UNAVAILABLE_FRAGMENTS = ['overloaded', 'service unavailable', 'bad gateway'];

function includesAll(haystack: string, needles: string[]): boolean {
  return needles.every((needle) => haystack.includes(needle));
}

/**
 * Wording-only pass, for faults that arrive as a bare `Error` with no HTTP status — which is the
 * path the 2026-09-14 incident actually took, so this half is not a nicety.
 */
function classifyByWording(message: string): ProviderFaultKind | null {
  const text = message.toLowerCase();

  if (
    INSUFFICIENT_QUOTA_FRAGMENTS.some((fragment) => text.includes(fragment)) ||
    includesAll(text, ['billing', 'credits'])
  ) {
    return 'insufficient_quota';
  }

  if (
    INVALID_CREDENTIALS_FRAGMENTS.some((fragment) => text.includes(fragment)) ||
    includesAll(text, ['authentication', 'failed'])
  ) {
    return 'invalid_credentials';
  }

  if (text.includes('rate limit')) {
    return 'rate_limited';
  }

  if (PROVIDER_UNAVAILABLE_FRAGMENTS.some((fragment) => text.includes(fragment))) {
    return 'provider_unavailable';
  }

  return null;
}

function classifyFromStatusAndMessage(
  statusCode: number | undefined,
  message: string,
): ProviderFaultKind | null {
  // HTTP status wins over wording: a 401 is a credentials fault whatever its body says.
  if (statusCode === 401 || statusCode === 403) {
    return 'invalid_credentials';
  }

  if (statusCode === 429) {
    // A 429 is the shape OpenAI uses for BOTH "too fast" and "out of money"; only the body
    // separates them, and the difference decides whether waiting would have helped.
    const text = message.toLowerCase();
    const quotaish =
      text.includes('quota') ||
      text.includes('credit') ||
      text.includes('billing') ||
      text.includes('exceeded your current');
    return quotaish ? 'insufficient_quota' : 'rate_limited';
  }

  if (typeof statusCode === 'number' && statusCode >= 500) {
    return 'provider_unavailable';
  }

  return classifyByWording(message);
}

/**
 * The provider-fault verdict for a thrown value, or `null` when the failure is ours (a wrong
 * answer, a validation error, a tool failure) rather than the provider's.
 */
export function classifyProviderFault(error: unknown): ProviderFaultKind | null {
  // Structural first: an `insufficient_quota` / `credit_balance_exhausted` code is unambiguous and
  // survives both the retry wrapper and any rewording of the provider's prose.
  if (hasInsufficientQuotaCode(error)) {
    return 'insufficient_quota';
  }

  /**
   * An exhausted transport fault replaces `message` with `UPSTREAM_RETRY_USER_MESSAGE`, so the
   * wrapper's own `rawMessage`/`statusCode` are the only usable evidence — reading `message` here
   * would classify every wrapped fault as `null`.
   *
   * The wrapper is NOT always present: a 429 is retryable, so `retryTransportFaults` should have
   * wrapped the 2026-09-14 faults, yet all 58 affected `test_result_items` rows stored the raw
   * provider text — some eval call path reaches the provider outside the retry boundary. Chasing
   * that is out of scope here; it is why the wording fallback below must handle a bare, unwrapped
   * provider message and must never assume the wrapper ran.
   */
  if (isUpstreamTransportError(error)) {
    return classifyFromStatusAndMessage(error.statusCode, error.rawMessage);
  }

  const { statusCode, message } = classifyTransportError(error);
  return classifyFromStatusAndMessage(statusCode, message);
}
