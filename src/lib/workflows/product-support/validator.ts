import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';

import {
  validatorResultSchema,
  type ValidatorResult,
} from '~/lib/workflows/product-support/product-support-schemas';
import { VALIDATOR_SYSTEM_PROMPT } from '~/lib/workflows/product-support/product-support-prompts';

// B0-369: `issues` is an UNSUPPORTED-findings-only channel -- it feeds the revision pass, so a
// confirmation in there asks the revision model to repair a claim that verified fine. Positive
// confirmations go in `supported_claims`, which is trace-only.
const VALIDATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    approved: { type: 'boolean' },
    confidence: { type: 'number' },
    issues: {
      type: 'array',
      description:
        'Problems only: claims that are unsupported, only partially supported, contradicted, or unsafe. Never include confirmations of supported claims.',
      items: { type: 'string' },
    },
    supported_claims: {
      type: 'array',
      description:
        'Claims that ARE fully supported by the evidence. Confirmations belong here, never in issues.',
      items: { type: 'string' },
    },
    requires_human_review: { type: 'boolean' },
  },
  required: [
    'approved',
    'confidence',
    'issues',
    'supported_claims',
    'requires_human_review',
  ],
} as const;

/**
 * B0-369 — belt-and-braces filter for models that still narrate confirmations into `issues`.
 * A string is only reclassified when it reads as a plain confirmation AND carries no negation,
 * partial-support or shortfall marker, so genuine findings ("... is not supported", "only
 * partially supported: evidence confirms SARS-CoV-2 but not all viruses", "No evidence provided
 * to support any claims in the draft") are always kept as issues.
 */
const SUPPORT_CONFIRMATION_PATTERN =
  /\b(?:is|are|was|were)\s+(?:fully\s+|clearly\s+|directly\s+|explicitly\s+|well[-\s]|adequately\s+)?(?:supported|substantiated|corroborated|verified|confirmed|backed)\b/i;
