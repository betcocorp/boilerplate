import type { RegulatedClaimCategory } from '~/lib/workflows/product-support/validator';

/**
 * B0-928 — the app-authored copy the regulated-claim guardrail (B0-829 / B0-871) writes into an
 * answer when it redacts or declines, in ONE place.
 *
 * Two consumers need the exact same spelling and must not pull the workflow stack in with it:
 * `run-product-support-workflow.ts` (which emits it) and `~/lib/tests/grading.ts` (which has to
 * remove it again before deciding whether a turn declined — RC3: the harness was reading the
 * guardrail's own transparency copy as the model refusing to answer, and failing two Product
 * Specialist rows whose answers were substantively complete). Nothing here imports at runtime; the
 * category union is a type-only import.
 */

/** Reviewer-facing labels for the regulated categories `evaluateRegulatedClaimGrounding` detects. */
export const REGULATED_CLAIM_CATEGORY_LABELS: Record<RegulatedClaimCategory, string> = {
  epa_registration: 'EPA registration number',
  din_registration: 'DIN registration number',
  dilution_ratio: 'dilution ratio',
  contact_time: 'contact/dwell time',
  cas_number: 'CAS number',
  hazard: 'hazard statement',
  first_aid: 'first-aid instruction',
  compatibility: 'compatibility statement',
  efficacy_claim: 'efficacy claim',
};

/** B0-829 — the literal an ungrounded token-shaped value (EPA number, ratio, time) is blanked with. */
export const REGULATED_CLAIM_UNVERIFIED_TOKEN_MARKER = '(unable to verify)';

/** B0-871 — the literal marker one withheld sentence is replaced with. Never paraphrases the sentence. */
export function regulatedClaimWithheldMarker(category: RegulatedClaimCategory): string {
  return `[one ${REGULATED_CLAIM_CATEGORY_LABELS[category]} withheld — not verifiable against a retrieved label]`;
}

/**
 * B0-871 — what must be left of the draft, after every withheld sentence and marker is removed,
 * for the redaction to be worth showing instead of the full decline. Letters and digits only count:
 * a remainder of markdown scaffolding or bullets is not "substantive content". Also reused by the
 * grader (B0-928) as the bar a stripped/remainder text must clear to count as an answer.
 */
export const REGULATED_CLAIM_REDACTION_MIN_REMAINING_CHARS = 120;

/** Letters and digits only — the one notion of "substantive content" shared by the guardrail and the grader. */
export function countSubstantiveContentChars(text: string): number {
  return text.replace(/[^A-Za-z0-9]/g, '').length;
}

/** How the token-redaction footer describes what the reader will see in place of the value. */
const TOKEN_REDACTION_MARKING = `"${REGULATED_CLAIM_UNVERIFIED_TOKEN_MARKER}"`;
/** How the sentence-redaction footer describes it (B0-871 replaces a whole sentence, not a token). */
const SENTENCE_REDACTION_MARKING = '"withheld" in brackets';

/** Closing line shared by every redaction footer and by the full decline. */
export const REGULATED_CLAIM_CONSULT_LINE =
  'Please consult the product label or SDS directly for the exact regulated value, or contact Betco Product Support / EHS to confirm.';

function redactionFooter(flagged: string, marking: string): string {
  return [
    `I couldn't verify the ${flagged} above against an exact quote from a retrieved label or SDS, so I withheld it (marked ${marking}).`,
    REGULATED_CLAIM_CONSULT_LINE,
  ].join('\n');
}

/** B0-829 — footer appended under a `token_redaction` answer. */
export function buildRegulatedClaimTokenRedactionFooter(flagged: string): string {
  return redactionFooter(flagged, TOKEN_REDACTION_MARKING);
}

/** B0-871 — footer appended under a `sentence_redaction` answer. */
export function buildRegulatedClaimSentenceRedactionFooter(flagged: string): string {
  return redactionFooter(flagged, SENTENCE_REDACTION_MARKING);
}

/**
 * B0-928 (RC5) — one-sentence GENERAL regulatory principle per category, inserted into the full
 * decline so it carries the governing rule instead of only saying nothing could be verified.
 *
 * Every sentence must hold for any product: no product name, no dilution, contact time, EPA/DIN
 * number, ppm, %, or organism. These are rules about where the answer lives, never the answer.
 */
