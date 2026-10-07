/**
 * B0-1014 — run-level "did the model provider refuse this run?" reducer.
 *
 * Why this exists: on 2026-09-14 at ~19:25 UTC the Betco OpenAI organization ran out of credits.
 * Every eval item after that threw `You have no credits remaining…`, and the harness recorded each
 * one as `passed: false` — byte-for-byte indistinguishable from the agent answering badly. The
 * 2026-09-15 00:00 UTC golden sweep then showed 0/106 across all five golden sets and computed a
 * letter grade from it. Nothing on screen said the provider had refused every request.
 *
 * Sibling of `run-health.ts` (B0-911), not a replacement: that one catches a run whose ROUTING
 * degraded but which still produced answers; this one catches a run that produced no answers at
 * all. Both banners can render on the same run.
 *
 * Pure reducer, no I/O — the per-item `provider_fault` column is read by `repository.ts`
 * (`listRoutingHealthRowsByResultId`) or reduced straight from rows already in memory, and the
 * rendering lives in `~/components/admin/tests/ProviderFaultBanner.tsx`. Percentages are formatted
 * by `formatRunHealthPercent` from `run-health.ts` — one formatter for both banners, so the two
 * never disagree about how a rate is written.
 */

/**
 * 5% or more of the run's items carrying a provider fault → the run's pass rate is not a quality
 * measurement. Deliberately the same number as `DEGRADED_FALLBACK_RATE_THRESHOLD` in
 * `run-health.ts`, and for the same reason: one transient 429 on a 100-case run is noise, while 5%
 * of a 106-case run is 6 items, which is a pattern. Keeping the two thresholds identical also means
 * an operator only has to learn one number for "how much instrumentation damage is too much".
 *
 * Note the boundary differs from B0-911 on purpose: this rule trips at `>=` the threshold, because
 * a provider refusal is a hard zero for that item — there is no partial answer to grade — whereas a
 * keyword-router fallback still produced an answer worth counting.
 */
export const PROVIDER_FAULT_INVALID_RATE_THRESHOLD = 0.05;

/** The one per-item column this reducer reads. Structural, so tests need no DB row shape. */
export type RunProviderFaultInput = {
  /**
   * `test_result_items.provider_fault`; null = the provider answered this item. Unlike the nulls
   * in `run-health.ts` — where null means "this row predates the instrumentation", i.e. missing
   * information — a null here is real information, so EVERY item in the run is in the denominator.
   * Excluding nulls would make a one-faulted-item run read as 100% faulted.
   */
  providerFault: string | null;
};

/** One distinct fault kind and how many items hit it, most frequent first. */
export type RunProviderFaultKindCount = {
  kind: string;
  count: number;
};

export type RunProviderHealth = {
  /** Every row considered — the denominator for `faultRate`. */
  totalItems: number;
  /** Rows carrying a non-empty `provider_fault`. */
  faultedItems: number;
  /** `faultedItems / totalItems`, or null when the run has no items at all. */
  faultRate: number | null;
  /** True when `faultRate` is at or above `PROVIDER_FAULT_INVALID_RATE_THRESHOLD`. */
  invalid: boolean;
  /** Distinct kinds, most frequent first; ties broken alphabetically for a stable render. */
  kinds: RunProviderFaultKindCount[];
  /** The most common fault kind, or null when no item recorded one. */
  topKind: string | null;
};

const CLEAN: RunProviderHealth = {
  totalItems: 0,
  faultedItems: 0,
  faultRate: null,
  invalid: false,
  kinds: [],
  topKind: null,
};

/**
 * Reduces one run's per-item provider faults to a "this pass rate measured nothing" verdict.
 *
 * A run with zero items is NOT invalid — there is nothing to say about a provider that was never
 * called. Fault strings are counted verbatim and are NOT filtered against `PROVIDER_FAULT_KINDS`:
 * the column is free text, so a value this reducer does not recognize is still a provider refusal
 * and still has to be counted. Recognition is a rendering concern (`isProviderFaultKind`).
 */
export function computeRunProviderHealth(
  items: readonly RunProviderFaultInput[],
): RunProviderHealth {
  if (items.length === 0) {
    return CLEAN;
  }

  const kindCounts = new Map<string, number>();
  let faultedItems = 0;

  for (const item of items) {
    const kind = item.providerFault?.trim();
    if (!kind) {
      continue;
    }
    faultedItems += 1;
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }

  const kinds: RunProviderFaultKindCount[] = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  const faultRate = faultedItems / items.length;

  return {
    totalItems: items.length,
    faultedItems,
    faultRate,
    invalid: faultRate >= PROVIDER_FAULT_INVALID_RATE_THRESHOLD,
    kinds,
    topKind: kinds[0]?.kind ?? null,
  };
}