const SUPPORT_SHORTFALL_PATTERN =
  /\b(?:not|no|never|none|non|partial|partially|partly|only|somewhat|weakly|insufficient|insufficiently|inadequate|lack|lacks|lacking|missing|absent|unsupported|unverified|unclear|ambiguous|cannot|can't|fail|fails|failed|contradict|contradicts|contradicted|contradictory|but|however|except|beyond|although|though|unless|assum\w*|off-label|prohibited)\b/i;

/** Splits validator `issues` into genuine findings and (dropped-from-issues) confirmations. */
export function partitionValidatorIssues(issues: string[]): {
  issues: string[];
  supportedClaims: string[];
} {
  const genuine: string[] = [];
  const supported: string[] = [];
  for (const issue of issues) {
    const isConfirmation =
      SUPPORT_CONFIRMATION_PATTERN.test(issue) && !SUPPORT_SHORTFALL_PATTERN.test(issue);
    if (isConfirmation) {
      supported.push(issue);
    } else {
      genuine.push(issue);
    }
  }
  return { issues: genuine, supportedClaims: supported };
}

export async function runValidatorPass(input: {
  draftAnswer: string;
  evidenceSummary: string;
  modelTag?: string;
}): Promise<ValidatorResult> {
  const client = getOpenAIClient();
  const model =
    process.env.BEX_VALIDATOR_MODEL?.trim() ||
    resolveResponsesModel(input.modelTag ?? 'preview');

  const payload = {
    draft: input.draftAnswer,
    evidence_summary: input.evidenceSummary,
  };

  const res = await client.responses.create({
    model,
    instructions: VALIDATOR_SYSTEM_PROMPT,
    input: [
      {
        role: 'user',
        content: JSON.stringify(payload),
        type: 'message',
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'validation_result',
        strict: true,
        schema: VALIDATION_JSON_SCHEMA,
      },
    },
    store: false,
    stream: false,
    temperature: 0,
  });

  try {
    const text = extractAssistantText(res);
    const parsed = JSON.parse(text) as unknown;
    const result = validatorResultSchema.parse(parsed);
    // B0-369: keep `issues` to genuine findings even if the model narrates a confirmation there.
    const partitioned = partitionValidatorIssues(result.issues);
    return {
      ...result,
      issues: partitioned.issues,
      supported_claims: [
        ...(result.supported_claims ?? []),
        ...partitioned.supportedClaims,
      ],
    };
  } catch {
    return {
      approved: false,
      confidence: 0,
      issues: ['validator_output_parse_failed'],
      requires_human_review: true,
    };
  }
}

// ============================================================================
// B0-257 — regulated-claim guardrails
// ============================================================================
// Answers touching EPA registration claims, dilution ratios, hazard statements, or
// first-aid content are "must-cite, must-not-paraphrase": every regulated value or
// statement asserted in the draft must be traceable to an exact quote/citation in a
// retrieved source document (label or SDS) -- never rounded, converted, or inferred
// (org regulated-data rule). This is a deterministic, non-LLM guardrail: it never
// alters or estimates a value, it only checks whether the value/statement the model
// already wrote is verifiable verbatim (allowing safe unit-spelling normalization for
// the *comparison* only -- e.g. "ounces" ~ "oz" -- never for what is shown to the
// user) against the grounding evidence already retrieved for this turn.
//
// On failure the caller (run-product-support-workflow.ts) rejects the draft, falls
// back to a safer/less-specific response, and raises a review task via the existing
// `insertReviewTask` escalation mechanism (the same pattern used for other validator
// rejections and mirrored by the static `get_escalation_policy` tool in
// product-tools.ts) -- this file does not invent a new escalation path.

export type RegulatedClaimCategory =
  | 'epa_registration'
  | 'dilution_ratio'
  | 'contact_time'
  | 'hazard'
  | 'first_aid';

export type RegulatedClaimSource = {
  documentId: string;
  title: string;
  documentBody: string;
};

export type RegulatedClaimGroundingResult = {
  /** Regulated categories with at least one detected claim in the draft. */
  categoriesDetected: RegulatedClaimCategory[];
  /** Detected categories where NO claim could be verified verbatim against any source. */
  ungroundedCategories: RegulatedClaimCategory[];
  /** One entry per ungrounded claim, for the review-task payload. */
  ungroundedDetails: Array<{ category: RegulatedClaimCategory; snippet: string }>;
};

/**
 * Lowercase, collapse whitespace, strip trailing punctuation/markdown emphasis -- comparison-only,
 * never used to alter displayed text.
 *
 * B0-366: also strips Markdown *structure* (leading list markers, heading `#`, leading/trailing `:`)
 * so a source line the model re-rendered as a bullet or heading still compares equal to the plain
 * source text. This is purely mechanical presentation stripping applied symmetrically to both the
 * claim and the source -- no regulated value (ratio, ppm, %, contact time, CAS, EPA reg no.) is
 * altered, rounded, or converted by it.
 */
function normalizeForGroundingCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:#{1,6}\s*)+/, '')
    .replace(/^(?:[-–—•>+]\s+|\d{1,2}[.)]\s+)+/, '')
    .replace(/^:+\s*/, '')
    .replace(/\s*:+$/, '')
    .trim();
}

/**
 * Sentence-level (prose) comparison normalizer for the hazard / first-aid categories.
 * On top of the structural stripping above it treats `:` between words as a separator, so a
 * label field the model re-punctuated ("Signal word: Danger" vs "Signal word Danger") still
 * compares equal. Applied to BOTH sides. Regulated *values* are never compared through this
 * path -- EPA reg numbers, ratios and contact times go through `normalizeUnitToken`, which
 * keeps their punctuation intact.
 */
