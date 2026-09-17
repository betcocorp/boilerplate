import { isBexModelTag, type BexModelTag } from '~/lib/constants/models';
import {
  completeStructuredWithUsage,
  completeTextWithUsage,
  StructuredOutputRefusedError,
  StructuredOutputTruncatedError,
  type CompletionResult,
} from '~/lib/llm/structured-completion';
import { resolveModel } from '~/lib/llm/resolve-model';
import type { LlmTokenUsage } from '~/lib/openai/responses-runtime';
import {
  resolveOpenAiRequestTimeoutMs,
  retryTransportFaults,
} from '~/lib/openai/transport-retry';
import { getBooleanSetting, getStringSetting } from '~/lib/settings/settings-service';
import { resolveMaxOutputTokens } from '~/lib/workflows/product-support/max-output-tokens';

import {
  validatorResultSchema,
  type ValidatorResult,
} from '~/lib/workflows/product-support/product-support-schemas';
import { VALIDATOR_SYSTEM_PROMPT } from '~/lib/workflows/product-support/product-support-prompts';

/**
 * B0-908 — both model calls in this file (`runValidatorPass`, `runRevisionPass`) go through
 * `~/lib/llm/structured-completion`, which routes on the resolved model id: a `claude-*` id is
 * served by the Anthropic Messages API, anything else by the OpenAI Responses API (`store: false`,
 * `samplingParamsFor` temperature gating preserved). Usage comes back already in the shared
 * `LlmTokenUsage` shape, so the B0-550 `extractLlmUsage` adapter is gone.
 */

/** B0-908 — usage for a call the helper aborted before returning a payload (truncated/refused). */
const ZERO_USAGE: LlmTokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedPromptTokens: 0,
};

/** A structured answer the helper refused to hand back: cut off at the cap, or refused by the model. */
function isUnusableStructuredOutput(error: unknown): boolean {
  return (
    error instanceof StructuredOutputTruncatedError || error instanceof StructuredOutputRefusedError
  );
}

// B0-369: `issues` is an UNSUPPORTED-findings-only channel -- it feeds the revision pass, so a
// confirmation in there asks the revision model to repair a claim that verified fine. Positive
// confirmations go in `supported_claims`, which is trace-only.
export const VALIDATION_JSON_SCHEMA = {
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
 *
 * B0-908 — `claude-*` tags are valid here: the validator call routes by provider, so the row may
 * hold either an OpenAI or an Anthropic tag.
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
  // B0-903 — `resolveModel` rather than `resolveResponsesModel`: an explicit tag resolves exactly
  // as before, and the `preview` tag now follows the `BEX_LLM_PROVIDER` row's per-vendor default.
  if (modelTag) {
    return resolveModel(modelTag);
  }
  return resolveModel(await resolveValidatorModelTag());
}

/** B0-554 — `runValidatorPass`'s result plus the token usage from its one model call. */
export type ValidatorPassResult = ValidatorResult & { usage: LlmTokenUsage };

