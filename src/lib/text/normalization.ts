/**
 * B0-39 — shared string normalization + tokenization for lookup/matching.
 *
 * Extracted verbatim from `cross-reference-lookup.ts` so the competitor cross-reference and the
 * category resolver/linker apply identical rules. Do NOT diverge these — both consumers depend on
 * the exact behavior. (Distinct from `normalizeForDedupe` in `lib/utils`, which only collapses
 * whitespace + lowercases and is used for a different, punctuation-preserving purpose.)
 */

export function normalizeLookupValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/#/g, ' number ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeLookupValue(value: string): string[] {
  const normalized = normalizeLookupValue(value);
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}
