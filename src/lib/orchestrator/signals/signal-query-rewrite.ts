import type { TurnSignals } from '~/lib/orchestrator/signals/signals-schemas';

/**
 * B0-738 — deterministic query augmentation built from an already-extracted, already-persisted
 * `TurnSignals` (B0-786). This is NOT the `rewriteQueryWithLlm` mechanism in `~/lib/rag/search.ts`
 * (a separate LLM call over the raw query string for BM25/hybrid lexeme text) — no model call runs
 * here, and this module must never call one. It exists because the model's own `search_product_docs`
 * query terms can miss context the signals call already resolved (e.g. a user asks "what do you use
 * on wood floors" — `surfaceType` carries "wood floor" and `productCategory` may carry "floor finish"
 * even when the model's own query is just the bare task).
 *
 * Order is deliberate: `carriedProduct` (an explicitly named product from earlier in the
 * conversation) is the strongest anchor, then `productCategory`, then `surfaceType`, then
 * `taskDescription` — narrowest-identity-first, broadest-context-last.
 */
export function buildSignalQueryRewrite(signals: TurnSignals): string | null {
  const candidates = [
    signals.carriedProduct,
    signals.productCategory,
    signals.surfaceType,
    signals.taskDescription,
  ];

  const seen = new Set<string>();
  const parts: string[] = [];

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    parts.push(trimmed);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}
