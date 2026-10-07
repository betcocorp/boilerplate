/**
 * B0-530 — single source of truth for the confidence-gate thresholds that specialist system prompts
 * state in prose.
 *
 * These are prompt-authoring constants, not runtime gates: each specialist prompt interpolates the
 * clause below instead of hardcoding a bold literal, so the numbers are declared once. The rendered
 * text is byte-identical to the hand-written prose it replaced, which keeps the SHA-256 prompt
 * stamps in `~/lib/workflows/product-support/prompt-version` unchanged.
 *
 * `cross_reference` is deliberately absent: its gate is qualitative ("cannot determine the
 * competitor's chemistry class", "no same-chemistry Betco product is found") with its own canonical
 * decline copy, and it states no numeric threshold to centralize. Adding a number here would invent
 * a policy that prompt does not have.
 */

/** Prompt ids whose policy text states a numeric confidence threshold. */
export const CONFIDENCE_GATED_PROMPT_IDS = [
  'bathroom',
  'dilution',
  // B0-746 — the former single `floor` id was split into four substrate specialists. All four
  // keep the same 0.9 threshold the flat `floor` prompt used: nothing in the split changed the
  // basis for that number (no substrate has its own calibration data yet), so a uniform value is
  // the honest default rather than inventing per-substrate numbers.
  'floor_wood_sport',
  'floor_concrete',
  'floor_stg',
  'floor_vct',
  'product',
  'recommendations',
] as const;

export type ConfidenceGatedPromptId = (typeof CONFIDENCE_GATED_PROMPT_IDS)[number];

/**
 * The threshold each specialist gates on, on the 0–1 scale its prompt instructs the model to score
 * against. Values are the ones those prompts have always carried — changing one here changes what
 * the model is told, so treat an edit as a policy change, not a refactor.
 */
export const SME_CONFIDENCE_THRESHOLDS: Record<ConfidenceGatedPromptId, number> = {
  bathroom: 0.8,
  dilution: 0.9,
  floor_wood_sport: 0.9,
  floor_concrete: 0.9,
  floor_stg: 0.9,
  floor_vct: 0.9,
  product: 0.9,
  recommendations: 0.8,
};

export function confidenceThreshold(id: ConfidenceGatedPromptId): number {
  return SME_CONFIDENCE_THRESHOLDS[id];
}

/**
 * The threshold as the prompts render it: bolded markdown, no trailing-zero padding (`**0.8**`,
 * not `**0.80**`), so a value like `0.85` would render faithfully rather than being rounded.
 */
export function formatConfidenceThreshold(id: ConfidenceGatedPromptId): string {
  return `**${String(confidenceThreshold(id))}**`;
}

/**
 * The clause every gated prompt shares, up to (but not including) its own consequent. Each prompt
 * supplies the rest of its sentence, because the consequences differ per specialist (escalate,
 * decline verbatim, withhold guarantees).
 */
export function confidenceGateClause(
  id: ConfidenceGatedPromptId,
  options?: { lead?: 'If' | 'When' },
): string {
  return `${options?.lead ?? 'If'} confidence is below ${formatConfidenceThreshold(id)}`;
}