export async function runValidatorPass(input: {
  draftAnswer: string;
  evidenceSummary: string;
  modelTag?: string;
}): Promise<ValidatorPassResult> {
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
   *
   * B0-908 — the call itself is `completeStructuredWithUsage` (provider-routed, see the module
   * comment). A truncated or refused structured answer is the same unusable payload an unparseable
   * one always was, so it takes the parse-failure path below rather than failing the turn; the
   * `runtime: 'responses'` label on the retry wrapper is a log tag only.
   */
  let completion: CompletionResult;
  try {
    completion = await retryTransportFaults(
      () =>
        completeStructuredWithUsage({
          model,
          system: VALIDATOR_SYSTEM_PROMPT,
          user: JSON.stringify(payload),
          schemaName: 'validation_result',
          schema: VALIDATION_JSON_SCHEMA,
          // B0-606 — the helper omits temperature for models that reject it (gpt-5.5/gpt-5.6/
          // o-series, every Anthropic id). Determinism still matters here, so every model that
          // DOES accept it keeps temperature 0.
          temperature: 0,
          maxOutputTokens: resolveMaxOutputTokens(),
          requestOptions: { maxRetries: 0, timeoutMs: resolveOpenAiRequestTimeoutMs() },
        }),
      { runtime: 'responses', label: 'validator.create' },
    );
  } catch (error) {
    if (isUnusableStructuredOutput(error)) {
      return {
        approved: false,
        confidence: 0,
        issues: ['validator_output_parse_failed'],
        requires_human_review: true,
        usage: ZERO_USAGE,
      };
    }
    throw error;
  }

  // B0-554 — captured before the parse try/catch: the API call itself succeeded either way, so
  // usage is real even on the parse-failure fallback below.
  const usage = completion.usage;

  try {
    const parsed = JSON.parse(completion.text) as unknown;
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
  /**
   * B0-888 — true when this source is the turn's LOCKED product line's own document (per
   * `extractProductLineLockFromToolTrace`), one of the three attribution channels the
   * `compatibility` / `efficacy_claim` key-term fallback accepts. Optional and defaults to
   * "not locked" for every caller that doesn't thread it through (e.g. every pre-existing test
   * fixture in `regulated-claim-guardrail.test.ts`).
   */
  isLockedProductLineSource?: boolean;
};

export type RegulatedClaimGroundingResult = {
  /** Regulated categories with at least one detected claim in the draft. */
  categoriesDetected: RegulatedClaimCategory[];
  /** Detected categories where NO claim could be verified verbatim against any source. */
  ungroundedCategories: RegulatedClaimCategory[];
  /** One entry per ungrounded claim, for the review-task payload. */
  ungroundedDetails: Array<{ category: RegulatedClaimCategory; snippet: string }>;
  /**
   * B0-888 — `compatibility` / `efficacy_claim` categories where at least one sentence was grounded
   * via the KEY-TERM fallback (paraphrase attributed to a source whose body carries the same
   * material/organism term + claim verb) or the adjacent-verbatim-quote exemption, rather than a
   * plain whole-sentence/quoted-span verbatim match. Empty when every grounded sentence in the
   * draft matched verbatim — callers use this to record `groundingMode: 'key_term'` vs `'verbatim'`
   * on the gate record for audit purposes. Never affects `hazard`/`first_aid`/token categories,
   * which have no key-term path and can never appear here.
   */
  keyTermGroundedCategories: RegulatedClaimCategory[];
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

/**
 * Additionally normalizes common unit spellings so "2 oz per gallon" and "2 oz/gal" compare equal.
 * Comparison-only.
 *
 * B0-986 — two contact-time equivalences, COMPARISON ONLY (the displayed answer is never rewritten;
 * `regulated-claim-guardrail.test.ts` asserts the rendered text is byte-identical):
 *  - the `60s` / `600 s` shorthand `renderFacts` (`~/lib/retrieval/product-facts.ts`) historically
 *    wrote for `contact_time_seconds` is read as seconds;
 *  - `N min` ≡ `60·N sec`, so a draft quoting "60 seconds" grounds against a label that prints
 *    "1 minute" and a facts row stored as 60 seconds. This is a unit equivalence inside the
 *    comparator, decided for B0-986; it never changes what the user sees.
 */
export function normalizeUnitToken(value: string): string {
  return normalizeForGroundingCompare(value)
    .replace(/\bounces?\b/g, 'oz')
    .replace(/\bfl\.?\s*oz\.?/g, 'oz')
    .replace(/\bgallons?\b/g, 'gal')
    .replace(/\b(\d+(?:\.\d+)?)\s*s\b/g, '$1 sec')
    .replace(/\bseconds?\b|\bsecs?\b/g, 'sec')
    .replace(/\bminutes?\b|\bmins?\b/g, 'min')
    .replace(/\b(\d+(?:\.\d+)?)\s*min\b/g, (_, n: string) => `${Math.round(Number(n) * 60 * 1000) / 1000} sec`)
    .replace(/\bper\b/g, '/')
    .replace(/[.,]/g, '')
    .replace(/\s*\/\s*/g, '/') // "oz / gal" and "oz/gal" must compare equal
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * B0-971 — abbreviations that end in a period mid-sentence. Without this guard the sentence
 * boundary below split "(EPA Reg. No. 47371-97-4170)" into three "sentences", so a withheld
 * efficacy sentence left the orphan fragment `No. 47371-97-4170)` behind in the answer.
 */
const SENTENCE_ABBREVIATIONS = ['[Rr]eg', '[Nn]o', '[Oo]z', '[Ff]l', '[Mm]in', '[Vv]s', '[Ee]\\.g', '[Ii]\\.e', '[Aa]pprox'];

/**
 * The ONE sentence boundary every regulated-claim path uses: end punctuation, whitespace, then a
 * capital/digit — unless the "sentence" ends in one of `SENTENCE_ABBREVIATIONS`. Exported as a
 * pattern SOURCE (no flags) so `splitIntoSentences` here and
 * `expandRegulatedClaimSnippetToSentence` (`run-product-support-workflow.ts`) build their regexes
 * from the same definition instead of two copies that can drift.
 */
export const REGULATED_CLAIM_SENTENCE_BOUNDARY_SOURCE = `(?<=[.!?])(?<!\\b(?:${SENTENCE_ABBREVIATIONS.join('|')})\\.)\\s+(?=[A-Z0-9])`;

const SENTENCE_SPLIT_PATTERN = new RegExp(`${REGULATED_CLAIM_SENTENCE_BOUNDARY_SOURCE}|\\n+`);

function splitIntoSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_PATTERN)
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
  /\b\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?|s)\b/gi;
const CONTACT_TIME_CONTEXT_PATTERN = /\b(contact|dwell|kill time|wet time|remain wet)\b/i;
/**
 * B0-366: bare `warning` / `caution` / `ppe` are NOT standalone hazard triggers any more --
 * generic safety boilerplate ("wear appropriate PPE", "follow all label warnings") is not a
 * quotable regulated claim. They only count when a GHS token sits in the same sentence (e.g.
 * "Signal word: CAUTION", "Warning: H314"), which is a real transcribed label value.
 */
const HAZARD_SENTENCE_PATTERN =
  /\b(corrosive|flammable|combustible|causes? (severe )?(skin|eye) (burns?|damage|irritation)|\bdanger\b)\b/i;
/**
 * B0-870: bare `hazard` joins `warning` / `caution` / `ppe` as a QUALIFIED trigger. On its own it
 * is topic vocabulary, not a transcribed statement -- "I can provide ... hazard classification ...
 * if needed" is an offer, and "hazard" in a citation line names a document. It only counts next to
 * a GHS token (as B0-366 did for `warning`) or an imperative label precaution ("do not mix",
 * "do not use with"), both of which mark real label/SDS content.
 */
const HAZARD_QUALIFIED_TRIGGER_PATTERN = /\b(hazard|warning|caution|ppe|personal protective)\b/i;
const GHS_CONTEXT_PATTERN =
  /\b(signal word|ghs|pictogram|hazard statements?|precautionary statements?|hazard class(?:es)?\b|transport hazard|h[23]\d{2}|p\d{3})\b/i;
const HAZARD_IMPERATIVE_PATTERN =
  /\b(do not (?:mix|combine|use with)|never mix|keep (?:out of reach|away from)|avoid (?:contact with|breathing|release))\b/i;
/**
 * B0-870: "Non Corrosive" is part of a real product name (Concentrated Non Corrosive Heavy Duty
 * Restroom Cleaner) and "non-flammable" is a safe-direction property, not a hazard statement.
 * Negated hazard adjectives are blanked before the trigger test so the product name alone can't
 * pull a sentence into the hazard category. Comparison/detection only -- never applied to text
 * shown to the user.
 */
const HAZARD_NEGATED_TRIGGER_PATTERN = /\bnon[-\s]?(?:corrosive|flammable|combustible|hazardous)\b/gi;
const FIRST_AID_SENTENCE_PATTERN =
  /\bfirst aid\b|\bif swallowed\b|\bif inhaled\b|\bif in eyes\b|\bif on skin\b|\bpoison control\b/i;

/**
 * B0-915 — completes the B0-870 offer/pointer exclusion for `hazard` / `first_aid`. Three classes
 * of Bex's OWN meta-commentary were still being classified as regulated claims; because prose Bex
 * wrote about itself can never be verified verbatim against a retrieved label, every one of them
 * escalated the guardrail to `redactionMode: decline` and replaced the whole answer with refusal
 * copy. All four snippets below are live `ungroundedDetails` entries from five eval runs (the
 * first-aid emergency case fired on BOTH answering vendors, so it is not model-specific):
 *
 *  1. OFFER to retrieve content -- "I can supply the current Push SDS content instead - hazard
 *     identification (Section 2), first aid (Section 4), ...". B0-870's `META_OFFER_PATTERN` misses
 *     it: the verb "supply" is not in its list, and the sentence is a MENU of SDS sections.
 *  2. POINTER to the product's own label/SDS as the governing source -- "the governing PPE and
 *     ventilation instructions are the product label's precautionary statements and SDS Section 8
 *     ... follow those over any general guidance". This is the safest possible answer; the guardrail
 *     declined it because "PPE" co-occurred with the words "precautionary statements".
 *  3. GENERIC safety / training / emergency prose transcribing no label value -- "proper dilution,
 *     PPE use, never mix chemicals, clear written SOPs" and "evacuate and ventilate the area, then
 *     call Poison Control ... with the label and SDS in hand".
 *
 * Same spirit as B0-870: bare `hazard`/`warning`/`caution`/`ppe` plus a topic noun is vocabulary,
 * not a transcribed statement. The exclusion is hard-gated by `carriesTranscribedLabelValue` --
 * anything carrying an actual label value is never excluded, however much offer/pointer framing
 * surrounds it. Detection only; verbatim matching itself is untouched.
 */
const RETRIEVAL_OFFER_PATTERN =
  /\b(?:i|we)(?:'d| would| can| could| am able to| are able to| will)(?: be (?:happy|glad) to| also)? (?:supply|surface|offer|fetch|quote|read out|show|provide|share|pull(?: up)?|look up|retrieve|summari[sz]e|list|give|send)\b/i;
/** Two or more "(Section N)" references in one sentence = an index of what could be fetched. */
const SDS_SECTION_REFERENCE_PATTERN = /\bsections?\s*\d{1,2}\b/gi;
/** Mentions the product's own label/SDS (or one of its sections) as a place content lives. */
const LABEL_SOURCE_MENTION_PATTERN =
  /\b(?:label|labels|labelled|labeled|sds|safety data sheet|section\s*\d{1,2})\b/i;
/** Defers to that source rather than asserting a value ("governing ...", "follow those"). */
const SOURCE_DEFERENCE_PATTERN =
  /\b(?:refer to|see the|consult|check the|review the|read the|defer to|rely on|govern(?:s|ing|ed)?|takes? precedence|authoritative|final (?:word|authority|say)|source of truth|in hand|over any general guidance|always follow|follow (?:those|these|them|it|the label|the sds|your))\b/i;
/** Generic safety/training prose ("Train for safety ... clear written SOPs"), not a label line. */
const GENERIC_SAFETY_ADVICE_PATTERN =
  /\b(?:train(?:s|ed|ing)?|sops?|standard operating procedures?|best practices?|good practice|general (?:guidance|rule|practice|safety|housekeeping)|as a general|written procedures?|policies|policy)\b/i;
/** Generic emergency referral -- points at outside help, transcribes nothing off the label. */
const EMERGENCY_REFERRAL_PATTERN =
  /\b(?:poison control|poison cent(?:er|re)|emergency services|emergency responders|911|seek medical|medical attention|call (?:a|your) (?:physician|doctor))\b/i;
/**
 * The object that separates a real label precaution from generic safety advice: "Do not mix with
 * chlorinated products" / "Keep away from heat, sparks and open flame" name a specific
 * incompatibility or ignition source off the label, while "never mix chemicals" names nothing.
 */
const PRECAUTION_OBJECT_PATTERN =
  /\b(?:chlorinat\w*|bleach|hypochlorite|ammonia|acids?|alkalis?|caustics?|oxidi[sz]\w*|peroxide|quats?|solvents?|heat|sparks?|open flame|flames?|ignition|reach of children|food|drink|eyes?|skin|clothing|drains?)\b/i;
/**
 * GHS tokens that carry (or immediately precede) a transcribed VALUE, as opposed to the bare
 * category nouns in `GHS_CONTEXT_PATTERN` ("hazard statements", "precautionary statements", "GHS")
 * which name a label section the way a table of contents does. Deliberately keeps "hazard
 * class(es)"/"transport hazard" -- SDS section 14 lines are real transcriptions (B0-366).
 */
const GHS_VALUE_TOKEN_PATTERN =
  /\b(?:signal word|pictogram|hazard class(?:es)?\b|transport hazard|h[23]\d{2}|p\d{3})\b/i;
/**
 * B0-915 review — a prescribed medical/treatment ACTION, which is regulated first-aid content even
 * when it rides along with a generic referral. Without this, `EMERGENCY_REFERRAL_PATTERN` excluded
 * the whole sentence on the words "Poison Control" alone, so "call Poison Control and administer
 * 2 oz of activated charcoal" escaped a category that detected it before B0-915: the fabricated
 * action names no exposure route, so `FIRST_AID_PROCEDURE_PATTERN` misses it, and "2 oz" with no
 * "/gal" is not a dilution token either. Referral wording must never buy an unverified instruction.
 */
const TREATMENT_DIRECTIVE_PATTERN =
  /\b(?:administer|activated charcoal|antidote|neutrali[sz]\w*|dosage|\bdose\b|ipecac|emetic|ointment|salve|antiseptic|epinephrine|atropine|inducing vomiting|do not induce)\b/i;
/** Real SDS section 4 content: an exposure route or an actual first-aid procedure. */
const FIRST_AID_PROCEDURE_PATTERN =
  /\b(?:if swallowed|if inhaled|if in eyes|if on skin|in case of (?:contact|ingestion|inhalation|exposure)|after (?:contact|inhalation|ingestion)|rinse|rinsing|flush|irrigate|induce vomiting|remove contact lenses|give (?:water|milk|oxygen)|artificial respiration|fresh air|wash with (?:soap|water)|for (?:at least )?\d+\s*(?:minutes?|mins?)\b)/i;

/**
 * B0-915 — the hard gate on the offer/pointer/generic exclusion below. Returns true when the
 * sentence carries something that IS transcribed regulated content: an explicit hazard statement
 * ("corrosive", "causes severe skin burns", "DANGER"), a value-bearing GHS token (signal word,
 * H/P-code, transport hazard class), a product-specific imperative precaution ("do not mix with
 * chlorinated products") or a real first-aid route/procedure ("IF IN EYES: rinse cautiously ...").
 * Any of those and the sentence stays a regulated claim requiring verbatim grounding.
 */
function carriesTranscribedLabelValue(sentence: string): boolean {
  // Negated hazard adjectives are blanked first for the same reason as B0-870: "Non Corrosive" is
  // part of a product name and "non-flammable" is a safe-direction property.
  const text = sentence.replace(HAZARD_NEGATED_TRIGGER_PATTERN, ' ');
  if (HAZARD_SENTENCE_PATTERN.test(text)) return true;
  if (GHS_VALUE_TOKEN_PATTERN.test(text)) return true;
  if (HAZARD_IMPERATIVE_PATTERN.test(text) && PRECAUTION_OBJECT_PATTERN.test(text)) return true;
  if (TREATMENT_DIRECTIVE_PATTERN.test(text)) return true;
  return FIRST_AID_PROCEDURE_PATTERN.test(text);
}

/**
 * B0-915 — true when the sentence is Bex talking ABOUT label/SDS content rather than transcribing
 * it: an offer to retrieve it, a menu of SDS sections, a pointer deferring to the product's own
 * label/SDS, or generic safety/training/emergency prose. Gated by `carriesTranscribedLabelValue`,
 * so a sentence carrying a real label value is never excluded. Applied to `hazard`/`first_aid`
 * only -- the token categories and `compatibility`/`efficacy_claim` do not consult it.
 */
function isMetaOrPointerSafetySentence(sentence: string): boolean {
  const text = stripSentenceMarkup(sentence);
  if (carriesTranscribedLabelValue(text)) return false;

  if (RETRIEVAL_OFFER_PATTERN.test(text)) return true;
  if (Array.from(text.matchAll(SDS_SECTION_REFERENCE_PATTERN)).length >= 2) return true;
  if (LABEL_SOURCE_MENTION_PATTERN.test(text) && SOURCE_DEFERENCE_PATTERN.test(text)) return true;
  return GENERIC_SAFETY_ADVICE_PATTERN.test(text) || EMERGENCY_REFERRAL_PATTERN.test(text);
}

/**
 * B0-928 — a comparison between two GENERIC chemistry/material classes is not a transcribed hazard
 * statement. Live `ungroundedDetails` snippet (golden set, 2026-09-10, app_version 4.4.0):
 * "Solvent-based oil-modified urethanes are described as flammable, higher-VOC coatings with
 * fumes/odors; water-based coatings are described as nonflammable, low-odor, and low-VOC."
 * `HAZARD_NEGATED_TRIGGER_PATTERN` already blanks "nonflammable", but the bare adjective
 * "flammable" on the other side of the contrast still matched `HAZARD_SENTENCE_PATTERN`, so the
 * sentence became a `hazard` claim that no label can ground verbatim — and one ungrounded `hazard`
 * sentence replaces the whole answer with the decline copy. It names no product (that run had
 * `lockedProductLineKey: null`); it contrasts two coating chemistries, which is exactly what the
 * golden answer asks for.
 *
 * The load-bearing constraint is TWO DISTINCT class terms, at least one of them a CHEMISTRY class:
 * a real GHS hazard statement transcribed off one product's label does not contrast two generic
 * classes, and requiring a chemistry term stops two bare form nouns ("the sealer and the coating
 * are corrosive") from buying the exclusion. Hard-gated the same way B0-915
 * gated its exclusion — a value-bearing GHS token (signal word, pictogram, hazard class, H/P code),
 * a product-specific imperative precaution (imperative + a named incompatibility/ignition source),
 * or real first-aid/treatment content anywhere in the sentence and the exclusion does not apply.
 * `hazard` only: `first_aid`, the token categories and `compatibility`/`efficacy_claim` never
 * consult it. Detection only; verbatim matching itself is untouched.
 */
/**
 * A CHEMISTRY class -- what the product is made of. At least one of these must be present: it is
 * what makes the sentence a statement about a class of chemistry rather than about a thing.
 */
const GENERIC_CHEMISTRY_CLASS_PATTERNS: readonly RegExp[] = [
  /\b(?:water[-\s]?based|water[-\s]?borne|waterborne)\b/i,
  /\b(?:solvent[-\s]?based|solvent[-\s]?borne|solventborne)\b/i,
  /\boil[-\s]?(?:based|modified)\b/i,
  /\bacid[-\s]?based\b/i,
  /\bchlorine[-\s]?based\b/i,
  /\bquats?\b|\bquaternar(?:y|ies)\b/i,
  /\benzyme[-\s]?based\b|\bprobiotics?\b/i,
  /\b(?:poly)?urethanes?\b/i,
];
/**
 * A PRODUCT-FORM class -- what kind of thing it is. On its own this is just a noun ("the sealer is
 * corrosive" is a hazard claim about a specific thing), so a form term only ever counts towards the
 * two-term total ALONGSIDE a chemistry term above; two form terms never qualify a sentence.
 */
const GENERIC_PRODUCT_FORM_CLASS_PATTERNS: readonly RegExp[] = [
  /\bcoatings?\b/i,
  /\bfinish(?:es)?\b/i,
  /\bsealers?\b/i,
  /\bchemistr(?:y|ies)\b/i,
  /\bformulations?\b/i,
  // B0-998 — a water-vs-solvent VOC comparison written as two separate sentences ("Solvent-based
  // cleaners contain higher VOCs and are flammable." / "Water-based cleaners are non-flammable and
  // low-VOC.") only carries ONE chemistry-class term per sentence, so without a form term to pair it
  // with, each sentence fell one short of the two-term threshold and the "flammable" sentence was
  // classified as a product SDS hazard statement instead of a generic type-level comparison. Every
  // other form noun here names a floor-coatings concept; "cleaner" was the one product-form noun
  // missing for this same comparison in the cleaning-chemistry (not floor-finish) product family.
  /\bcleaners?\b/i,
];

function countDistinctMatches(text: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((count, pattern) => (pattern.test(text) ? count + 1 : count), 0);
}

function isGenericMaterialClassComparison(sentence: string): boolean {
  const text = stripSentenceMarkup(sentence);
  if (GHS_VALUE_TOKEN_PATTERN.test(text)) return false;
  if (HAZARD_IMPERATIVE_PATTERN.test(text) && PRECAUTION_OBJECT_PATTERN.test(text)) return false;
  if (FIRST_AID_PROCEDURE_PATTERN.test(text) || TREATMENT_DIRECTIVE_PATTERN.test(text)) return false;

  const chemistryClasses = countDistinctMatches(text, GENERIC_CHEMISTRY_CLASS_PATTERNS);
  if (chemistryClasses === 0) return false;
  return chemistryClasses + countDistinctMatches(text, GENERIC_PRODUCT_FORM_CLASS_PATTERNS) >= 2;
}

/** A markdown list-item body line: "- ...", "* ...", "• ...", or a numbered sub-item ("1. ..."). */
const BULLET_ITEM_PREFIX_PATTERN = /^\s*(?:[-*•]\s+|\d{1,2}[.)]\s+)/;

function isBulletSubItem(sentence: string): boolean {
  return BULLET_ITEM_PREFIX_PATTERN.test(sentence);
}

/** A bullet HEADER line: markdown emphasis/heading markers stripped, text ends in a colon. */
function isBulletHeaderLine(sentence: string): boolean {
  return /:\s*$/.test(stripSentenceMarkup(sentence));
}

/**
 * B0-1052 — a markdown sub-bullet inherits its immediately preceding bullet-header's chemistry-class
 * context for the purposes of `isGenericMaterialClassComparison`. `splitIntoSentences` treats the
 * newline between a bold bullet header ("**Solvent-based (oil-modified) finishes:**") and its body
 * ("- Higher VOCs and stronger odor; some are flammable, requiring special handling and
 * ventilation.") as a sentence boundary, so the chemistry-class term that would make this a generic
 * class comparison (not a product-specific SDS statement) sits one "sentence" away from the hazard
 * trigger, and `isGenericMaterialClassComparison(sentence)` alone never sees it.
 *
 * Deliberately narrow so this cannot widen the exclusion to ordinary multi-sentence paragraphs:
 *  - only applies when the flagged sentence is itself a list sub-item (a hazard sentence that
 *    follows unrelated prose, not a bullet body, is untouched);
 *  - only applies when the sentence carries ZERO chemistry-class terms of its own -- if it already
 *    had one, `isGenericMaterialClassComparison(sentence)` would already have excluded it, so this
 *    path only ever ADDS context, it never overrides a decision the base function already made;
 *  - only applies when the preceding line reads as a header (ends in a colon) that itself names a
 *    chemistry class.
 * The combined text is still run through the SAME hard gates as `isGenericMaterialClassComparison`
 * (GHS value tokens, product-specific imperative + named object, first-aid/treatment content), so a
 * genuine product-specific hazard or first-aid statement in a sub-bullet is never excused just
 * because some earlier header happens to name a chemistry class.
 */
function isSubBulletOfChemistryHeader(sentence: string, precedingSentence: string | undefined): boolean {
  if (!precedingSentence) return false;
  if (!isBulletSubItem(sentence)) return false;
  if (countDistinctMatches(stripSentenceMarkup(sentence), GENERIC_CHEMISTRY_CLASS_PATTERNS) > 0) {
    return false;
  }
  if (!isBulletHeaderLine(precedingSentence)) return false;
  if (countDistinctMatches(stripSentenceMarkup(precedingSentence), GENERIC_CHEMISTRY_CLASS_PATTERNS) === 0) {
    return false;
  }
  return isGenericMaterialClassComparison(`${precedingSentence} ${sentence}`);
}

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
/**
 * B0-869: `approved` always needs its object now. The B0-756 form `approved (?:surface|for use)?
 * (?: on| for)?` made every group optional, so the bare word matched and "an approved wood floor
 * cleaner" / "both methods are approved" became compatibility claims. The negative forms B0-756
 * listed here ("not recommended for", "should not be used on", "not compatible with") moved to
 * `COMPATIBILITY_CONSERVATIVE_PATTERN` below -- they are still recognised, but as warnings that
 * are allowed through unverified rather than as claims that must be quoted.
 */
const COMPATIBILITY_CLAIM_PATTERN =
  /\b(safe (?:for|to use on|on)|approved (?:surface|for(?: use)?(?: on| with)?|on)\b|compatible with|will not (?:damage|harm|etch|dull|corrode|discolor|degrade|pit|haze)|suitable for use on|can be used on|recommended for use on|labeled for use on|labelled for use on)\b/i;
/**
 * B0-869: a negated or hedged compatibility statement ("not specifically labeled for use on
 * stainless steel", "not recommended for linoleum", "not an approved application") tells the user
 * NOT to do something. A wrong one costs a use case, not a damaged surface, so it is the
 * conservative direction and is let through without the verbatim-quote requirement. `will not
 * damage/etch/...` is deliberately NOT here -- that is a positive safety claim phrased negatively
 * and stays in `COMPATIBILITY_CLAIM_PATTERN`. "not only/just/merely ..." is an intensifier, not a
 * negation, and is excluded so "not only safe on stainless steel" stays a claim.
 */
const COMPATIBILITY_CONSERVATIVE_PATTERN =
  /\b(?:not|never|isn't|aren't|cannot|can't)\s+(?!(?:only|just|merely)\b)(?:[\w-]+\s+){0,3}(?:labeled|labelled|approved|recommended|safe|suitable|intended|compatible|listed|cleared|rated|designed)\b|\bshould not be used on\b|\bdo not use (?:[\w-]+\s+){0,2}on\b|\bnot for use on\b/i;

/**
 * B0-868 / B0-869: the product-subject heuristic both sentence categories share. The guardrail's
 * input is `{ draftAnswer, sources }` only -- the workflow's product lock never reaches it -- so
 * "is a named product the subject of this sentence" has to be read off the sentence itself:
 *
 *  - a product-code token (pH7Q, AF79, GE1 -- same shape `run-product-support-workflow.ts` uses);
 *  - an explicit self-reference ("this product", "the standard formula", "our disinfectant");
 *  - a sentence-initial capitalised name followed by a copula/modal ("Push is safe on ...",
 *    "Game Time is ..."), excluding pronouns, determiners, imperative verbs and generic process /
 *    product-class nouns ("It is ...", "Disinfecting kills ...", "Disinfectants are ...");
 *  - a mid-sentence Capitalised mixed-case word ("... such as Squeaky ...", "Neutral pH
 *    Disinfectant: ..."), excluding the bare brand names and all-caps acronyms (VCT, EPA, MRSA).
 *
 * Imperative or generic advice ("Ensure all cleaning products are approved for sealed wood
 * floors", "Use only products labeled for use on ...") has none of these and is not a claim about
 * a product. Detection only -- nothing here alters displayed text.
 */
const PRODUCT_CODE_TOKEN_PATTERN = /\b[A-Za-z]{1,4}\d{1,4}[A-Za-z]?\b/;
const PRODUCT_SELF_REFERENCE_PATTERN =
  /\b(?:this|our|its) (?:[\w-]+ ){0,2}(?:product|formula|formulation|disinfectant|sanitizer|cleaner|concentrate|finish|sealer|stripper|solution)\b|\bthe (?:[\w-]+ ){0,2}(?:product|formula|formulation)\b/i;
const SENTENCE_INITIAL_SUBJECT_PATTERN =
  /^([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\s+(?:is|are|was|were|can|may|will|should|has|have|remains?)\b/;
const SENTENCE_INITIAL_NON_PRODUCT_WORDS = new Set([
  'it', 'this', 'that', 'these', 'those', 'they', 'there', 'here', 'both', 'all', 'each', 'which',
  'what', 'who', 'the', 'a', 'an', 'our', 'your', 'its', 'their', 'most', 'many', 'several', 'some', 'none',
  'no', 'products', 'product', 'chemicals', 'disinfectants', 'sanitizers', 'cleaners', 'quats',
  'disinfection', 'sanitization', 'sterilization',
]);
// B0-984 — a capitalised word right after a colon or dash ("General guidance: Use only…",
// "Step 1 — Apply…") is the start of a clause, not a mid-sentence product name.
const MID_SENTENCE_CAPITALISED_WORD_PATTERN = /(?<=\s)(?<![:\-–—]\s)[A-Z][a-z][\w'-]*/g;
const BRAND_ONLY_TOKENS = new Set(['betco', 'envirozyme']);
const BULLET_HEAD_PRODUCT_SUBJECT_PATTERN = /^(?:[Tt]he\s+)?([A-Z0-9][^:—–]{1,80}?)\s*(?::|—|–)/;

/**
 * B0-888 — a leading label word ("Caveat:", "Note:", "Important:", "Tip:") is scaffolding, not a
 * product name, but stripping the label pushes whatever comes next (often an imperative verb like
 * "Always"/"Confirm") into a position `MID_SENTENCE_CAPITALISED_WORD_PATTERN` treats as a possible
 * mid-sentence product name (e.g. "... such as Squeaky ..."). At the true start of a sentence that
 * same word is already excluded (the pattern requires a PRECEDING whitespace); a label prefix is
 * the only thing that artificially creates one. Stripped before every `hasProductSubject` check.
 */
const LABEL_PREFIX_PATTERN =
  /^(?:caveat|note|important|tip|general guidance|guidance|recommendation|best practice|rule of thumb)\s*:\s*/i;
/**
 * B0-888 — imperative openers that read as generic advice/disclaimers, not a claim about a named
 * product, when they are the sentence's true first word (post label-prefix stripping). Reuses the
 * same exclusion spirit as `SENTENCE_INITIAL_NON_PRODUCT_WORDS` (which this set is checked
 * alongside, never instead of).
 */
const IMPERATIVE_OPENER_WORDS = new Set([
  'always', 'never', 'confirm', 'ensure', 'test', 'verify', 'check', 'avoid', 'consult', 'review',
  // B0-984 — "General guidance: Use only low tack painter's tape…" read as a claim about "Use".
  'use', 'apply', 'keep', 'remove', 'follow', 'start', 'step', 'do', 'clean', 'wipe', 'rinse',
]);

/** Case-preserving twin of the `base` prep in `isNonClaimScaffolding` (emphasis, bullets, headings). */
function stripSentenceMarkup(sentence: string): string {
  return sentence
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:#{1,6}\s*)+/, '')
    .replace(/^(?:[-–—•>+]\s+|\d{1,2}[.)]\s+)+/, '')
    .trim();
}

function hasProductSubject(sentence: string): boolean {
  let text = stripSentenceMarkup(sentence);

  // B0-888 — strip a leading label so the word right after it is judged as the sentence's true
  // first token; short-circuit to "no product subject" when that word is generic/imperative
  // advice rather than a name (e.g. "Caveat: Always confirm mats are compatible with wood
  // floors..." is a disclaimer, not a claim about a product called "Always").
  const labelMatch = LABEL_PREFIX_PATTERN.exec(text);
  if (labelMatch) {
    text = text.slice(labelMatch[0].length);
    const firstWord = text.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g, '') ?? '';
    if (SENTENCE_INITIAL_NON_PRODUCT_WORDS.has(firstWord) || IMPERATIVE_OPENER_WORDS.has(firstWord)) {
      return false;
    }
  }

  if (PRODUCT_CODE_TOKEN_PATTERN.test(text)) return true;
  if (PRODUCT_SELF_REFERENCE_PATTERN.test(text)) return true;
  // Bullet-style product heads ("Quat-Stat 5: ...", "Rest Stop: ...") are explicit product subjects.
  const bulletHead = BULLET_HEAD_PRODUCT_SUBJECT_PATTERN.exec(text)?.[1];
  if (bulletHead) {
    const normalizedHead = normalizeProductNameForCompare(bulletHead);
    const firstWord = normalizedHead.split(' ')[0] ?? '';
    if (
      normalizedHead.length >= 3 &&
      !SENTENCE_INITIAL_NON_PRODUCT_WORDS.has(firstWord) &&
      !IMPERATIVE_OPENER_WORDS.has(firstWord) &&
      !BRAND_ONLY_TOKENS.has(firstWord)
    ) {
      return true;
    }
  }

  const initial = SENTENCE_INITIAL_SUBJECT_PATTERN.exec(text);
  if (initial) {
    const firstWord = initial[1].split(/\s+/)[0].toLowerCase();
    // Gerund subjects ("Cleaning removes", "Disinfecting kills") are processes, not products.
    if (
      !SENTENCE_INITIAL_NON_PRODUCT_WORDS.has(firstWord) &&
      !BRAND_ONLY_TOKENS.has(firstWord) &&
      !firstWord.endsWith('ing')
    ) {
      return true;
    }
  }

  for (const match of text.matchAll(MID_SENTENCE_CAPITALISED_WORD_PATTERN)) {
    const normalized = match[0].toLowerCase().replace(/[’']/g, "'").replace(/['’]s$/, '');
    if (!BRAND_ONLY_TOKENS.has(normalized)) return true;
  }
  return false;
}

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
 *
 * B0-868: split into two parts. `EFFICACY_STRONG_PATTERN` is claim vocabulary on its own
 * (-cidal, log reduction, "99.9% of germs"). `EFFICACY_VERB_PATTERN` (kills, eliminates, effective
 * against) is only a claim when an organism/pathogen noun sits in the same sentence AND the
 * sentence is about a product -- either the verb opens the sentence label-style ("Kills MRSA in
 * 30 seconds.") or `hasProductSubject` finds a named product. The unqualified B0-756 form fired on
 * "eliminate guesswork", "does not kill germs" (a textbook definition) and "regulatory requirements
 * for pathogen kill", replacing whole knowledge-base answers with the canned decline.
 */
const EFFICACY_STRONG_PATTERN =
  /\b(bactericidal|virucidal|fungicidal|sporicidal|tuberculocidal|\d[\s-]*log reduction|log[\s-]*\d+ reduction|\d+(?:\.\d+)?\s*(?:%|percent)\s*(?:of\s+)?(?:bacteria|viruses|virus|germs|pathogens|microorganisms|microbes)\b)/i;
const EFFICACY_VERB_PATTERN =
  /\b(kills?|killing|kill claims?|eliminat(?:es?|ing)|effective against|efficacy against|inactivat(?:es?|ing)|destroys?)\b/i;
const EFFICACY_SENTENCE_INITIAL_VERB_PATTERN =
  /^(?:kills?|eliminates?|effective against|inactivates?|destroys?)\b/i;
const EFFICACY_ORGANISM_PATTERN =
  /\b(norovirus|hiv(?:-1)?|sars[-\s]?cov[-\s]?2|covid(?:-19)?|coronavirus|ebola|mrsa|vre|influenza|h1n1|rhinovirus|rotavirus|adenovirus|hepatitis|hbv|hcv|bacteri(?:a|um|al)|virus(?:es)?|viral|pathogens?|germs?|spores?|fungi|fungus|fungal|mold|mould|mildew|tuberculosis|mycobacterium|e\.?\s?coli|escherichia|salmonella|staph\w*|pseudomonas|listeria|c\.?\s?diff(?:icile)?|clostridi\w*|candida|enterococcus|klebsiella|legionella|streptococcus|trichophyton|micro-?organisms?|microbes?|organisms?)\b/i;
/**
 * B0-868: "does not kill", "is not intended to kill", "may not meet their kill claims", "not
 * effective against" -- negated forms tell the user what a product or process does NOT do. They
 * are conservative statements, not registered efficacy claims, and pass through unverified.
 */
const EFFICACY_NEGATED_PATTERN =
  /\b(?:not|never|cannot|can't|won't|doesn't|don't|isn't|aren't|no)\s+(?!(?:only|just|merely)\b)(?:[\w-]+\s+){0,3}(?:kills?|killing|eliminat\w*|effective|efficacy|inactivat\w*|destroy\w*|meet|meets|claim|claims)\b/i;

/**
 * B0-870: citation lines ("Source: ...", "[doc:...]") name documents and assert nothing; first-
 * person offers ("I can provide the SDS hazard classification ... if needed") announce what Bex
 * COULD say. Neither can ever be a verbatim label quote, so requiring one is a false positive by
 * construction. Anchored at the sentence start on purpose -- a bare "if needed" inside a real
 * first-aid instruction ("... seek medical attention if needed") must still be verified.
 */
const CITATION_LINE_PATTERN = /^(?:\(?sources?:|\[doc:)/i;
const META_OFFER_PATTERN =
  /^(?:(?:i|we)(?:'d| would| can| could| am able to| are able to| will)(?: be (?:happy|glad) to| also)? (?:provide|share|pull(?: up)?|look up|retrieve|summari[sz]e|list|give|send|check|help|walk)\b|let me know if\b|would you like me to\b|if (?:needed|you(?:'d| would) like),? i can\b)/i;

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
  // B0-870: citation line or a first-person offer -- names documents / announces an option.
  if (CITATION_LINE_PATTERN.test(base) || META_OFFER_PATTERN.test(base)) return true;
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

function isHazardClaimSentence(sentence: string, precedingSentence?: string): boolean {
  // B0-915: an offer/pointer/generic-safety sentence is not a transcribed hazard statement.
  if (isMetaOrPointerSafetySentence(sentence)) return false;
  // B0-928: a contrast between two generic chemistry classes is not a transcribed hazard statement.
  if (isGenericMaterialClassComparison(sentence)) return false;
  // B0-1052: a bullet sub-item with no chemistry-class term of its own borrows the chemistry-class
  // context from its immediately preceding bullet-header line before this is judged a hazard claim.
  if (isSubBulletOfChemistryHeader(sentence, precedingSentence)) return false;
  // B0-870: "Non Corrosive" (a product name) / "non-flammable" are not hazard statements.
  const text = sentence.replace(HAZARD_NEGATED_TRIGGER_PATTERN, ' ');
  if (HAZARD_SENTENCE_PATTERN.test(text)) return true;
  // B0-928: the imperative half of this disjunction now needs the same `PRECAUTION_OBJECT_PATTERN`
  // that `carriesTranscribedLabelValue` requires of it. Without the object the two functions
  // disagreed about the same imperative: "Wear the PPE required by each product label/SDS ... and
  // never mix chemicals" was ungroundable safe-work boilerplate to one and a transcribed GHS
  // statement to the other, and the hazard classification won and declined the whole answer.
  // "never mix chemicals" names no incompatibility; "do not mix with chlorinated products" does.
  return (
    HAZARD_QUALIFIED_TRIGGER_PATTERN.test(text) &&
    (GHS_CONTEXT_PATTERN.test(text) ||
      (HAZARD_IMPERATIVE_PATTERN.test(text) && PRECAUTION_OBJECT_PATTERN.test(text)))
  );
}

function isFirstAidClaimSentence(sentence: string): boolean {
  // B0-915: same offer/pointer/generic-safety exclusion as the hazard category.
  if (isMetaOrPointerSafetySentence(sentence)) return false;
  return FIRST_AID_SENTENCE_PATTERN.test(sentence);
}

/**
 * B0-869: a compatibility claim needs a material noun, a positive claim verb AND a product subject
 * in the same sentence. Negated/hedged statements are conservative and never claims.
 */
function isCompatibilityClaimSentence(sentence: string): boolean {
  if (!COMPATIBILITY_MATERIAL_PATTERN.test(sentence)) return false;
  if (!COMPATIBILITY_CLAIM_PATTERN.test(sentence)) return false;
  if (COMPATIBILITY_CONSERVATIVE_PATTERN.test(sentence)) return false;
  return hasProductSubject(sentence);
}

/** B0-868: see the `EFFICACY_*` pattern comments for the two-part structure. */
function isEfficacyClaimSentence(sentence: string): boolean {
  if (EFFICACY_NEGATED_PATTERN.test(sentence)) return false;
  if (EFFICACY_STRONG_PATTERN.test(sentence)) return true;
  if (!EFFICACY_VERB_PATTERN.test(sentence)) return false;
  if (!EFFICACY_ORGANISM_PATTERN.test(sentence)) return false;
  return (
    EFFICACY_SENTENCE_INITIAL_VERB_PATTERN.test(stripSentenceMarkup(sentence)) ||
    hasProductSubject(sentence)
  );
}

function isTokenGrounded(token: string, normalizedSources: string[]): boolean {
  const normalized = normalizeUnitToken(token);
  if (!normalized) return false;
  return normalizedSources.some((body) => body.includes(normalized));
}

/**
 * B0-870: a quoted span the model attributed to a document ('The label states: "Contains acids, do
 * not use with bleach, ammonia or any other chemicals."'). The regulated content is the quote; the
 * attribution and any trailing "(Source: ...)" are Bex's framing and can never appear verbatim in
 * the source, so the whole-sentence compare fails on a correctly transcribed line. Short quotes
 * (a single word like "Danger") are not enough to ground a sentence on their own.
 */
const QUOTED_SPAN_PATTERN = /["“”]([^"“”]{24,})["“”]/g;

function isSentenceGrounded(
  sentence: string,
  normalizedSources: string[],
  isClaimTrigger?: (sentence: string) => boolean,
): boolean {
  const normalized = normalizeSentenceForGroundingCompare(sentence);
  if (!normalized) return false;
  if (normalizedSources.some((body) => body.includes(normalized))) return true;

  // B0-870: fall back to the quoted span, provided the framing left outside the quotes is not a
  // claim in its own right (so a fabricated tail can't ride along on a genuine quote).
  const quotedSpans = Array.from(sentence.matchAll(QUOTED_SPAN_PATTERN), (m) => m[1]);
  if (quotedSpans.length === 0) return false;
  const framing = sentence.replace(QUOTED_SPAN_PATTERN, ' ');
  if (isClaimTrigger && isClaimTrigger(framing) && !isNonClaimScaffolding(framing)) return false;
  return quotedSpans.every((span) => {
    const normalizedSpan = normalizeSentenceForGroundingCompare(span);
    return normalizedSpan.length > 0 && normalizedSources.some((body) => body.includes(normalizedSpan));
  });
}

/**
 * B0-888 — categories with a KEY-TERM fallback grounding path (below), on top of the plain
 * verbatim/quoted-span match every category gets from `isSentenceGrounded`. Deliberately just
 * these two: `hazard`/`first_aid` and every token category (`epa_registration`, `din_registration`,
 * `dilution_ratio`, `contact_time`, `cas_number`) stay exact/verbatim, no exceptions -- weakening
 * those would violate the org's regulated-data rule.
 */
const KEY_TERM_FALLBACK_CATEGORIES: ReadonlySet<RegulatedClaimCategory> = new Set<
  RegulatedClaimCategory
>(['compatibility', 'efficacy_claim']);

/** An explicit `[doc:<id>]` marker, or its per-product-line batch form `[doc:<id>:<key>]`. */
const DOC_CITATION_PATTERN = /\[doc:([^\]]+)\]/gi;
/** "per the X label", "according to the X SDS", "as stated on/in the X label/profile/sheet". */
const PER_LABEL_ATTRIBUTION_PATTERN =
  /\b(?:per|according to|as (?:stated|noted|indicated) (?:on|in))\s+the\s+([a-z0-9][\w'&-]*(?:\s+[a-z0-9][\w'&-]*){0,4})\s+(?:label|sds|profile|sheet)\b/i;
/**
 * B0-971 — "the label (explicitly) states …", "its product line profile says …", "the SDS lists …",
 * "the guidance shows …". Names a source KIND but not a product, so it only attributes together
 * with the product named at the head of the bullet (see `bulletHeadProductName`).
 */
const SOURCE_ASSERTION_ATTRIBUTION_PATTERN =
  /\b(?:the|its|this)\s+(?:product(?:'s)?\s+)?(?:(?:product\s+)?line\s+)?(?:label|sds|safety data sheet|profile|sheet|guidance|efficacy data)\s+(?:\w+\s+){0,2}?(?:states?|says?|lists?|shows?|confirms?|indicates?|notes?|specif(?:y|ies))\b/i;
/**
 * B0-971 — the product a list bullet is ABOUT: "Rest Stop™: The label states …",
 * "CIDE-BET FRESH & CLEAN (Hospital disinfectant): The product line profile states …",
 * "The 5 Minute Alkaline Disinfectant is also labeled …". Runs on the markup-stripped sentence.
 */
const BULLET_HEAD_PRODUCT_PATTERN = /^(?:[Tt]he\s+)?([A-Z0-9][^:—–]{1,80}?)\s*(?::|—|–|\s+(?:is|are|has|was|were)\b)/;

/** Lowercase, no trademark glyphs/emphasis, single-spaced — for title ↔ bullet-head comparisons only. */
function normalizeProductNameForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[™®©*_`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s:;,.]+$/, '')
    .trim();
}

/**
 * B0-971 — the normalised product name at the head of a bullet-shaped sentence, or null when the
 * sentence does not open with one (pronoun/determiner heads such as "This product is …" and
 * "These products are …" are excluded, exactly as `hasProductSubject` excludes them).
 */
export function bulletHeadProductName(sentence: string): string | null {
  const match = BULLET_HEAD_PRODUCT_PATTERN.exec(stripSentenceMarkup(sentence));
  if (!match?.[1]) return null;
  const head = normalizeProductNameForCompare(match[1]);
  if (head.length < 3) return null;
  const firstWord = head.split(' ')[0] ?? '';
  if (SENTENCE_INITIAL_NON_PRODUCT_WORDS.has(firstWord) || IMPERATIVE_OPENER_WORDS.has(firstWord)) {
    return null;
  }
  return head;
}

/** Whether a source title names the product at the head of a bullet (either contains the other). */
function titleNamesBulletHead(title: string, head: string): boolean {
  const normalizedTitle = normalizeProductNameForCompare(title);
  if (normalizedTitle.length < 3) return false;
  return normalizedTitle.includes(head) || head.includes(normalizedTitle);
}

/** Every document id (plain or batch `<id>:<key>` form) cited by a `[doc:…]` marker anywhere in `text`. */
function citedDocumentIds(text: string): string[] {
  return Array.from(text.matchAll(DOC_CITATION_PATTERN), (m) => m[1]?.trim() ?? '').filter(Boolean);
}

/**
 * B0-888 — the specific source(s) a sentence (or its immediate surrounding context, standing in
 * for "its containing bullet") attributes, per the ticket's three channels: an explicit
 * `[doc:<id>]` marker naming one of `sources`, a "per/according to the X label" phrase
 * fuzzy-matching a source's title, or -- only when nothing else names a source AND exactly one
 * candidate is the turn's locked product line's own document -- that one document (no ambiguity to
 * guess through with more than one).
 *
 * B0-971 — a fourth channel, tried before the locked-line fallback: the bullet names a product at
 * its head ("Rest Stop™: …") AND a source whose TITLE names that product is either cited by a
 * `[doc:…]` marker anywhere in the draft (the trailing `Source:` line, in practice) or the sentence
 * itself says "the label/profile/SDS states/says/lists/shows". Attribution only: the key-term check
 * in `isKeyTermGrounded` still has to find the organism/material and a claim verb in THAT source's
 * body, so a claim the named source never makes is still redacted.
 */
function attributedSources(
  sentence: string,
  contextText: string,
  sources: readonly RegulatedClaimSource[],
  draftAnswer: string,
): RegulatedClaimSource[] {
  const attributed: RegulatedClaimSource[] = [];

  for (const match of contextText.matchAll(DOC_CITATION_PATTERN)) {
    const cited = match[1]?.trim();
    if (!cited) continue;
    const source = sources.find(
      (s) => cited === s.documentId || cited.endsWith(`:${s.documentId}`),
    );
    if (source && !attributed.includes(source)) attributed.push(source);
  }

  const perLabel = PER_LABEL_ATTRIBUTION_PATTERN.exec(contextText);
  if (perLabel?.[1]) {
    const fragment = perLabel[1].toLowerCase().trim();
    for (const source of sources) {
      const title = source.title.toLowerCase();
      if ((title.includes(fragment) || fragment.includes(title)) && !attributed.includes(source)) {
        attributed.push(source);
      }
    }
  }

  if (attributed.length === 0) {
    const head = bulletHeadProductName(sentence);
    if (head) {
      const cited = citedDocumentIds(draftAnswer);
      const sentenceAssertsSource = SOURCE_ASSERTION_ATTRIBUTION_PATTERN.test(sentence);
      for (const source of sources) {
        if (!titleNamesBulletHead(source.title, head)) continue;
        const citedAnywhere = cited.some(
          (id) => id === source.documentId || id.endsWith(`:${source.documentId}`),
        );
        if (!citedAnywhere && !sentenceAssertsSource) continue;
        if (!attributed.includes(source)) attributed.push(source);
      }
    }
  }

  if (attributed.length === 0) {
    const locked = sources.filter((s) => s.isLockedProductLineSource);
    if (locked.length === 1) attributed.push(locked[0]);
  }

  return attributed;
}

/**
 * B0-888 — key-term fallback grounding for `compatibility` / `efficacy_claim` ONLY: a PARAPHRASE of
 * a verbatim source line ("Labeled to kill HIV-1 on pre-cleaned environmental surfaces" vs. the
 * label's own wording) never passes `isSentenceGrounded`'s whole-sentence/quoted-span compare, but
 * IS grounded when the sentence (or its containing context) attributes a specific source (see
 * `attributedSources`) AND that source's body carries the same material/organism key term together
 * with a claim verb. Restricting this to an ATTRIBUTED source -- and only these two categories --
 * keeps the fabrication check intact: a claim naming a material/organism the attributed source
 * never mentions still fails, and `hazard`/`first_aid`/token categories never take this path at all.
 */
function isKeyTermGrounded(
  sentence: string,
  contextText: string,
  category: 'compatibility' | 'efficacy_claim',
  sources: readonly RegulatedClaimSource[],
  draftAnswer: string,
): boolean {
  const candidates = attributedSources(sentence, contextText, sources, draftAnswer);
  if (candidates.length === 0) return false;

  const keyTermPattern =
    category === 'compatibility' ? COMPATIBILITY_MATERIAL_PATTERN : EFFICACY_ORGANISM_PATTERN;
  const verbPattern = category === 'compatibility' ? COMPATIBILITY_CLAIM_PATTERN : EFFICACY_VERB_PATTERN;

  const keyTermMatch = sentence.match(keyTermPattern)?.[0];
  if (!keyTermMatch) return false;
  const hasClaimVerb =
    verbPattern.test(sentence) ||
    (category === 'efficacy_claim' && EFFICACY_STRONG_PATTERN.test(sentence));
  if (!hasClaimVerb) return false;

  const normalizedKeyTerm = normalizeSentenceForGroundingCompare(keyTermMatch);
  if (!normalizedKeyTerm) return false;

  return candidates.some((source) => {
    const normalizedBody = normalizeSentenceForGroundingCompare(source.documentBody);
    if (!normalizedBody.includes(normalizedKeyTerm)) return false;
    return (
      verbPattern.test(source.documentBody) ||
      (category === 'efficacy_claim' && EFFICACY_STRONG_PATTERN.test(source.documentBody))
    );
  });
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
  /**
   * B0-997 — mirrors the `productResolved` gate `fact-tool-enforcement.ts` already applies before
   * forcing `list_allowed_surfaces`/`get_compatibility_rules`. Without it, `isCompatibilityClaimSentence`
   * (gated only on the SENTENCE naming a product via `hasProductSubject` -- a self-reference like
   * "this product" is enough) still classified a generic, no-named-product surface question as a
   * `compatibility` claim requiring verbatim label grounding, so a correct knowledge-base answer with
   * no source list to quote from was rewritten into "approved surfaces ... not on file" canned copy.
   * Defaults to `true` (today's behaviour, and every existing call site/fixture that predates this
   * turn's product-lock signal) -- callers pass `false` only when they positively know this turn
   * never resolved a named Betco product.
   */
  productResolved?: boolean;
}): RegulatedClaimGroundingResult {
  const productResolved = input.productResolved !== false;
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
  // B0-888 — categories where at least one sentence was grounded via the key-term fallback or the
  // adjacent-verbatim-quote exemption rather than a plain verbatim match; see the gate record at
  // this function's call site for how this is surfaced (`inputs.groundingMode`).
  const keyTermGroundedCategories: RegulatedClaimCategory[] = [];

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

  /**
   * B0-888 — `hazard`/`first_aid` walk this unchanged (full sentence list, filtered by the trigger,
   * verbatim/quoted-span grounding only). `compatibility`/`efficacy_claim` additionally try the
   * key-term fallback, then a check on the textually NEXT sentence: a grounded verbatim quote
   * immediately following an ungrounded paraphrase is sufficient grounding for that paraphrase too.
   * Both need the FULL (unfiltered) sentence list -- not just the claim sentences -- to know what is
   * textually adjacent in the original draft.
   */
  const checkSentenceCategory = (
    category: RegulatedClaimCategory,
    // B0-1052: `precedingSentence` is optional and only consulted by `isHazardClaimSentence` (the
    // sub-bullet/header-context exclusion); every other trigger ignores the extra argument.
    isClaimTrigger: (sentence: string, precedingSentence?: string) => boolean,
  ) => {
    const allSentences = splitIntoSentences(input.draftAnswer);
    const claimIndices: number[] = [];
    for (let i = 0; i < allSentences.length; i += 1) {
      const precedingSentence = i > 0 ? allSentences[i - 1] : undefined;
      if (
        isClaimTrigger(allSentences[i], precedingSentence) &&
        !isNonClaimScaffolding(allSentences[i])
      ) {
        claimIndices.push(i);
      }
    }
    if (claimIndices.length === 0) return;
    categoriesDetected.push(category);

    const useKeyTermFallback = KEY_TERM_FALLBACK_CATEGORIES.has(category);
    const keyTermPattern =
      category === 'compatibility' ? COMPATIBILITY_MATERIAL_PATTERN : EFFICACY_ORGANISM_PATTERN;
    let groundedViaKeyTermPath = false;
    const ungroundedSentences: string[] = [];

    for (const idx of claimIndices) {
      const sentence = allSentences[idx];
      if (isSentenceGrounded(sentence, normalizedSourceBodiesPlain, isClaimTrigger)) {
        continue;
      }

      if (useKeyTermFallback && (category === 'compatibility' || category === 'efficacy_claim')) {
        // "Its containing bullet": a window of the sentence plus its immediate neighbours, since
        // attribution ("per the X label", "[doc:uuid]") is often stated once for the whole bullet
        // rather than repeated on every sentence inside it.
        const contextText = [allSentences[idx - 1], sentence, allSentences[idx + 1]]
          .filter((s): s is string => Boolean(s))
          .join(' ');
        if (isKeyTermGrounded(sentence, contextText, category, input.sources, input.draftAnswer)) {
          groundedViaKeyTermPath = true;
          continue;
        }

        // B0-888 — an ungrounded PARAPHRASE immediately followed by a grounded verbatim quote that
        // names the same material/organism is sufficiently grounded by that adjacent quote.
        const next = allSentences[idx + 1];
        if (
          next &&
          keyTermPattern.test(next) &&
          isSentenceGrounded(next, normalizedSourceBodiesPlain, isClaimTrigger)
        ) {
          groundedViaKeyTermPath = true;
          continue;
        }
      }

      ungroundedSentences.push(sentence);
    }

    if (groundedViaKeyTermPath) {
      keyTermGroundedCategories.push(category);
    }
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
  checkSentenceCategory('hazard', isHazardClaimSentence);
  checkSentenceCategory('first_aid', isFirstAidClaimSentence);
  // B0-997 — only a claim worth verbatim-grounding when this turn actually resolved a named Betco
  // product; otherwise there is no product-specific label to check against, and forcing one turns a
  // correct generic-knowledge answer into an "approved surfaces ... not on file" decline.
  if (productResolved) {
    checkSentenceCategory('compatibility', isCompatibilityClaimSentence);
  }
  checkSentenceCategory('efficacy_claim', isEfficacyClaimSentence);

  return {
    categoriesDetected: [...new Set(categoriesDetected)],
    ungroundedCategories: [...new Set(ungroundedCategories)],
    ungroundedDetails,
    keyTermGroundedCategories: [...new Set(keyTermGroundedCategories)],
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
/** B0-987 — the keyed batch form only, capturing `<key>` exactly as the model wrote it. */
const VERIFIED_FACTS_KEYED_CITATION_PATTERN = /\[doc:verified-facts:([^\]]+)\]/gi;

/** B0-987 — every distinct `<key>` cited as `[doc:verified-facts:<key>]` in `text`, in order of first appearance. */
export function extractVerifiedFactsCitationKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(VERIFIED_FACTS_KEYED_CITATION_PATTERN)) {
    const key = match[1]?.trim();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** The two scalar dilution fields of a `ProductLineFacts` row this guardrail compares against. */
export type DilutionFactScalars = { dilutionDisplay: string | null; dilutionOzPerGal: number | null };

export type DilutionCitationGroundingResult = {
  /** Whether the draft cited `[doc:verified-facts]` alongside a dilution figure at all. When
   * false, `grounded`/`ungroundedTokens` are meaningless and no rejection should follow. */
  applicable: boolean;
  /** True when every cited dilution figure matches the fact row it is attached to (B0-987: the
   * row of the `[doc:verified-facts:<key>]` citation on its line / named for its bullet, else the
   * locked product line's own row). Always false when `applicable` is true and a figure has
   * neither a citation row nor a locked line to verify against, or that row carries no dilution. */
  grounded: boolean;
  /** Every dilution-shaped token the draft asserted, for the review-task payload. */
  citedTokens: string[];
  /** The subset of `citedTokens` that could not be matched to its own cited/locked fact row. */
  ungroundedTokens: string[];
  /** B0-987 — the `<key>`s cited as `[doc:verified-facts:<key>]` anywhere in the draft. */
  citedProductLineKeys: string[];
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
  lockedFacts: DilutionFactScalars | null;
  /**
   * B0-987 — the freshly re-fetched row for each `<key>` cited as `[doc:verified-facts:<key>]`,
   * keyed by that `<key>` exactly as written (`null` when the key resolved to no row). A dilution
   * figure is checked against the row(s) of the citation(s) on ITS OWN line, or — when its bullet
   * carries none inline — the row whose `Source:`-line citation is labelled with the product named
   * at the head of that bullet. Only a figure attached to no citation falls back to `lockedFacts`.
   */
  citedFacts?: ReadonlyMap<string, DilutionFactScalars | null>;
}): DilutionCitationGroundingResult {
  const citedProductLineKeys = extractVerifiedFactsCitationKeys(input.draftAnswer);
  const notApplicable: DilutionCitationGroundingResult = {
    applicable: false,
    grounded: true,
    citedTokens: [],
    ungroundedTokens: [],
    citedProductLineKeys,
  };
  if (!VERIFIED_FACTS_CITATION_PATTERN.test(input.draftAnswer)) {
    return notApplicable;
  }
  const citedTokens = extractDilutionTokens(input.draftAnswer);
  if (citedTokens.length === 0) {
    return notApplicable;
  }

  const lockedStrings = input.lockedFacts
    ? renderedDilutionStrings(input.lockedFacts).map(normalizeUnitToken)
    : [];
  // Only keys that resolved to a row get an entry; a key with no row falls back to the locked line
  // below (the pre-B0-987 behaviour for that figure), while a row WITHOUT a dilution on file yields
  // an empty list — quoting a dilution for a product whose own row has none is ungrounded.
  const citedStringsByKey = new Map<string, string[]>();
  for (const key of citedProductLineKeys) {
    const facts = input.citedFacts?.get(key);
    if (facts) citedStringsByKey.set(key, renderedDilutionStrings(facts).map(normalizeUnitToken));
  }
  const citationLabels = verifiedFactsCitationLabels(input.draftAnswer);

  const matches = (token: string, groundedStrings: readonly string[]) => {
    const normalizedToken = normalizeUnitToken(token);
    if (!normalizedToken) return false;
    return groundedStrings.some(
      (g) => g === normalizedToken || g.includes(normalizedToken) || normalizedToken.includes(g),
    );
  };

  const ungroundedTokens: string[] = [];
  for (const line of input.draftAnswer.split('\n')) {
    // Source-line product labels are emitted as bullets; free prose lines should not be keyed by
    // incidental colons (e.g. "1:256") that can appear before a later keyed citation.
    const head = /^\s*[-–—•*+]/.test(line) ? bulletHeadProductName(line) : null;
    const headKeys = head
      ? citationLabels
          .filter(({ label }) => label.includes(head) || head.includes(label))
          .map(({ key }) => key)
      : [];

    // A keyed citation in one sentence on the line should not "capture" figures from another sentence.
    for (const clause of line.split(/(?<=[.;])\s+/)) {
      const clauseTokens = extractDilutionTokens(clause);
      if (clauseTokens.length === 0) continue;

      let clauseKeys = extractVerifiedFactsCitationKeys(clause);
      if (clauseKeys.length === 0) {
        clauseKeys = headKeys;
      }
      const citedRows = clauseKeys
        .map((key) => citedStringsByKey.get(key))
        .filter((strings): strings is string[] => strings != null);
      const groundedStrings = citedRows.length > 0 ? citedRows.flat() : lockedStrings;

      for (const token of clauseTokens) {
        if (!matches(token, groundedStrings)) ungroundedTokens.push(token);
      }
    }
  }

  return {
    applicable: true,
    grounded: ungroundedTokens.length === 0,
    citedTokens,
    ungroundedTokens: [...new Set(ungroundedTokens)],
    citedProductLineKeys,
  };
}

/**
 * B0-987 — the product each `[doc:verified-facts:<key>]` citation is labelled with, read off the
 * text between the previous separator (`;`, a line start, or the previous marker) and the marker:
 * `Sources: Verified Product Facts (structured) — Citrus Chisel [doc:verified-facts:16704]` ⇒
 * `{ key: '16704', label: 'citrus chisel' }`. Labels are normalised with the same routine as bullet
 * heads so the two compare directly.
 */
function verifiedFactsCitationLabels(text: string): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  for (const line of text.split('\n')) {
    let cursor = 0;
    for (const match of line.matchAll(VERIFIED_FACTS_KEYED_CITATION_PATTERN)) {
      const key = match[1]?.trim();
      const start = match.index ?? 0;
      if (key) {
        const segment = line.slice(cursor, start);
        const label = normalizeProductNameForCompare(
          (segment.split(';').pop() ?? '')
            .replace(/^\s*sources?\s*:/i, '')
            .replace(/verified product facts(?:\s*\(structured\))?/i, '')
            .replace(/[—–-]\s*/g, ' ')
            .replace(/\[doc:[^\]]*\]/gi, ''),
        );
        if (label.length >= 3) out.push({ key, label });
      }
      cursor = start + match[0].length;
    }
  }
  return out;
}

/**
 * B0-886 — the revision pass's own instructions, lifted out of the call so the workflow can record
 * exactly what the revision model was told on its `revision` step.
 *
 * Rewritten from a general "revise the whole answer" instruction to a targeted EDIT instruction:
 * the pre-B0-886 prompt let the model rewrite the entire draft to fix one flagged sentence, which
 * routinely dropped grounded content the validator never objected to (21 of 32 failing golden
 * items had the mandatory concept in the pre-validator draft but lost it after revision). It also
 * left the model free to preface its answer with meta-commentary ("Revised Answer:", "Here is a
 * revised answer based only on the provided evidence:"), which leaked into the user-facing text.
 * `stripRevisionPreamble` below is a deterministic backstop for that; this prompt is the primary
 * fix.
 */
export const REVISION_SYSTEM_PROMPT = [
  'You are given a draft answer and a list of validator issues, each describing a specific problem with specific sentence(s), list item(s), or claim(s) in the draft.',
  'Edit ONLY the sentence(s), list item(s), or claim(s) the issues actually flag. Preserve every other sentence, list item, number, and "Source:" line verbatim -- do not rewrite, reorder, summarize, or drop anything the issues did not flag.',
  'Do not add new factual claims beyond the evidence summary.',
  'Never add a heading, preamble, or meta-commentary of any kind (e.g. "Revised Answer:", "Here is a revised answer..."). Return the answer text only, exactly as it should appear to the user.',
  'If you cannot fix the flagged issue(s) safely without fabricating support, reply with a short clarification request only.',
].join('\n');

/**
 * B0-389 — the model the revision pass calls (no dedicated settings row, unlike the validator).
 * B0-903 — through `resolveModel`, so `preview` follows the `BEX_LLM_PROVIDER` per-vendor default.
 */
export async function resolveRevisionModel(modelTag?: string): Promise<string> {
  return resolveModel(modelTag ?? 'preview');
}

/**
 * B0-886 — a leading meta-commentary line the revision model sometimes emits despite
 * `REVISION_SYSTEM_PROMPT` now explicitly forbidding it (e.g. "Revised Answer:\n\n...", "Here is a
 * revised answer based only on the provided evidence:\n..."). Matched at the START of the text
 * only, case-insensitively, with an optional markdown bold wrapper -- never anywhere else in the
 * body, so a legitimate sentence that happens to start with "Revised" further down is never
 * touched (there is no such further-down case: this only ever matches the first line).
 */
const REVISION_PREAMBLE_LINE_PATTERN =
  /^\s*\*{0,2}(?:revised answer|here is (?:a|the) revised answer\b[^\n]*)\*{0,2}\s*:\s*\n+/i;

/**
 * B0-886 — deterministic backstop that strips a leading "Revised Answer:" / "Here is a revised
 * answer...:" preamble line from the revision model's output before it is used as `draftAnswer`.
 * Mirrors `isDeclineAnswer`'s pattern-match style (a small, directly testable, exported function)
 * rather than relying on the prompt alone -- six delivered answers leaked this preamble into the
 * user-facing text before this ticket, hurting Clarity scoring.
 */
export function stripRevisionPreamble(text: string): string {
  return text.replace(REVISION_PREAMBLE_LINE_PATTERN, '').trimStart();
}

/**
 * B0-886 — every issue string this validator run produced is one the deterministic B0-257
 * regulated-claim guardrail added (`regulated_claim_unverified:<category>`, see
 * `run-product-support-workflow.ts`'s `evaluateRegulatedClaimGrounding` call site). When true (and
 * gated on `isRevisionSkipForRegulatedClaimOnlyEnabled`), the caller may skip the LLM revision pass
 * entirely: `planRegulatedClaimRedaction` already handles this rejection deterministically, and
 * running an LLM rewrite on top risks paraphrasing away the exact verbatim citation the redaction
 * step needs to find.
 */
const REGULATED_CLAIM_ISSUE_PREFIX = 'regulated_claim_unverified:';

export function isOnlyRegulatedClaimIssues(issues: string[]): boolean {
  return issues.length > 0 && issues.every((issue) => issue.startsWith(REGULATED_CLAIM_ISSUE_PREFIX));
}

/**
 * B0-886 — settings-table flag (default OFF) gating the skip above. Tom Bird has not yet decided
 * whether skipping the LLM revision pass for a regulated-claim-only rejection is the right
 * behavior for the epic, so this exists as a lever rather than a hardcoded change. NOTE: as
 * currently ordered, `run-product-support-workflow.ts` evaluates the regulated-claim guardrail
 * AFTER the revision-pass gate this flag guards, so `validation.issues` at that gate never yet
 * contains `regulated_claim_unverified:*` -- enabling this flag today is a no-op until/unless the
 * guardrail's evaluation is moved earlier in the turn. Documented here rather than silently
 * papering over the discrepancy; see B0-886 grounded context vs. the actual call order.
 */
export async function isRevisionSkipForRegulatedClaimOnlyEnabled(): Promise<boolean> {
  return getBooleanSetting('BEX_REVISION_SKIP_REGULATED_CLAIM_ONLY_ENABLED', false);
}

/** B0-554 — `runRevisionPass`'s result plus the token usage from its one model call. */
export type RevisionPassResult = { text: string; usage: LlmTokenUsage };

export async function runRevisionPass(input: {
  draftAnswer: string;
  validatorIssues: string[];
  evidenceSummary: string;
  modelTag?: string;
}): Promise<RevisionPassResult> {
  const model = await resolveRevisionModel(input.modelTag);

  // B0-550 — same bounded retry + explicit timeout as `runValidatorPass`; see its comment above.
  // B0-908 — free-text call through `completeTextWithUsage` (provider-routed). A cut-off revision
  // is still returned, as before; a model refusal comes back as empty text, which the workflow
  // already treats as "revision refused, keep the draft" (`revisionRefused`).
  try {
    const completion = await retryTransportFaults(
      () =>
        completeTextWithUsage({
          model,
          system: REVISION_SYSTEM_PROMPT,
          user: JSON.stringify({
            draft: input.draftAnswer,
            issues: input.validatorIssues,
            evidence_summary: input.evidenceSummary,
          }),
          // B0-606 — same gating as the validator pass above.
          temperature: 0.2,
          maxOutputTokens: resolveMaxOutputTokens(),
          requestOptions: { maxRetries: 0, timeoutMs: resolveOpenAiRequestTimeoutMs() },
        }),
      { runtime: 'responses', label: 'revision.create' },
    );
    // B0-886 — strip a leaked meta-commentary preamble before this text is ever treated as the
    // answer (persisted as `revisedAnswer`, or promoted to `draftAnswer`).
    return { text: stripRevisionPreamble(completion.text), usage: completion.usage };
  } catch (error) {
    if (error instanceof StructuredOutputRefusedError) {
      return { text: '', usage: ZERO_USAGE };
    }
    throw error;
  }
}
