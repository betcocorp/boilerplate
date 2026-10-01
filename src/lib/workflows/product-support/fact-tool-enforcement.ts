import { getBooleanSetting } from '~/lib/settings/settings-service';
import { detectCategorySearchTerms } from '~/lib/tools/category-search-terms';
import { looksLikeCategoryListOrSuperlativeAsk } from '~/lib/workflows/product-support/speculative-retrieval';
import {
  evaluateRegulatedClaimGrounding,
  type RegulatedClaimCategory,
} from '~/lib/workflows/product-support/validator';

/**
 * B0-984 — settings-table switch for the whole enforcement step (default ON in code; the seed row
 * ships OFF). Golden runs on 2026-09-13/14 showed the forced re-draft rewriting finished answers
 * against empty or wrong tool results — enforced items failed roughly 4× as often as non-enforced
 * ones — so the step is held behind a lever while the additive re-draft below is validated.
 * Off restores the pre-B0-948 behaviour exactly: neither runtime receives `requireFactTool`.
 */
export const FACT_TOOL_ENFORCEMENT_SETTING_KEY = 'BEX_FACT_TOOL_ENFORCEMENT_ENABLED';

export async function isFactToolEnforcementEnabled(): Promise<boolean> {
  return getBooleanSetting(FACT_TOOL_ENFORCEMENT_SETTING_KEY, true);
}

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
  /**
   * B0-972 — present for a list / superlative / organism-first ask: the model must call the BATCH
   * form of `get_efficacy_data` (`{ category, organism }`), not the single-product form, because
   * there is no one product the question is about.
   */
  batch?: BatchFactAsk;
}): string {
  if (input.batch) {
    const args = [
      `category: ${JSON.stringify(input.batch.category ?? 'disinfectant')}`,
      ...(input.batch.organism ? [`organism: ${JSON.stringify(input.batch.organism)}`] : []),
    ].join(', ');
    return (
      'Your draft answers a category-list, best/strongest, or organism-first question by naming products ' +
      `without each product's own labeled value, and \`${input.toolName}\` was not called this turn, so no ` +
      'per-product dilution or contact time in the list is backed by the tool that owns it. Call ' +
      `\`${input.toolName}\` ONCE now in its batch form: \`${input.toolName}({ ${args} })\` — do not call it ` +
      'once per product. Then return your draft answer again with these edits only: for every product the ' +
      "tool returned values for, add that product's labeled dilution and contact time (and EPA or DIN " +
      'registration number when returned) in the line that names it, transcribing every dilution ratio, ' +
      'oz/gal, mL/L, ppm, percentage, contact time, registration number, CAS number and log-reduction ' +
      'value exactly as the tool returns it — never rounded, converted, averaged across products or ' +
      'inferred. For a product the tool returned no value for, say in its line that the labeled value is ' +
      'not on file. Keep every product, the opening sentence, every step and every recommendation of the ' +
      'draft; do not lead with what is not on file.'
    );
  }
  // B0-984 — the forced round is ADDITIVE. The earlier wording ("rewrite your answer using what it
  // returns … say plainly that the value is not on file") made the model lead with a non-finding
  // about an attribute the user never asked about and drop procedure content whenever the tool
  // came back empty or with the wrong product (game-line tape, gym-floor scuffs, dilution-system
  // reconfiguration, HIV-1 product list). The draft the model just wrote is the answer of record;
  // the tool result may only correct or add the specific value the claim needs.
  return (
    `Your draft answer makes a ${input.category.replace(/_/g, ' ')} claim, but \`${input.toolName}\` ` +
    'was not called this turn, so that claim is not backed by the tool that owns it. ' +
    `Call \`${input.toolName}\` now for the product the question is about. Then return your draft ` +
    'answer again with these edits only: if the tool returned values for that product, correct or ' +
    'add the specific value in the sentence that made the claim, transcribing every dilution ratio, ' +
    'oz/gal, mL/L, ppm, percentage, contact time, EPA or DIN registration number, CAS number and ' +
    'log-reduction value exactly as the tool returns it — never rounded, converted or inferred. If ' +
    'the tool returned nothing, or returned a different product than the one the question is about, ' +
    'return the draft unchanged and append one closing sentence noting that the structured value ' +
    'is not on file. Keep the opening sentence, every step and every recommendation of the draft; ' +
    'do not lead with what is not on file.'
  );
}

/**
 * B0-972 — a question whose answer is a LIST of products, each needing its own labeled value:
 * `category_list` ("strongest wood floor stripper", "what should I use for …") or
 * `organism_first` ("which products kill HIV-1?", "best against norovirus"). `category` is the
 * taxonomy token the message names (see `detectCategorySearchTerms`), defaulting to
 * `disinfectant` for an organism ask that names none; `organism` is the pathogen text exactly as
 * the user typed it, or null.
 */
export type BatchFactAsk = {
  kind: 'category_list' | 'organism_first';
  category: string | null;
  organism: string | null;
};

