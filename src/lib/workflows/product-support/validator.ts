import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';

import {
  validatorResultSchema,
  type ValidatorResult,
} from '~/lib/workflows/product-support/product-support-schemas';
import { VALIDATOR_SYSTEM_PROMPT } from '~/lib/workflows/product-support/product-support-prompts';

const VALIDATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    approved: { type: 'boolean' },
    confidence: { type: 'number' },
    issues: { type: 'array', items: { type: 'string' } },
    requires_human_review: { type: 'boolean' },
  },
  required: ['approved', 'confidence', 'issues', 'requires_human_review'],
} as const;

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
    return validatorResultSchema.parse(parsed);
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

/** Lowercase, collapse whitespace, strip trailing punctuation/markdown emphasis -- comparison-only, never used to alter displayed text. */
function normalizeForGroundingCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[*_`]/g, '')
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
const DILUTION_TOKEN_PATTERNS = [
  /\d+(?:\.\d+)?\s*(?:fl\.?\s*)?oz\.?s?\s*(?:\/|per)\s*gal(?:lon)?s?\b/gi,
  /\b\d{1,3}\s*:\s*\d{1,5}\b/g,
  /\b\d+(?:\.\d+)?\s*%/g,
];
const CONTACT_TIME_TOKEN_PATTERN =
  /\b\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?)\b/gi;
const CONTACT_TIME_CONTEXT_PATTERN = /\b(contact|dwell|kill time|wet time|remain wet)\b/i;
const HAZARD_SENTENCE_PATTERN =
  /\b(hazard|corrosive|flammable|combustible|causes? (severe )?(skin|eye) (burns?|damage|irritation)|\bdanger\b|\bwarning\b|\bcaution\b|ppe|personal protective)\b/i;
const FIRST_AID_SENTENCE_PATTERN =
  /\bfirst aid\b|\bif swallowed\b|\bif inhaled\b|\bif in eyes\b|\bif on skin\b|\bpoison control\b/i;

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
  return DILUTION_TOKEN_PATTERNS.flatMap((pattern) => extractRegexTokens(text, pattern));
}

function extractContactTimeTokens(text: string): string[] {
  if (!CONTACT_TIME_CONTEXT_PATTERN.test(text)) {
    return [];
  }
  return extractRegexTokens(text, CONTACT_TIME_TOKEN_PATTERN);
}

/** Hazard/first-aid claims are prose, not single values -- the "token" to verify is the whole sentence. */
function extractSentenceClaims(text: string, pattern: RegExp): string[] {
  return splitIntoSentences(text).filter((sentence) => pattern.test(sentence));
}

function isTokenGrounded(token: string, normalizedSources: string[]): boolean {
  const normalized = normalizeUnitToken(token);
  if (!normalized) return false;
  return normalizedSources.some((body) => body.includes(normalized));
}

function isSentenceGrounded(sentence: string, normalizedSources: string[]): boolean {
  const normalized = normalizeForGroundingCompare(sentence);
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
  const normalizedSourceBodiesPlain = input.sources.map((s) =>
    normalizeForGroundingCompare(s.documentBody),
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
    extractSentenceClaims(input.draftAnswer, HAZARD_SENTENCE_PATTERN),
  );
  checkSentenceCategory(
    'first_aid',
    extractSentenceClaims(input.draftAnswer, FIRST_AID_SENTENCE_PATTERN),
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
