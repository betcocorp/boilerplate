import { isBexModelTag, type BexModelTag } from '~/lib/constants/models';
import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { samplingParamsFor } from '~/lib/openai/model-capabilities';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';
import type { LlmTokenUsage } from '~/lib/openai/responses-runtime';
import {
  resolveOpenAiRequestTimeoutMs,
  retryTransportFaults,
} from '~/lib/openai/transport-retry';
import { getStringSetting } from '~/lib/settings/settings-service';
import { resolveMaxOutputTokens } from '~/lib/workflows/product-support/max-output-tokens';

import {
  validatorResultSchema,
  type ValidatorResult,
} from '~/lib/workflows/product-support/product-support-schemas';
import { VALIDATOR_SYSTEM_PROMPT } from '~/lib/workflows/product-support/product-support-prompts';

/**
 * B0-550 — the OpenAI SDK response shape's `usage` field, extracted into the shared
 * `LlmTokenUsage` shape (the same fields `~/lib/openai/responses-runtime.ts`'s `accumulateUsage`
 * reads). Kept loose/duck-typed rather than importing the SDK's `Response` type here, since both
 * call sites below already type their `res` via inference from `client.responses.create`.
 */
function extractLlmUsage(res: {
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    total_tokens?: number | null;
    input_tokens_details?: { cached_tokens?: number | null } | null;
  } | null;
}): LlmTokenUsage {
  return {
    promptTokens: res.usage?.input_tokens ?? 0,
    completionTokens: res.usage?.output_tokens ?? 0,
    totalTokens: res.usage?.total_tokens ?? 0,
    cachedPromptTokens: res.usage?.input_tokens_details?.cached_tokens ?? 0,
  };
}

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

/** B0-603 — real prior default: BEX_VALIDATOR_MODEL was never set anywhere, so the validator has
 * always fallen through to the 'preview' tag (gpt-4.1-mini). Seeded as the settings row default. */
export const DEFAULT_BEX_VALIDATOR_MODEL_TAG: BexModelTag = 'preview';

/**
 * B0-603 — the `BEX_VALIDATOR_MODEL` settings row, re-validated against `BEX_MODEL_TAGS` before
 * use. `settings.allowed_values` is advisory metadata the admin API validates writes against, NOT
 * a database constraint, so an unrecognized stored value falls back to the default tag rather
 * than being handed to the API as a non-existent model id.
 */
export async function resolveValidatorModelTag(): Promise<BexModelTag> {
  const raw = (
    await getStringSetting('BEX_VALIDATOR_MODEL', DEFAULT_BEX_VALIDATOR_MODEL_TAG)
  ).trim();
  return isBexModelTag(raw) ? raw : DEFAULT_BEX_VALIDATOR_MODEL_TAG;
}

/**
 * B0-389 — the model the validator pass actually calls. Exported so the workflow can record it on
 * the validator step's prompt record without duplicating (and eventually contradicting) the
 * `BEX_VALIDATOR_MODEL` resolution.
 *
 * An explicit `modelTag` (e.g. a test run's model override) always wins; the settings row only
 * supplies the default when a run doesn't pass one. Moved off the old env-var override per
 * B0-638/B0-603 — that env var was never actually set in any environment, so this is
 * behavior-preserving, not a model change.
 */
export async function resolveValidatorModel(modelTag?: string): Promise<string> {
  if (modelTag) {
    return resolveResponsesModel(modelTag);
  }
  return resolveResponsesModel(await resolveValidatorModelTag());
}

/** B0-554 — `runValidatorPass`'s result plus the token usage from its one model call. */
export type ValidatorPassResult = ValidatorResult & { usage: LlmTokenUsage };

