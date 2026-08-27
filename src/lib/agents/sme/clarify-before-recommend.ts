/**
 * B0-728 — shared "clarify before recommend" policy, reused by the `product`, `recommendations`,
 * and `cross_reference` specialist prompts. Same shared-fragment pattern as `confidenceGateClause`
 * in `./confidence-thresholds.ts`: the wording is declared once here and interpolated into each
 * specialist's own prompt text, instead of three independently hand-edited (and driftable) policy
 * blocks.
 *
 * Root cause (eval run 10af6f0c-b84f-4b8f-bec0-105b0e8fdd73, "Top 20 Product Questions", graded
 * D): four items scored badly because a specialist recommended a product before asking an
 * essential clarifying question — the maintenance stage for a floor-care ask, the required
 * organism/pathogen coverage for a disinfectant ask, or the specific competitor product/EPA
 * registration number for a cross-reference ask. This is a shared policy gap spanning three
 * specialists, not one prompt's isolated bug.
 */
/**
 * Renders the clause with the caller's own heading level, so it reads as a native section in each
 * specialist's prompt (`product-specialist-system-prompt.ts` uses `##` sections throughout;
 * `recommendations-specialist-system-prompt.ts` and `cross-reference-specialist-system-prompt.ts`
 * use `#`) instead of forcing one fixed level on all three.
 */
export function clarifyBeforeRecommendClause(heading: '#' | '##' = '##'): string {
  return [
    `${heading} Clarify before recommending (critical)`,
    '',
    "Before you name a product recommendation, check whether the user's message or the conversation history already states the detail that decides which product is right. If that detail is missing, ask ONE focused clarifying question for it FIRST — do not recommend a product in the same turn you ask. Skip the question only when the detail is already given, or when Betco's catalog makes it moot (only one product line applies no matter the answer).",
    '',
    'Missing details that require asking first, before recommending:',
    '- **Maintenance stage / job type** for floor-care requests — daily/routine cleaning, scrub-and-recoat, and strip-and-refinish need different products; "What product should I use on VCT floors?" does not say which one is needed.',
    '- **Required organism/pathogen coverage** for disinfectant requests — not every disinfectant carries every kill claim; "I need a disinfectant for a school" does not say whether coverage against a specific organism (e.g. norovirus, influenza) is required.',
    '- **The specific competitor product or EPA registration number** for a competitor-replacement request — a brand or category alone (e.g. "a Diversey quat disinfectant") is not enough to pick a true equivalent, since a competitor typically sells several distinct products in that category with different properties.',
  ].join('\n');
}
