/**
 * B0-728 — shared "clarify before recommend" policy, reused by the `product`, `recommendations`,
 * `cross_reference` and (B0-734) `floor` specialist prompts. Same shared-fragment pattern as
 * `confidenceGateClause` in `./confidence-thresholds.ts`: the wording is declared once here and
 * interpolated into each specialist's own prompt text, instead of four independently hand-edited
 * (and driftable) policy blocks.
 *
 * Root cause (eval run 10af6f0c-b84f-4b8f-bec0-105b0e8fdd73, "Top 20 Product Questions", graded
 * D): four items scored badly because a specialist recommended a product before asking an
 * essential clarifying question — the maintenance stage for a floor-care ask, the required
 * organism/pathogen coverage for a disinfectant ask, or the specific competitor product/EPA
 * registration number for a cross-reference ask.
 *
 * B0-734 narrowed the clause to exactly the slots the golden datasets ask about. Across 199 Product
 * Golden and 150 VCT Golden ideal answers, only ~5% ask a clarifying question, and every one of
 * those is missing one of: the product's identity, the floor maintenance step, or the organism
 * requirement. Nothing else (surface, soil, application method, facility type) is ever asked for
 * when the product is named — asking anyway reads as not having read the message (B0-559/B0-660).
 */
/**
 * Renders the clause with the caller's own heading level, so it reads as a native section in each
 * specialist's prompt (`product-specialist-system-prompt.ts` uses `##` sections throughout; the
 * others use `#`) instead of forcing one fixed level on all of them.
 */
export function clarifyBeforeRecommendClause(heading: '#' | '##' = '##'): string {
  return [
    `${heading} Clarify before recommending (critical)`,
    '',
    "Before you name a product or state a regulated value, check whether the user's message or the conversation history already gives the ONE detail that decides the answer. If it is missing, ask for it FIRST — one focused question, not a checklist — and do not recommend a product or give a dilution, contact time, or claim in the same turn. Where it helps, list the labeled options the answer will be chosen from alongside the question. Skip the question when the detail is already given, or when Betco's catalog makes it moot (only one product line applies no matter the answer).",
    '',
    'Exactly three details justify asking first:',
    '- **The product\'s identity** — the product name or item number (for a competitor-replacement request: the specific competitor product name or its EPA registration number). "It", "this product", a product LINE (Symplicity, the pH7Q family, Speedex vs. Speedex Concentrate), an unreadable label, or a brand or category alone ("a Diversey quat disinfectant") is not an identification: several distinct products with different labels sit behind each.',
    '- **The floor maintenance step** for a floor-care product ask — daily/routine cleaning, scrub-and-recoat, and strip-and-refinish need different products; "What product should I use on VCT floors?" does not say which one is needed.',
    '- **The required organism coverage** for a disinfectant ask — not every disinfectant carries every kill claim; "I need a disinfectant for a school" does not say whether a specific organism (e.g. norovirus, influenza) must be covered, or whether general daily disinfection is the job.',
    '',
    'Nothing else triggers a clarifying question. Do not ask for surface, soil type, application method, or facility type when the product is identified; do not ask for a surface the user already named; answer, and put any remaining branch in the caveat line ("confirm the substrate is listed on the label").',
  ].join('\n');
}
