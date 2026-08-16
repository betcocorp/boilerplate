/**
 * B0-459 — hard backstop on assistant output length, independent of the prompt's own brevity
 * directive (see `PRODUCT_SUPPORT_SHARED_INSTRUCTIONS`). Decode time scales linearly with output
 * tokens and was measured at ~85% of total turn time at the pre-existing ~551-token average answer.
 *
 * Deliberately generous — this is NOT the ~250-token target the prompt asks for on a simple
 * question, it is a ceiling that only a runaway generation should ever hit, so a legitimate
 * multi-section answer (full maintenance program, stripping/finishing procedure) is never cut off
 * mid-sentence or, worse, mid regulated-value. Configurable via `BEX_MAX_OUTPUT_TOKENS` without a
 * redeploy; falls back to the default on anything that is not a positive finite number.
 *
 * B0-553 — extracted out of `run-product-support-workflow.ts` so `validator.ts` (which that file
 * imports) can share the same cap on its own model calls without an import cycle.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1200;

export function resolveMaxOutputTokens(): number {
  const raw = process.env.BEX_MAX_OUTPUT_TOKENS;
  if (!raw) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_OUTPUT_TOKENS;
}