export const REGULATED_CLAIM_GOVERNING_RULES: Record<RegulatedClaimCategory, string> = {
  epa_registration:
    "An EPA registration number is read from the product's own current label; it does not carry over from a name variant, a sibling product, or a competitor equivalent.",
  din_registration:
    "A Canadian DIN or PCP number belongs to one registered Canadian product label and is read from that label, never inferred from a related product.",
  dilution_ratio:
    "The correct dilution is the one printed on the product's own current label for the intended use; any other ratio is off-label and voids the labeled claims.",
  contact_time:
    "Contact/dwell time is label- and organism-specific: the surface has to stay visibly wet for the full time that product's label states for that organism.",
  cas_number:
    "A CAS number identifies one specific substance and is read from Section 3 (composition) of the product's own SDS.",
  hazard:
    "GHS classification, signal word, and hazard statements come from Section 2 of the product's own current SDS.",
  // No phone number here on purpose: the corpus is US + Canada, the two countries route poison
  // calls differently, and a hardcoded national hotline would be a region inference.
  first_aid:
    "First-aid direction comes from Section 4 of the product's own current SDS; for any exposure, contact your local poison control centre or emergency services immediately.",
  compatibility:
    "The approved surfaces are the ones listed on the product's own current label, and a surface that is not listed there is not an approved use.",
  efficacy_claim:
    "A product carries only the organism claims printed on its own current EPA-registered label; claims never transfer between products, formulations, or name variants.",
};

/**
 * B0-928 (RC5) — the full-decline copy, now carrying the governing rule for each flagged category.
 * `flagged` is the human-readable category label list the caller already renders.
 */
export function buildRegulatedClaimDeclineCopy(input: {
  flagged: string;
  categories: readonly RegulatedClaimCategory[];
}): string {
  const rules = [...new Set(input.categories)].map(
    (category) => REGULATED_CLAIM_GOVERNING_RULES[category],
  );

  const ruleBlock =
    rules.length === 0
      ? []
      : rules.length === 1
        ? [rules[0], '']
        : [...rules.map((rule) => `- ${rule}`), ''];

  return [
    `I can't verify the ${input.flagged} in this answer against an exact quote from a retrieved label or SDS, so I won't state it.`,
    '',
    ...ruleBlock,
    REGULATED_CLAIM_CONSULT_LINE,
  ].join('\n');
}

const ALL_REGULATED_CLAIM_CATEGORIES = Object.keys(
  REGULATED_CLAIM_CATEGORY_LABELS,
) as RegulatedClaimCategory[];

/**
 * Matches either redaction footer's first line for ANY flagged-category list and either marking,
 * built from the same sentence `redactionFooter` writes.
 */
const REDACTION_FOOTER_LINE =
  /I couldn't verify the [^\n]*? above against an exact quote from a retrieved label or SDS, so I withheld it \(marked [^\n]*\)\.[ \t]*\n?/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CONSULT_LINE_PATTERN = new RegExp(`${escapeRegExp(REGULATED_CLAIM_CONSULT_LINE)}[ \t]*\n?`, 'g');

/**
 * B0-928 (RC3) — remove every app-authored redaction artifact from an answer, leaving only what the
 * model actually said. Used by the grader so the guardrail's own transparency copy ("(unable to
 * verify)", "[one … withheld — …]", "I couldn't verify the … so I withheld it", the consult line)
 * is not read as the model declining: two golden rows carrying complete, correct answers were
 * failing purely because that copy matches the decline regexes.
 *
 * Footers are removed first so the `(marked "(unable to verify)")` inside one does not lose its
 * marker before the whole line is matched. Pure and allocation-cheap; safe on text with none of it.
 */
export function stripRegulatedClaimRedactionArtifacts(text: string): string {
  let stripped = text
    .replace(REDACTION_FOOTER_LINE, '')
    .replace(CONSULT_LINE_PATTERN, '')
    .replaceAll(REGULATED_CLAIM_UNVERIFIED_TOKEN_MARKER, ' ');

  for (const category of ALL_REGULATED_CLAIM_CATEGORIES) {
    stripped = stripped.replaceAll(regulatedClaimWithheldMarker(category), ' ');
  }

  return stripped;
}
