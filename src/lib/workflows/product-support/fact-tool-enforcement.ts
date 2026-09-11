import {
  evaluateRegulatedClaimGrounding,
  type RegulatedClaimCategory,
} from '~/lib/workflows/product-support/validator';

/**
 * B0-948 — the mandatory-retrieval rule in the product-support system prompt is COUNT-driven
 * ("call at least one retrieval tool before answering"), so the first `search_product_docs` call
 * satisfies it and nothing downstream re-checks. Measured on golden run
 * `61e80e45-80fb-4207-a299-36c60cd62e6a`: eight of the nine failing items made ONE generic semantic
 * search and answered, and in every one of them the fact the golden demanded lived behind a tool
 * that was never invoked — the substrate list behind `list_allowed_surfaces`, the contact time
 * behind `get_efficacy_data`, the SDS citation behind `get_safety_constraints`, the registration
 * behind `get_product_spec`. The regulated-claim guardrail then penalised exactly the claims whose
 * evidence was never fetched, so under-fan-out surfaced as a redaction or a missed concept.
 *
 * This module makes the requirement FACT-CATEGORY driven instead: given a finished draft and the
 * tools actually called this turn, it names the ONE tool that owns a fact category the draft
 * asserts but never looked up. The generation runtimes force that single call and re-draft (see
 * `requireFactTool` in `~/lib/openai/responses-runtime` and `~/lib/bex/ai-sdk-runtime`).
 *
 * Deliberately NOT a prompt change: "call the right tool" has been prompt guidance since B0-352 and
 * the model reliably skips it — the same finding B0-788 and B0-889 recorded for their question
 * shapes, and the same remedy (a deterministic check plus a `tool_choice` pin).
 *
 * Nothing here reads, restates, converts or re-derives a regulated VALUE. It only asks which
 * category of claim the draft makes and which tool owns that category.
 */

/** One fact category and the tool(s) that own it. */
export type FactToolRequirement = {
  /** The regulated-claim category, as `evaluateRegulatedClaimGrounding` classifies it. */
  category: RegulatedClaimCategory | 'storage_shelf_life';
  /**
   * Tools that own this fact. ANY of them having been called satisfies the requirement; the FIRST
   * one is the tool that gets forced when none were.
   */
  tools: readonly string[];
};

/**
 * B0-948 — the mapping, in the order it is evaluated. The first unsatisfied entry is the one
 * forced, so at most one extra call is ever demanded per turn.
 *
 * `search_product_docs` is deliberately absent from every `tools` list: it is the generic semantic
 * search whose over-use is the bug, so it can never satisfy a requirement.
 */
export const FACT_TOOL_REQUIREMENTS: readonly FactToolRequirement[] = [
  // Exact numbers from the typed fact columns, never a paraphrase of retrieved prose (B0-788).
  { category: 'efficacy_claim', tools: ['get_efficacy_data'] },
  { category: 'contact_time', tools: ['get_efficacy_data'] },
  { category: 'dilution_ratio', tools: ['get_efficacy_data'] },
  // Approved surfaces / substrates / materials.
  { category: 'compatibility', tools: ['list_allowed_surfaces', 'get_compatibility_rules'] },
  // PPE, hazards, precautions, first aid — the SDS-oriented tool.
  { category: 'hazard', tools: ['get_safety_constraints'] },
  { category: 'first_aid', tools: ['get_safety_constraints'] },
  { category: 'storage_shelf_life', tools: ['get_safety_constraints'] },
  // Registration numbers. `get_efficacy_data` also reads the EPA column, so it satisfies these too.
  { category: 'epa_registration', tools: ['get_product_spec', 'get_efficacy_data'] },
  { category: 'din_registration', tools: ['get_product_spec', 'get_efficacy_data'] },
];

/**
 * B0-948 — storage / shelf-life claims, the one category in the ticket's mapping table that
 * `evaluateRegulatedClaimGrounding` does not classify (it has no `storage_shelf_life` category).
 *
 * Kept deliberately narrow: a shelf-life or storage-condition ASSERTION needs both the topic word
 * and a concrete qualifier (a duration, a temperature, or an explicit storage instruction), so a
 * passing mention of the word "storage" in prose does not force a tool call. Golden run row 18
 * ("shelf life") is the case this exists for — the golden demanded an SDS citation and
 * `get_safety_constraints` was never called.
 */
