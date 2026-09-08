import { CROSS_REFERENCE_CLAIMS_NON_TRANSFER_STATEMENT } from '~/lib/agents/cross-reference-specialist/cross-reference-specialist-system-prompt';

/**
 * B0-875 — question-aware decline copy for the cross-reference path.
 *
 * Until this ticket every cross-reference decline reason — engine below threshold, competitor
 * identity unresolved, chemistry named instead of a product — surfaced the SAME fixed sentence
 * (`XREF_DECLINE_COPY`). The golden set expects three different replies for three different
 * shapes, none of which the fixed copy can give:
 *
 *  (a) no competitor identified → ask for the brand and exact product name, and say what a
 *      cross-reference actually finds (comparable products for the same application, never an
 *      "identical" one);
 *  (b) a claim-equivalence question ("kills everything X does, right?") → lead with the
 *      regulatory non-transfer statement and point to the Betco label, THEN the engine's decline;
 *  (c) a chemistry class offered in place of a product ("a Diversey quat disinfectant") → ask
 *      which product (label name + EPA registration number) and why it matters;
 *  (d) a resolved competitor the engine simply could not match → the sales-rep copy, unchanged.
 *
 * Pure text builders. Nothing here reads regulated data; the only regulatory statement is the
 * shared `CROSS_REFERENCE_CLAIMS_NON_TRANSFER_STATEMENT`, embedded verbatim. Every sentence was
 * checked against the regulated-claim guardrail's efficacy rule (`isEfficacyClaimSentence`): no
 * sentence pairs an efficacy verb with an organism noun, and none carries a numeric regulated
 * token, so the guardrail never mistakes Bex's own clarification for an ungrounded claim.
 */

/**
 * "Kills everything X does", "same kill claims", "same organisms", "kill claims transfer",
 * "log reduction" — the user is asking whether efficacy/organism claims carry across.
 */
const CLAIM_EQUIVALENCE_PATTERNS: readonly RegExp[] = [
  /\bkills?\b[^.?!]{0,60}\b(everything|the same|all (?:of )?the same|whatever)\b/i,
  /\b(same|identical|equivalent|matching|equal)\b[^.?!]{0,30}\b(kill|efficacy|organism|pathogen|microb\w*)\w*\s+claims?\b/i,
  /\b(same|identical|equivalent|matching|equal)\b[^.?!]{0,30}\b(organisms?|pathogens?|kill list|claims?)\b/i,
  /\b(kill|efficacy|organism|pathogen)[\s-]?claims?\b/i,
  /\bclaims?\b[^.?!]{0,30}\b(transfer|carry over|carry across|apply to)\b/i,
  /\blog[\s-]?reduction/i,
];

export function isClaimEquivalenceQuestion(userMessage: string): boolean {
  return CLAIM_EQUIVALENCE_PATTERNS.some((pattern) => pattern.test(userMessage));
}

/** The user literally asked for the "identical" product (P#10 shape). */
export function asksForIdenticalProduct(userMessage: string): boolean {
  return /\bidentical\b/i.test(userMessage);
}

/**
 * (a) — no competitor brand and no confidently-extracted product name. Asks for both, and explains
 * what a cross-reference finds. The "not chemically identical" clause is added only when the user
 * used the word, mirroring the specialist prompt's own instruction for that case.
 */
export function buildCompetitorIdentityClarification(input: { userMessage: string }): string {
  const scope = asksForIdenticalProduct(input.userMessage)
    ? "Betco's cross-reference identifies comparable products for the same application, not chemically identical ones."
    : "Betco's cross-reference identifies comparable products for the same application.";
  return [
    "To look up a Betco cross-reference I need the competitor product's brand and the exact product name as printed on its label — the EPA registration number, if the label shows one, helps too.",
    scope,
    "Reply with the brand and product name and I'll look up the documented match.",
  ].join(' ');
}

/**
 * (c) — a chemistry class ("quat disinfectant", "Diversey quat disinfectant") was offered in place
 * of a product. `described` is the normalised phrase the self-reference check fired on
 * (`CompetitorSelfReferenceVerdict.matched`), quoted back so the user sees what was understood.
 * Deliberately says nothing about any competitor's catalogue beyond "several products can fit".
 */
export function buildGenericChemistryClarification(input: { described: string }): string {
  const described = input.described.trim();
  const lead = described
    ? `"${described}" describes a chemistry class rather than a specific product.`
    : 'That describes a chemistry class rather than a specific product.';
  return [
    lead,
    'Several distinct products can fit that description, and they differ on dilution, contact time and organism claims, so there is no defensible Betco cross-reference without the exact product.',
    "Please share the product name as printed on its label — and its EPA registration number if the label shows one — and I'll look up the documented Betco match.",
  ].join(' ');
}

/**
 * (b)/(d) — wraps the recommendation engine's own decline text (surfaced verbatim, B0-356). For a
 * claim-equivalence question the regulatory non-transfer statement leads, followed by the label
 * pointer, then the engine's decline; for any other question the engine text is returned as-is.
 */
export function buildRecommendationEngineDeclineCopy(input: {
  userMessage: string;
  engineDeclineText: string;
}): string {
  if (!isClaimEquivalenceQuestion(input.userMessage)) {
    return input.engineDeclineText;
  }
  return [
    'Kill claims do not transfer between products.',
    CROSS_REFERENCE_CLAIMS_NON_TRANSFER_STATEMENT,
    'Check every organism you need against that Betco label before substituting.',
  ].join(' ') + `\n\n${input.engineDeclineText}`;
}

/**
 * B0-876 — the web-search backstop's top result for the "competitor" was a betco.com page: the
 * product is Betco's own, so there is no competitor to cross-reference. `label` is the brand +
 * product string the turn resolved; `pageTitle` is the betco.com result's own title, transcribed.
 */
export function buildBetcoSelfReferenceDecline(input: {
  label: string;
  pageTitle: string | null;
}): string {
  const label = input.label.trim() || 'This product';
  const page = input.pageTitle?.trim() ? ` ("${input.pageTitle.trim()}")` : '';
  return `${label} appears to be a Betco product — the top web result for it is a betco.com product page${page} — so there is no competitor product to cross-reference. Ask about it as a Betco product (its label directions, dilution, contact time or registration) and I'll look it up from Betco's own documentation.`;
}