export async function runValidatorPass(input: {
  draftAnswer: string;
  evidenceSummary: string;
  modelTag?: string;
}): Promise<ValidatorPassResult> {
  const client = getOpenAIClient();
  const model = await resolveValidatorModel(input.modelTag);

  const payload = {
    draft: input.draftAnswer,
    evidence_summary: input.evidenceSummary,
  };

  /**
   * B0-550 — bounded retry/backoff (the same `retryTransportFaults` the generation runtime uses)
   * plus an explicit per-attempt timeout, so a hung upstream request is bounded in seconds instead
   * of the SDK's own 10-minute default (itself retried up to twice more by the SDK's own default
   * `maxRetries: 2` -- see `resolveOpenAiRequestTimeoutMs`'s doc comment). `maxRetries: 0` disables
   * the SDK's own retry in favor of this one. This call previously had NEITHER a timeout NOR any
   * retry policy at all, which is exactly the shape of the observed 2,000-6,200-second stalls.
   */
  const res = await retryTransportFaults(
    () =>
      client.responses.create(
        {
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
          // B0-606 — omitted for models that reject it (gpt-5.5/gpt-5.6/o-series). Determinism
          // still matters here, so every model that DOES accept it keeps temperature 0.
          ...samplingParamsFor(model, { temperature: 0 }),
          max_output_tokens: resolveMaxOutputTokens(),
        },
        { maxRetries: 0, timeout: resolveOpenAiRequestTimeoutMs() },
      ),
    { runtime: 'responses', label: 'validator.create' },
  );

  // B0-554 — captured before the parse try/catch: the API call itself succeeded either way, so
  // usage is real even on the parse-failure fallback below.
  const usage = extractLlmUsage(res);

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
      usage,
    };
  } catch {
    return {
      approved: false,
      confidence: 0,
      issues: ['validator_output_parse_failed'],
      requires_human_review: true,
      usage,
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
  | 'din_registration'
  | 'dilution_ratio'
  | 'contact_time'
  | 'hazard'
  | 'first_aid'
  | 'compatibility'
  | 'cas_number'
  | 'efficacy_claim';

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
export function normalizeUnitToken(value: string): string {
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
/**
 * B0-756 audit — the org's regulated-data rule names "DIN" alongside EPA reg numbers as a value
 * that must be transcribed exactly (see the "Name your sources" section of
 * `product-support-prompts.ts`, which already tells the model DIN comes from the Canadian label),
 * but nothing verified it. Same token shape as `EPA_REG_TOKEN_PATTERN`: anchored on a nearby "DIN"
 * mention so a stray hyphenated/digit-run number elsewhere in the answer isn't swept in. Canadian
 * DIN numbers are 8 digits; PCP numbers (also Canadian, pesticide-specific) are typically 4-6 --
 * both anchor on "DIN"/"PCP" so one pattern covers both without guessing which the model wrote.
 */
const DIN_REG_TOKEN_PATTERN = /\b(?:din|pcp)\b[^\n]{0,50}?(\d{4,8})/gi;
/** Inherently dilution-shaped values -- extracted wherever they appear. */
const DILUTION_TOKEN_PATTERNS = [
  /\d+(?:\.\d+)?\s*(?:fl\.?\s*)?oz\.?s?\s*(?:\/|per)\s*gal(?:lon)?s?\b/gi,
  /\b\d{1,3}\s*:\s*\d{1,5}\b/g,
  // B0-756 audit -- the org's regulated-data rule lists "mL/L" and "ppm" alongside oz/gal and
  // ratios as dilution/concentration values that must be transcribed exactly. Both were
  // completely unextracted before this, so a fabricated ppm or mL/L figure was invisible to this
  // guardrail no matter how wrong it was.
  /\d+(?:\.\d+)?\s*ml\.?\s*(?:\/|per)\s*l(?:iter|itre)?s?\b/gi,
  /\d+(?:\.\d+)?\s*ppm\b/gi,
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
 * B0-756 — a surface/material compatibility claim ("safe on stainless steel", "will not etch
 * marble") is exactly as regulated as a hazard or first-aid statement: it comes off the product's
 * own label and a wrong answer creates real damage/liability exposure, but until this ticket
 * `evaluateRegulatedClaimGrounding` had no category for it at all, so a sentence like "stainless
 * steel is an approved surface for use" sailed through completely unchecked — not epa/dilution/
 * contact-time-shaped, and matching neither the hazard nor first-aid trigger patterns. Confirmed
 * live: a pH7Q compatibility question got a confident "yes, safe on stainless steel" answer with
 * `sources: []` (nothing retrieved actually said so) and a fabricated "Source: pH7Q product label"
 * citation, and no guardrail in this file was even looking at that sentence.
 *
 * Requires BOTH a material/surface noun AND a compatibility-claim verb phrase in the same
 * sentence (mirrors the hazard category's qualified-trigger + context-pattern approach) so
 * generic facility/setting language ("recommended for hospitals, schools") doesn't get swept in
 * as a false positive.
 */
const COMPATIBILITY_MATERIAL_PATTERN =
  /\b(stainless steel|aluminum|brass|chrome|copper|galvanized|marble|granite|terrazzo|vinyl|linoleum|rubber|plastic|glass|porcelain|ceramic tile|grout|wood|hardwood|carpet|upholstery|concrete|powder[-\s]?coated|acrylic|fiberglass|epoxy)\b/i;
const COMPATIBILITY_CLAIM_PATTERN =
  /\b(safe (?:for|to use on|on)|approved (?:surface|for use)?(?: on| for)?|compatible with|not compatible with|will not (?:damage|harm|etch|dull|corrode|discolor|degrade|pit|haze)|not (?:recommended|safe|approved) for|should not be used on|suitable for use on|can be used on|recommended for use on|labeled for use on)\b/i;

/**
 * B0-756 audit — the same failure class as `compatibility` above but for organism/kill claims:
 * "kills SARS-CoV-2 in one minute", "effective against a broad spectrum of pathogens",
 * "bactericidal". These are EPA-registered efficacy claims (see B0-760's "kill claims do not
 * transfer" work on the cross-reference path), yet nothing in this file verified them against a
 * source before now — a fabricated organism or log-reduction claim was as invisible as the
 * compatibility gap was. Deliberately narrow to strong, unambiguous efficacy-claim vocabulary
 * (never a bare "disinfects"/"disinfectant", which appears in nearly every product's generic
 * marketing description and would blow up false-positive volume) so this doesn't start rejecting
 * ordinary, already-grounded product descriptions.
 */
const EFFICACY_CLAIM_SENTENCE_PATTERN =
  /\b(kills?\b|kill claims?|eliminat(?:es?|ing)\b|effective against|bactericidal|virucidal|fungicidal|sporicidal|tuberculocidal|\d[\s-]*log reduction|log[\s-]*\d+ reduction|\d+(?:\.\d+)?\s*(?:%|percent)\s*(?:of\s+)?(?:bacteria|viruses|virus|germs|pathogens|microorganisms|microbes)\b)/i;

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

/** Extracts the DIN/PCP-shaped token near a "DIN"/"PCP" mention, not just any digit run. */
function extractDinRegTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(DIN_REG_TOKEN_PATTERN)) {
    if (match[1]) tokens.push(match[1]);
  }
  return tokens;
}

/**
 * B0-756 audit — CAS Registry Numbers (e.g. "7647-14-5") are on the org's explicit regulated-value
 * list. Anchored on a nearby "CAS" mention, same shape as `EPA_REG_TOKEN_PATTERN`/`DIN_REG_TOKEN_PATTERN`,
 * so a citation-page hyphenated number elsewhere in the answer isn't swept in.
 */
const CAS_NUMBER_TOKEN_PATTERN = /\bcas\b[^\n]{0,30}?(\d{2,7}-\d{2}-\d)\b/gi;

function extractCasNumberTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(CAS_NUMBER_TOKEN_PATTERN)) {
    if (match[1]) tokens.push(match[1]);
  }
  return tokens;
}

export function extractDilutionTokens(text: string): string[] {
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

function isCompatibilityClaimSentence(sentence: string): boolean {
  return (
    COMPATIBILITY_MATERIAL_PATTERN.test(sentence) && COMPATIBILITY_CLAIM_PATTERN.test(sentence)
  );
}

function isEfficacyClaimSentence(sentence: string): boolean {
  return EFFICACY_CLAIM_SENTENCE_PATTERN.test(sentence);
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
  checkTokenCategory('din_registration', extractDinRegTokens(input.draftAnswer));
  checkTokenCategory('dilution_ratio', extractDilutionTokens(input.draftAnswer));
  checkTokenCategory('contact_time', extractContactTimeTokens(input.draftAnswer));
  checkTokenCategory('cas_number', extractCasNumberTokens(input.draftAnswer));
  checkSentenceCategory(
    'hazard',
    extractSentenceClaims(input.draftAnswer, isHazardClaimSentence),
  );
  checkSentenceCategory(
    'first_aid',
    extractSentenceClaims(input.draftAnswer, isFirstAidClaimSentence),
  );
  checkSentenceCategory(
    'compatibility',
    extractSentenceClaims(input.draftAnswer, isCompatibilityClaimSentence),
  );
  checkSentenceCategory(
    'efficacy_claim',
    extractSentenceClaims(input.draftAnswer, isEfficacyClaimSentence),
  );

  return {
    categoriesDetected: [...new Set(categoriesDetected)],
    ungroundedCategories: [...new Set(ungroundedCategories)],
    ungroundedDetails,
  };
}

// ============================================================================
// B0-699 — dilution-citation product-identity guardrail
// ============================================================================
// `evaluateRegulatedClaimGrounding` above only confirms a dilution figure appears verbatim
// SOMEWHERE in this turn's retrieved evidence -- a multi-product `verified-facts` block (built
// from every product line among the turn's broadly-matched search results, not just the one
// actually asked about) can satisfy that with a REAL row that belongs to a different, unrelated
// product line. Confirmed live on workflow run 61cc4ce9-bc1b-4d08-9b88-bc7d52c7365b: asked for
// DAILY DISINFECT's dilution, Bex answered "2 oz/gal (1:64)" citing `[doc:verified-facts]` -- a
// genuine `rag.product_line_fact` row, just for an unrelated "Disinfectant"/VersiFect product line
// that rode along in the same broad-probe evidence set, while the product line the broad probe
// actually locked (and the actual "Daily Disinfectant" fact rows) never carried that value.
//
// This check re-fetches the LOCKED product line's OWN fact row fresh (never the shared multi-
// product block the model saw) and requires any cited dilution figure to match THAT row
// specifically. It is a narrower, stricter companion to the verbatim check above, not a
// replacement for it -- both must pass.

/** Matches the verified-facts citation marker, including the per-product batch form
 * `[doc:verified-facts:<productLineKey>]` (B0-549's `executeBatchEfficacyData`). */
const VERIFIED_FACTS_CITATION_PATTERN = /\[doc:verified-facts(?::[^\]]+)?\]/i;

export type DilutionCitationGroundingResult = {
  /** Whether the draft cited `[doc:verified-facts]` alongside a dilution figure at all. When
   * false, `grounded`/`ungroundedTokens` are meaningless and no rejection should follow. */
  applicable: boolean;
  /** True when every cited dilution figure matches the locked product line's own fact row.
   * Always false when `applicable` is true and there is no locked product line (nothing to
   * verify the figure against) or the locked line has no dilution fact on file at all. */
  grounded: boolean;
  /** Every dilution-shaped token the draft asserted, for the review-task payload. */
  citedTokens: string[];
  /** The subset of `citedTokens` that could not be matched to the locked line's own fact row. */
  ungroundedTokens: string[];
};

/**
 * The strings a locked product line's OWN `ProductLineFacts` row could plausibly be quoted as,
 * mirroring exactly how `renderFacts` (`~/lib/retrieval/product-facts.ts`) writes the `Dilution:`
 * line so a citation in either the plain or the combined "display (oz/gal)" form still matches.
 */
function renderedDilutionStrings(facts: { dilutionDisplay: string | null; dilutionOzPerGal: number | null }): string[] {
  const out: string[] = [];
  if (facts.dilutionDisplay) out.push(facts.dilutionDisplay);
  if (facts.dilutionOzPerGal != null) out.push(`${facts.dilutionOzPerGal} oz/gal`);
  if (facts.dilutionDisplay && facts.dilutionOzPerGal != null) {
    out.push(`${facts.dilutionDisplay} (${facts.dilutionOzPerGal} oz/gal)`);
  }
  return out;
}

/**
 * B0-699 — deliberately takes only the scalar dilution fields (not the full `ProductLineFacts`
 * import) so this module stays independent of the retrieval layer's types; the caller passes the
 * locked product line's own freshly-fetched facts (or null when no product line is locked / it
 * carries no dilution fact).
 *
 * Deliberately NOT gated behind `BEX_DISABLE_CONFIDENCE_GATING` by any caller -- see the kill-
 * switch note on `evaluateRegulatedClaimGrounding`'s call site in `run-product-support-workflow.ts`.
 * That flag already suppresses the verbatim guardrail above in production; wiring this check to the
 * same switch would leave today's production config with no working defense against this failure
 * mode at all.
 */
export function evaluateVerifiedFactsDilutionCitation(input: {
  draftAnswer: string;
  lockedFacts: { dilutionDisplay: string | null; dilutionOzPerGal: number | null } | null;
}): DilutionCitationGroundingResult {
  if (!VERIFIED_FACTS_CITATION_PATTERN.test(input.draftAnswer)) {
    return { applicable: false, grounded: true, citedTokens: [], ungroundedTokens: [] };
  }
  const citedTokens = extractDilutionTokens(input.draftAnswer);
  if (citedTokens.length === 0) {
    return { applicable: false, grounded: true, citedTokens: [], ungroundedTokens: [] };
  }

  const groundedStrings = input.lockedFacts
    ? renderedDilutionStrings(input.lockedFacts).map(normalizeUnitToken)
    : [];
  const ungroundedTokens = citedTokens.filter((token) => {
    const normalizedToken = normalizeUnitToken(token);
    if (!normalizedToken) return true;
    return !groundedStrings.some(
      (g) => g === normalizedToken || g.includes(normalizedToken) || normalizedToken.includes(g),
    );
  });

  return {
    applicable: true,
    grounded: ungroundedTokens.length === 0,
    citedTokens,
    ungroundedTokens: [...new Set(ungroundedTokens)],
  };
}

/**
 * B0-389 — the revision pass's own instructions, lifted out of the call so the workflow can record
 * exactly what the revision model was told on its `revision` step. Text unchanged.
 */
export const REVISION_SYSTEM_PROMPT = [
  'Revise the draft answer to fix validator issues.',
  'Do not add new factual claims beyond the evidence summary.',
  'If you cannot fix safely, reply with a short clarification request only.',
].join('\n');

/** B0-389 — the model the revision pass calls (no dedicated env override, unlike the validator). */
export async function resolveRevisionModel(modelTag?: string): Promise<string> {
  return resolveResponsesModel(modelTag ?? 'preview');
}

/** B0-554 — `runRevisionPass`'s result plus the token usage from its one model call. */
export type RevisionPassResult = { text: string; usage: LlmTokenUsage };

export async function runRevisionPass(input: {
  draftAnswer: string;
  validatorIssues: string[];
  evidenceSummary: string;
  modelTag?: string;
}): Promise<RevisionPassResult> {
  const client = getOpenAIClient();
  const model = await resolveRevisionModel(input.modelTag);

  // B0-550 — same bounded retry + explicit timeout as `runValidatorPass`; see its comment above.
  const res = await retryTransportFaults(
    () =>
      client.responses.create(
        {
          model,
          instructions: REVISION_SYSTEM_PROMPT,
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
          // B0-606 — same gating as the validator pass above.
          ...samplingParamsFor(model, { temperature: 0.2 }),
          max_output_tokens: resolveMaxOutputTokens(),
        },
        { maxRetries: 0, timeout: resolveOpenAiRequestTimeoutMs() },
      ),
    { runtime: 'responses', label: 'revision.create' },
  );

  return {
    text: extractAssistantText(res),
    usage: extractLlmUsage(res),
  };
}