const STORAGE_SHELF_LIFE_PATTERN =
  /\b(shelf[-\s]?life|storage\s+(?:temperature|conditions?|requirements?)|store\s+(?:at|between|in\s+a))\b/i;

/** B0-948 — does the draft make a storage / shelf-life claim? See the pattern's doc comment. */
export function hasStorageShelfLifeClaim(draftAnswer: string): boolean {
  return STORAGE_SHELF_LIFE_PATTERN.test(draftAnswer);
}

/**
 * B0-948 — the fact categories a finished draft asserts.
 *
 * Reuses `evaluateRegulatedClaimGrounding` with NO sources: with an empty source list the grounding
 * half of that function is a no-op and `categoriesDetected` is exactly its claim-category detector —
 * the same classifier the regulated-claim guardrail runs, so enforcement and the guardrail can never
 * disagree about what the draft claims. Plus the one supplementary category above.
 */
export function detectDraftFactCategories(
  draftAnswer: string,
): Array<RegulatedClaimCategory | 'storage_shelf_life'> {
  const detected: Array<RegulatedClaimCategory | 'storage_shelf_life'> = [
    ...evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] }).categoriesDetected,
  ];
  if (hasStorageShelfLifeClaim(draftAnswer)) {
    detected.push('storage_shelf_life');
  }
  return detected;
}

/**
 * B0-948 — the model-visible instruction sent with the forced call. ONE string, used by both
 * generation runtimes, so an A/B between them compares models and not wording.
 *
 * It states what is missing and what to do with the result, and repeats the transcription rule:
 * the whole point of forcing the call is that the answer's numbers come from the fact tables rather
 * than from prose the model paraphrased.
 */
export function buildFactToolEnforcementInstruction(input: {
  toolName: string;
  category: string;
}): string {
  return (
    `Your draft answer makes a ${input.category.replace(/_/g, ' ')} claim, but \`${input.toolName}\` ` +
    'was not called this turn, so that claim is not backed by the tool that owns it. ' +
    `Call \`${input.toolName}\` now for the product the question is about, then rewrite your answer ` +
    'using what it returns. Transcribe every dilution ratio, oz/gal, mL/L, ppm, percentage, contact ' +
    'time, EPA or DIN registration number, CAS number and log-reduction value exactly as the tool ' +
    'returns it — never rounded, converted or inferred. If the tool returns nothing for this ' +
    'product, keep your answer as it is and say plainly that the value is not on file.'
  );
}

/** B0-948 — what `requireFactTool` returns; mirrors the runtimes' `FactToolRequirementCheck`. */
export type FactToolRequirementDecision = {
  toolName: string;
  instruction: string;
  /** The claim category that demanded the call — recorded on the gate, not sent to the model. */
  category: string;
};

/**
 * B0-948 — the check both generation runtimes call once, on the model's first finished draft.
 *
 * Returns the single tool that must be called before the draft may stand, or null when every fact
 * category the draft asserts was already looked up (and when it asserts none at all). The runtimes
 * own the remaining guards — the tool must actually be offered this turn, retrieval must not have
 * been withdrawn, and the forcing happens at most once per turn.
 */
export function requireFactToolForDraft(input: {
  draftAnswer: string;
  toolNames: readonly string[];
}): FactToolRequirementDecision | null {
  const draft = input.draftAnswer.trim();
  if (!draft) {
    return null;
  }

  const detected = new Set<string>(detectDraftFactCategories(draft));
  if (detected.size === 0) {
    return null;
  }

  const called = new Set(input.toolNames);
  for (const requirement of FACT_TOOL_REQUIREMENTS) {
    if (!detected.has(requirement.category)) continue;
    if (requirement.tools.some((name) => called.has(name))) continue;
    const toolName = requirement.tools[0]!;
    return {
      toolName,
      category: requirement.category,
      instruction: buildFactToolEnforcementInstruction({
        toolName,
        category: requirement.category,
      }),
    };
  }

  return null;
}