/** The pathogen/claim words an organism-first question names, transcribed from the message as typed. */
const ORGANISM_NAME_PATTERN =
  /\b(norovirus|norwalk(?:\s+virus)?|hiv(?:[\s-]?1)?|human immunodeficiency virus|hepatitis\s*[abc]?|hbv|hcv|mrsa|staph(?:ylococcus)?(?:\s+aureus)?|strep(?:tococcus)?|influenza(?:\s+[ab])?|h1n1|covid(?:[\s-]?19)?|sars[\s-]?cov[\s-]?2|coronavirus|c\.?\s?diff(?:icile)?|clostridi\w+(?:\s+difficile)?|salmonella|e\.?\s?coli|escherichia coli|pseudomonas(?:\s+aeruginosa)?|listeria|tuberculosis|mycobacter\w+|parvo(?:virus)?|calicivirus|rotavirus|adenovirus|rhinovirus|rsv|candida(?:\s+auris)?|aspergillus|trichophyton|athlete'?s foot|legionella|klebsiella|enterococc\w+|vre|acinetobacter|campylobacter|shigella|canine parvovirus|feline calicivirus|mold|mildew)\b/i;

/** Verb/claim phrasing that makes a pathogen mention a kill-claim question rather than a passing word. */
const ORGANISM_CLAIM_PATTERN =
  /\b(kills?|killing|effective against|efficacy against|efficacious against|claims? (?:for|against)|works? (?:best )?against|labeled (?:for|against)|virucid\w*|bactericid\w*|tuberculocid\w*|fungicid\w*|disinfect\w*)\b/i;

/**
 * B0-972 — is this message a list-shaped ask whose products each need a labeled value? Deterministic
 * (keyword checks, no model call), reusing the B0-889 list/superlative matcher for the category
 * half. Null for a single-product or unrelated question.
 */
export function classifyBatchFactAsk(userMessage: string): BatchFactAsk | null {
  const message = userMessage.trim();
  if (!message) return null;
  const organismMatch = ORGANISM_NAME_PATTERN.exec(message);
  const organism = organismMatch ? organismMatch[0] : null;
  const detectedCategory = detectCategorySearchTerms(message)[0] ?? null;

  if (organism && ORGANISM_CLAIM_PATTERN.test(message)) {
    return { kind: 'organism_first', category: detectedCategory ?? 'disinfectant', organism };
  }
  if (looksLikeCategoryListOrSuperlativeAsk(message)) {
    return { kind: 'category_list', category: detectedCategory, organism };
  }
  return null;
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
  /**
   * B0-984 — what the workflow knows about this turn that the draft alone cannot tell. When no
   * Betco product resolved (`productResolved: false`), a `compatibility` claim has no product for
   * `list_allowed_surfaces` to look up: the forced call resolved "3M Game Line Tape" and
   * "dilution control" to unrelated product-line profiles and the re-draft opened with "not on
   * file". The requirement is skipped rather than forced into a meaningless lookup.
   */
  context?: {
    productResolved?: boolean;
    /**
     * B0-972 — the user's message, so a list / superlative / organism-first ask can be recognised
     * and the BATCH `get_efficacy_data({ category, organism })` form demanded. Omitted → the
     * draft-claim check below runs exactly as before.
     */
    userMessage?: string;
  };
}): FactToolRequirementDecision | null {
  const draft = input.draftAnswer.trim();
  if (!draft) {
    return null;
  }

  const productResolved = input.context?.productResolved !== false;
  const called = new Set(input.toolNames);

  /**
   * B0-972 — "a category list with no per-product value" is a missing-fact condition even when the
   * draft asserts nothing detectable: "strongest wood floor stripper" listed five lines with no
   * dilution, and "kill HIV-1" / "best against norovirus" listed products with no contact time, so
   * `detectDraftFactCategories` had nothing to flag and the check below never fired. When the
   * question is list-shaped and no single Betco product resolved, the batch efficacy call is the
   * requirement — checked FIRST so a draft that does happen to state one dilution is not sent the
   * single-product instruction ("for the product the question is about") on a question with no such
   * product.
   */
  const batchAsk =
    !productResolved && input.context?.userMessage
      ? classifyBatchFactAsk(input.context.userMessage)
      : null;
  if (batchAsk && !called.has('get_efficacy_data')) {
    const toolName = 'get_efficacy_data';
    return {
      toolName,
      category: batchAsk.kind === 'organism_first' ? 'organism_first_batch' : 'category_list_batch',
      instruction: buildFactToolEnforcementInstruction({
        toolName,
        category: batchAsk.kind,
        batch: batchAsk,
      }),
    };
  }

  const detected = new Set<string>(detectDraftFactCategories(draft));
  if (detected.size === 0) {
    return null;
  }
  for (const requirement of FACT_TOOL_REQUIREMENTS) {
    if (!detected.has(requirement.category)) continue;
    if (requirement.category === 'compatibility' && !productResolved) continue;
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