function normalizeSentenceForGroundingCompare(value: string): string {
  return normalizeForGroundingCompare(value)
    .replace(/\s*:\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Additionally normalizes common unit spellings so "2 oz per gallon" and "2 oz/gal" compare equal. Comparison-only. */
function normalizeUnitToken(value: string): string {
  return normalizeForGroundingCompare(value)
    .replace(/\bounces?\b/g, 'oz')
    .replace(/\bfl\.?\s*oz\.?/g, 'oz')
    .replace(/\bgallons?\b/g, 'gal')
    .replace(/\bseconds?\b|\bsecs?\b/g, 'sec')
    .replace(/\bminutes?\b|\bmins?\b/g, 'min')
    .replace(/\bper\b/g, '/')
    .replace(/[.,]/g, '')
    .replace(/\s*\/\s*/g, '/') // "oz / gal" and "oz/gal" must compare equal
    .replace(/\s+/g, ' ')
    .trim();
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const EPA_REG_TOKEN_PATTERN = /\bepa\b[^\n]{0,50}?(\d{1,6}-\d{1,6}(?:-\d{1,6})?)/gi;
/** Inherently dilution-shaped values -- extracted wherever they appear. */
const DILUTION_TOKEN_PATTERNS = [
  /\d+(?:\.\d+)?\s*(?:fl\.?\s*)?oz\.?s?\s*(?:\/|per)\s*gal(?:lon)?s?\b/gi,
  /\b\d{1,3}\s*:\s*\d{1,5}\b/g,
];
/**
 * B0-366: a bare percentage is only a dilution/concentration claim when dilution context sits
 * next to it. Mirrors the CONTACT_TIME_CONTEXT_PATTERN gate, but windowed so an efficacy figure
 * ("effective on 100% of tested surfaces") elsewhere in the same answer is not swept in. A
 * percentage that IS presented as a dilution/concentration is still extracted and compared
 * verbatim.
 */
const DILUTION_PERCENT_TOKEN_PATTERN = /\b\d+(?:\.\d+)?\s*%/g;
const DILUTION_PERCENT_CONTEXT_PATTERN =
  /\b(dilut\w*|concentrat\w*|solution|mix(?:\w*)?|ratio|per gal(?:lon)?s?|oz\s*(?:\/|per)\s*gal|by volume|v\s*\/\s*v|ready[-\s]?to[-\s]?use|rtu|use at|at a rate of|strength)\b/i;
const DILUTION_PERCENT_CONTEXT_WINDOW = 60;
const CONTACT_TIME_TOKEN_PATTERN =
  /\b\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?)\b/gi;
const CONTACT_TIME_CONTEXT_PATTERN = /\b(contact|dwell|kill time|wet time|remain wet)\b/i;
/**
 * B0-366: bare `warning` / `caution` / `ppe` are NOT standalone hazard triggers any more --
 * generic safety boilerplate ("wear appropriate PPE", "follow all label warnings") is not a
 * quotable regulated claim. They only count when a GHS token sits in the same sentence (e.g.
 * "Signal word: CAUTION", "Warning: H314"), which is a real transcribed label value.
 */
const HAZARD_SENTENCE_PATTERN =
  /\b(hazard|corrosive|flammable|combustible|causes? (severe )?(skin|eye) (burns?|damage|irritation)|\bdanger\b)\b/i;
const HAZARD_QUALIFIED_TRIGGER_PATTERN = /\b(warning|caution|ppe|personal protective)\b/i;
const GHS_CONTEXT_PATTERN =
  /\b(signal word|ghs|pictogram|hazard statements?|precautionary statements?|h[23]\d{2}|p\d{3})\b/i;
const FIRST_AID_SENTENCE_PATTERN =
  /\bfirst aid\b|\bif swallowed\b|\bif inhaled\b|\bif in eyes\b|\bif on skin\b|\bpoison control\b/i;

/**
 * B0-366: sentences that announce or label content rather than assert it -- Markdown headings
 * ("**First aid measures:**"), label field scaffolding with no value, and the model's own framing
 * ("The hazard warnings for X are as follows:"). A heading carries no assertion to verify, and a
 * framing sentence can never be a verbatim source quote, so requiring one is a false positive by
 * construction. Detection of the actual claim sentences that follow is unaffected.
 */
const ANNOUNCEMENT_FRAMING_PATTERN =
  /\b(as follows|are listed below|is listed below|here (?:are|is) the)\b/i;

function isNonClaimScaffolding(sentence: string): boolean {
  const base = sentence
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:#{1,6}\s*)+/, '')
    .replace(/^(?:[-–—•>+]\s+|\d{1,2}[.)]\s+)+/, '')
    .trim();

  if (!/[a-z]/.test(base)) return true;
  // Ends with a colon => heading / announcement, or a label field with an empty value.
  if (/:[\s.]*$/.test(base)) return true;
  // No alphabetic content after the last colon => "signal word: 2)" style scaffolding.
  const lastColon = base.lastIndexOf(':');
  if (lastColon >= 0 && !/[a-z]/.test(base.slice(lastColon + 1))) return true;
  return ANNOUNCEMENT_FRAMING_PATTERN.test(base);
}

function extractRegexTokens(text: string, pattern: RegExp): string[] {
  const matches = text.match(pattern);
  return matches ? matches.map((m) => m.trim()) : [];
}

/** Extracts the EPA reg-number-shaped token near an "EPA" mention, not just any hyphenated number. */
function extractEpaRegTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(EPA_REG_TOKEN_PATTERN)) {
    if (match[1]) tokens.push(match[1]);
  }
  return tokens;
}

function extractDilutionTokens(text: string): string[] {
  const tokens = DILUTION_TOKEN_PATTERNS.flatMap((pattern) =>
    extractRegexTokens(text, pattern),
  );
  for (const match of text.matchAll(DILUTION_PERCENT_TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    const window = text.slice(
      Math.max(0, start - DILUTION_PERCENT_CONTEXT_WINDOW),
      start + match[0].length + DILUTION_PERCENT_CONTEXT_WINDOW,
    );
    if (DILUTION_PERCENT_CONTEXT_PATTERN.test(window)) {
      tokens.push(match[0].trim());
    }
  }
  return tokens;
}

function extractContactTimeTokens(text: string): string[] {
  if (!CONTACT_TIME_CONTEXT_PATTERN.test(text)) {
    return [];
  }
  return extractRegexTokens(text, CONTACT_TIME_TOKEN_PATTERN);
}

/**
 * Hazard/first-aid claims are prose, not single values -- the "token" to verify is the whole
 * sentence. B0-366: headings / label scaffolding / framing sentences are skipped, since they
 * assert nothing that could be verified against a source.
 */
function extractSentenceClaims(
  text: string,
  isClaimTrigger: (sentence: string) => boolean,
): string[] {
  return splitIntoSentences(text).filter(
    (sentence) => isClaimTrigger(sentence) && !isNonClaimScaffolding(sentence),
  );
}

function isHazardClaimSentence(sentence: string): boolean {
  if (HAZARD_SENTENCE_PATTERN.test(sentence)) return true;
  return (
    HAZARD_QUALIFIED_TRIGGER_PATTERN.test(sentence) && GHS_CONTEXT_PATTERN.test(sentence)
  );
}

function isFirstAidClaimSentence(sentence: string): boolean {
  return FIRST_AID_SENTENCE_PATTERN.test(sentence);
}

function isTokenGrounded(token: string, normalizedSources: string[]): boolean {
  const normalized = normalizeUnitToken(token);
  if (!normalized) return false;
  return normalizedSources.some((body) => body.includes(normalized));
}

function isSentenceGrounded(sentence: string, normalizedSources: string[]): boolean {
  const normalized = normalizeSentenceForGroundingCompare(sentence);
  if (!normalized) return false;
  return normalizedSources.some((body) => body.includes(normalized));
}

/**
 * Deterministically checks whether every regulated claim (EPA reg no., dilution ratio,
 * contact/dwell time, hazard statement, first-aid instruction) in `draftAnswer` can be
 * traced to an exact quote in one of `sources`. Returns which categories were detected
 * and which of those could NOT be verified -- callers must treat any ungrounded category
 * as a hard validation failure (never a soft warning), per the org's regulated-data rule.
 */
export function evaluateRegulatedClaimGrounding(input: {
  draftAnswer: string;
  sources: RegulatedClaimSource[];
}): RegulatedClaimGroundingResult {
  // Same normalization is applied to the claim sentence and the source text, so the comparison
  // stays symmetric (B0-366).
  const normalizedSourceBodiesPlain = input.sources.map((s) =>
    normalizeSentenceForGroundingCompare(s.documentBody),
  );
  const normalizedSourceBodiesUnit = input.sources.map((s) =>
    normalizeUnitToken(s.documentBody),
  );

  const categoriesDetected: RegulatedClaimCategory[] = [];
  const ungroundedCategories: RegulatedClaimCategory[] = [];
  const ungroundedDetails: Array<{ category: RegulatedClaimCategory; snippet: string }> = [];

  const checkTokenCategory = (
    category: RegulatedClaimCategory,
    tokens: string[],
  ) => {
    if (tokens.length === 0) return;
    categoriesDetected.push(category);
    const ungroundedTokens = tokens.filter(
      (t) => !isTokenGrounded(t, normalizedSourceBodiesUnit),
    );
    // Grounded if AT LEAST ONE occurrence of the value verifies -- but every distinct
    // ungrounded token is still reported so a genuinely fabricated number is caught even
    // when it appears alongside one real, sourced value.
    if (ungroundedTokens.length > 0) {
      ungroundedCategories.push(category);
      for (const t of new Set(ungroundedTokens)) {
        ungroundedDetails.push({ category, snippet: t });
      }
    }
  };

  const checkSentenceCategory = (
    category: RegulatedClaimCategory,
    sentences: string[],
  ) => {
    if (sentences.length === 0) return;
    categoriesDetected.push(category);
    const ungroundedSentences = sentences.filter(
      (s) => !isSentenceGrounded(s, normalizedSourceBodiesPlain),
    );
    if (ungroundedSentences.length > 0) {
      ungroundedCategories.push(category);
      for (const s of ungroundedSentences) {
        ungroundedDetails.push({ category, snippet: s.slice(0, 240) });
      }
    }
  };

  checkTokenCategory('epa_registration', extractEpaRegTokens(input.draftAnswer));
  checkTokenCategory('dilution_ratio', extractDilutionTokens(input.draftAnswer));
  checkTokenCategory('contact_time', extractContactTimeTokens(input.draftAnswer));
  checkSentenceCategory(
    'hazard',
    extractSentenceClaims(input.draftAnswer, isHazardClaimSentence),
  );
  checkSentenceCategory(
    'first_aid',
    extractSentenceClaims(input.draftAnswer, isFirstAidClaimSentence),
  );

  return {
    categoriesDetected: [...new Set(categoriesDetected)],
    ungroundedCategories: [...new Set(ungroundedCategories)],
    ungroundedDetails,
  };
}

export async function runRevisionPass(input: {
  draftAnswer: string;
  validatorIssues: string[];
  evidenceSummary: string;
  modelTag?: string;
}): Promise<string> {
  const client = getOpenAIClient();
  const model = resolveResponsesModel(input.modelTag ?? 'preview');

  const res = await client.responses.create({
    model,
    instructions: [
      'Revise the draft answer to fix validator issues.',
      'Do not add new factual claims beyond the evidence summary.',
      'If you cannot fix safely, reply with a short clarification request only.',
    ].join('\n'),
    input: [
      {
        role: 'user',
        content: JSON.stringify({
          draft: input.draftAnswer,
          issues: input.validatorIssues,
          evidence_summary: input.evidenceSummary,
        }),
        type: 'message',
      },
    ],
    store: false,
    stream: false,
    temperature: 0.2,
  });

  return extractAssistantText(res);
}
