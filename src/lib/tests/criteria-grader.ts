import { completeStructuredWithUsage } from '~/lib/llm/structured-completion';
import { modelProviderFor } from '~/lib/constants/models';
import {
  resolveOpenAiRequestTimeoutMs,
  retryTransportFaults,
} from '~/lib/openai/transport-retry';
import { resolveMaxOutputTokens } from '~/lib/workflows/product-support/max-output-tokens';

import {
  aggregateCriteriaVerdicts,
  GRADER_JSON_SCHEMA,
  graderResponseSchema,
  type CriteriaGradingOutcome,
  type CriterionVerdict,
  type ExpectedCriterion,
} from './criteria-schemas';
import { recordGradingUsage, type GradingUsageContext } from './grading-usage';
import { resolveItemGradingConfig, type ItemGradingConfig } from './item-grading-model';

/**
 * B0-902 — the grader model is the shared per-item resolver (`./item-grading-model.ts`): the
 * `TEST_ITEM_GRADING_MODEL` settings row, which by default (`run`) follows the run's own model tag
 * exactly as B0-616's `resolveResponsesModel(modelTag ?? 'preview')` did. The former
 * `BEX_GRADER_MODEL` env override is gone (config lives in the settings table, never env).
 * Kept as an export because it is the grader's public resolver name.
 */
export async function resolveGraderModel(modelTag?: string): Promise<string> {
  return (await resolveItemGradingConfig(modelTag)).model;
}

const GRADER_SYSTEM_PROMPT = `You are grading a single AI assistant response against a fixed list of criteria.

For EACH criterion, decide only: does the response state this concept? Semantic equivalence and paraphrasing count as met — the wording does not need to match verbatim. If the response contradicts the concept, or never addresses it, it is not met.

Dilution units (B0-953): a dilution stated in a different unit is the SAME concept only when the two values are EXACTLY equal by the standard conversions — 1:N is exactly 128/N fluid ounces per US gallon, and exactly 1000/N millilitres per litre. So 1:64, 2 fl oz per US gallon and 15.625 mL/L are one concept, and a criterion reading "dilutes at 1:64" is met by a response that says "2 oz per gallon" for the same product; quote the response's own wording as the evidence. If the two values are not exactly equal, or the conversion is ambiguous — a percentage, an unstated or non-US unit, or a value attributed to a different product — it is NOT met. Never round, never approximate, never accept "close enough": a dilution that is nearly right is wrong, and passing it would certify an incorrect regulated value.

Do not judge overall quality, tone, or completeness beyond the listed criteria. Do not invent criteria. Return a verdict for every criterion given.

The criteria list below is numbered; each line reads "<number>. <criterion>". For \`criterionIndex\` in your response, copy that exact number as printed — it may skip values or not start at 0, because some criteria in the full item are graded elsewhere and are not shown to you. Do NOT renumber the criteria you were shown starting from 0.`;

function buildUserMessage(params: {
  prompt: string;
  responseText: string;
  criteria: Array<{ index: number; concept: string }>;
}): string {
  const criteriaList = params.criteria
    .map((c) => `${c.index}. ${c.concept}`)
    .join('\n');

  return `Original prompt:\n${params.prompt}\n\nAssistant response:\n${params.responseText}\n\nCriteria to check (criterionIndex = the number shown before each one):\n${criteriaList}`;
}

/**
 * What the semantic grader call produced: the verdicts plus the model that produced them, or —
 * when the model could not judge (refusal, truncation at the output cap, transport failure after
 * retries) — the reason, so `gradeWithCriteria` can return an explicit unable-to-evaluate outcome
 * instead of throwing (which the runner turned into a silent fall-through to behaviour-only
 * grading, i.e. a possible silent pass).
 */
type SemanticGradingResult =
  | { ok: true; verdicts: CriterionVerdict[]; grading: ItemGradingConfig }
  | { ok: false; reason: string; grading: ItemGradingConfig };

/**
 * One structured-output call per item through `completeStructuredWithUsage` (B0-908: routes by
 * provider on the resolved model id), judging only the `semantic`-tagged
 * criteria. `exact`-tagged criteria never reach the model — they are checked deterministically
 * in `gradeWithCriteria` below, per the org's regulated-data rule (never trust an LLM's judgment
 * on a dilution ratio, contact time, or EPA registration number).
 */
async function gradeSemanticCriteria(params: {
  prompt: string;
  responseText: string;
  semanticCriteria: Array<{ index: number; criterion: ExpectedCriterion }>;
  modelTag?: string;
  context?: GradingUsageContext;
}): Promise<SemanticGradingResult | null> {
  if (params.semanticCriteria.length === 0) {
    return null;
  }

  const grading = await resolveItemGradingConfig(params.modelTag);

  let text: string;
  try {
    const completion = await retryTransportFaults(
      () =>
        completeStructuredWithUsage({
          model: grading.model,
          effort: grading.effort,
          system: GRADER_SYSTEM_PROMPT,
          user: buildUserMessage({
            prompt: params.prompt,
            responseText: params.responseText,
            criteria: params.semanticCriteria.map(({ index, criterion }) => ({
              index,
              concept: criterion.concept,
            })),
          }),
          schemaName: 'criteria_grading_result',
          schema: GRADER_JSON_SCHEMA,
          maxOutputTokens: resolveMaxOutputTokens(),
          temperature: 0,
          requestOptions: { maxRetries: 0, timeoutMs: resolveOpenAiRequestTimeoutMs() },
        }),
      { runtime: 'responses', label: 'criteria-grader.create' },
    );
    text = completion.text;
    // B0-1109 — success path only: a refusal/truncation/transport failure throws below before any
    // usage is ever read (see structured-completion.ts runOpenAI/runAnthropic), so there is nothing
    // to record on those paths.
    if (params.context) {
      recordGradingUsage({
        context: params.context,
        callSite: 'criteria_grader',
        provider: modelProviderFor(grading.model),
        model: grading.model,
        usage: completion.usage,
      });
    }
  } catch (error) {
    // `StructuredOutputRefusedError` / `StructuredOutputTruncatedError` and exhausted transport
    // retries all land here: the model gave no usable judgment, so say so rather than guess.
    return {
      ok: false,
      grading,
      reason: `Grading call failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }

  let parsed: CriterionVerdict[];
  try {
    parsed = graderResponseSchema.parse(JSON.parse(text) as unknown).verdicts;
  } catch (error) {
    return {
      ok: false,
      grading,
      reason: `Grader returned an unparseable answer: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
  return { ok: true, verdicts: parsed, grading };
}

/**
 * The ONLY normalisation an `exact` match applies, to both sides: lower-case, collapse every
 * whitespace run (spaces, tabs, newlines) to one space, trim. Digits, units and punctuation are
 * left exactly as written — the regulated-data rule (transcribe exactly, never round/convert/infer)
 * depends on that.
 */
function normalizeForExactMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Literal substring check for `match: 'exact'` criteria. Concept and response are both passed
 * through {@link normalizeForExactMatch} (case + whitespace runs) and nothing else, so the check
 * is insensitive to capitalisation and line-wrapping while every digit, unit and punctuation mark
 * must still appear exactly as printed: "4 oz/gal" does not match "4.0 oz/gal" or "40 oz/gal",
 * and "EPA Reg. No. 1839-83" does not match "EPA Reg No 1839-83". This is the deterministic
 * guardrail the business case calls out as the highest-stakes payoff: a judge that "mostly"
 * catches a wrong dilution ratio is not an acceptable control.
 *
 * B0-803 — this used to be a raw `String.prototype.includes`, fully case-sensitive despite the
 * comment above, so a correct "2 minutes" answer failed a "2 Minutes" criterion. An empty or
 * whitespace-only concept never matches (it would otherwise match everything). `evidence` is the
 * original criterion text when met, never the normalised form.
 *
 * B0-538 — exported so the multi-turn evaluator routes every regulated-looking expectation term
 * (dilution ratios, oz/gal, mL/L, ppm, %, contact times, CAS/EPA numbers, log reductions) through
 * this exact same literal check rather than its own case-insensitive `mentions` matching.
 */
export function gradeExactCriterion(concept: string, responseText: string): CriterionVerdict {
  const needle = normalizeForExactMatch(concept);
  const found = needle.length > 0 && normalizeForExactMatch(responseText).includes(needle);
  return {
    criterionIndex: -1, // caller overwrites with the real index
    met: found,
    evidence: found ? concept : '',
  };
}

/* ---------------------------------------------------------------------------------------------- *
 * B0-953 — dilution-unit equivalence, computed in TypeScript, never by the model.
 *
 * A criterion reading "pH7Q dilutes at 1:64" was scored not-met against an answer that transcribed
 * the label as "2 oz per gallon of water" — the same value, spelled in the other unit. The grader
 * model compares strings and has no reason to do the arithmetic, so pass/fail turned on how the
 * fixture happened to be phrased.
 *
 * The equivalence is done here, deterministically, for the same reason `exact` criteria are:
 * a regulated value must never be certified by an LLM's arithmetic. Exactly two conversions are
 * recognised, both of them identities on the US label convention — 1:N === 128/N fl oz per US
 * gallon === 1000/N mL per litre — and they are evaluated as rationals, so nothing is ever rounded.
 * Percentages are deliberately NOT convertible (%, v/v and w/v are not the same statement).
 *
 * The check can only ever turn a criterion MET. When it does not fire — no dilution in the
 * criterion, more than one distinct value, an inexact conversion, or an ambiguous subject — the
 * criterion falls through to the semantic grader exactly as before.
 * ---------------------------------------------------------------------------------------------- */

/** Exact non-negative rational; `d` is always > 0. Compared by cross-multiplication, never floats. */
type Rational = { n: number; d: number };

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y > 0) {
    [x, y] = [y, x % y];
  }
  return x || 1;
}

function rational(n: number, d: number): Rational | null {
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return null;
  const g = greatestCommonDivisor(n, d);
  return { n: n / g, d: d / g };
}

/** "0.5" → 5/10, "2" → 2/1. Returns null for anything not a plain decimal (no rounding anywhere). */
function decimalToRational(text: string): Rational | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) return null;
  const fraction = match[2] ?? '';
  const scale = 10 ** fraction.length;
  return rational(Number(`${match[1]}${fraction}`), scale);
}

function rationalsEqual(a: Rational, b: Rational): boolean {
  return a.n * b.d === b.n * a.d;
}

/** A dilution value found in some text, kept with the literal span it was read from. */
type DilutionReading = { value: Rational; text: string };

/**
 * The three spellings recognised, each mapped to the same canonical quantity: N in "1:N", i.e.
 * parts of finished solution per part of concentrate.
 */
const DILUTION_PATTERNS: Array<{
  regex: RegExp;
  toValue: (groups: string[]) => Rational | null;
}> = [
  {
    // 1:64, 1 : 64 — value is right/left, so a non-1 left side is handled without special-casing.
    regex: /(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/g,
    toValue: ([left, right]) => {
      const a = decimalToRational(left);
      const b = decimalToRational(right);
      return a && b ? rational(b.n * a.d, b.d * a.n) : null;
    },
  },
  {
    // 2 oz/gal, 2 fl. oz. per gallon, 2 ounces per gal → 128 / x
    regex:
      /(\d+(?:\.\d+)?)\s*(?:fl\.?\s*|fluid\s+)?(?:oz|ounces?)\.?\s*(?:\/|\bper\b)\s*gal(?:lon)?s?\.?/gi,
    toValue: ([amount]) => {
      const x = decimalToRational(amount);
      return x ? rational(128 * x.d, x.n) : null;
    },
  },
  {
    // 20 mL/L, 20 millilitres per liter → 1000 / x
    regex:
      /(\d+(?:\.\d+)?)\s*(?:ml|millilit(?:er|re)s?)\.?\s*(?:\/|\bper\b)\s*(?:l|lit(?:er|re)s?)\.?/gi,
    toValue: ([amount]) => {
      const x = decimalToRational(amount);
      return x ? rational(1000 * x.d, x.n) : null;
    },
  },
];

/** Every dilution value stated in `text`, in the order they appear. */
function readDilutions(text: string): DilutionReading[] {
  const readings: DilutionReading[] = [];
  for (const { regex, toValue } of DILUTION_PATTERNS) {
    const scanner = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(text)) !== null) {
      const value = toValue(match.slice(1));
      if (value) readings.push({ value, text: match[0] });
    }
  }
  return readings;
}

/** Strips every recognised dilution span, so the remaining words can be tokenised as the subject. */
function stripDilutions(text: string): string {
  let stripped = text;
  for (const { regex } of DILUTION_PATTERNS) {
    stripped = stripped.replace(new RegExp(regex.source, regex.flags), ' ');
  }
  return stripped;
}

/** Grammar + dilution vocabulary: words that cannot identify which product a value belongs to. */
const SUBJECT_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'concentrate', 'concentration', 'dilute',
  'diluted', 'dilutes', 'dilution', 'dilutions', 'fl', 'fluid', 'for', 'gal', 'gallon', 'gallons',
  'in', 'is', 'it', 'its', 'l', 'label', 'labeled', 'labelled', 'liter', 'liters', 'litre', 'litres',
  'milliliter', 'milliliters', 'millilitre', 'millilitres', 'ml', 'mix', 'mixed', 'mixes', 'mixing',
  'must', 'of', 'on', 'or', 'ounce', 'ounces', 'oz', 'per', 'rate', 'ratio', 'recommended',
  'should', 'solution', 'that', 'the', 'this', 'to', 'use', 'used', 'uses', 'using', 'water',
  'when', 'will', 'with',
]);

/** Lower-cased alphanumeric tokens, minus stopwords and bare numbers (e.g. "ph7q", "dual"). */
function subjectTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token && !/^\d+$/.test(token) && !SUBJECT_STOPWORDS.has(token));
}

/**
 * Tokens that can name a product rather than describe one: capitalised, or carrying a digit
 * ("pH7Q", "Dual", "FastDraw"). Used only to tell "this clause is about the same product" from
 * "this clause is about a sibling product whose value is legitimately different".
 */
function identifierTokens(text: string): Set<string> {
  const words = stripDilutions(text).match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? [];
  return new Set(
    words
      .filter((word) => /^[A-Z]/.test(word) || /\d/.test(word))
      .map((word) => word.toLowerCase().replace(/[^a-z0-9]+/g, ''))
      .filter((word) => word && !/^\d+$/.test(word) && !SUBJECT_STOPWORDS.has(word)),
  );
}

/**
 * Clause-level split: line breaks, semicolons, and a full stop only when what follows starts a new
 * clause (anything but a lower-case letter). "2 fl. oz. per gallon" therefore stays in one piece,
 * while "…for 2 minutes. Keep the surface wet" splits.
 */
function splitIntoSegments(text: string): string[] {
  return text
    .split(/(?<=[;!?])\s+|(?<=\.)\s+(?=[^a-z])|\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

const MAX_EVIDENCE_LENGTH = 240;

/**
 * Returns the response's own wording when it states this criterion's dilution in another unit at
 * EXACTLY the same value, or `null` (the criterion then goes to the semantic grader untouched).
 *
 * Guards, all of them deliberately conservative — a false positive here would certify a wrong
 * regulated value, which is far worse than the false negative this fixes:
 *  - the criterion must state exactly one distinct dilution value (two disagreeing forms in one
 *    concept is a fixture bug, not something to resolve silently);
 *  - only a clause that carries no *other*, unequal dilution value can supply the evidence;
 *  - every subject word of the criterion ("pH7Q", "Dual") must appear in that same clause, so a
 *    value belonging to a sibling product cannot satisfy it. When the criterion names no subject at
 *    all, the response must state exactly one distinct dilution value overall;
 *  - and if the response states a DIFFERENT dilution for that same subject anywhere, nothing is
 *    settled here at all — the answer may well be wrong, which is the model's call, not ours.
 */
export function findDilutionEquivalence(
  concept: string,
  responseText: string,
): { evidence: string; matched: string } | null {
  const conceptReadings = readDilutions(concept);
  if (conceptReadings.length === 0) return null;

  const target = conceptReadings[0].value;
  if (conceptReadings.some((reading) => !rationalsEqual(reading.value, target))) {
    return null; // the concept contradicts itself — report it, never resolve it here
  }

  const required = subjectTokens(stripDilutions(concept));
  if (required.length === 0) {
    const distinct = readDilutions(responseText).filter(
      (reading, index, all) =>
        all.findIndex((other) => rationalsEqual(other.value, reading.value)) === index,
    );
    if (distinct.length !== 1 || !rationalsEqual(distinct[0].value, target)) return null;
  }

  const criterionIdentifiers = identifierTokens(concept);
  const segments = splitIntoSegments(responseText).map((text) => ({
    text,
    readings: readDilutions(text),
    tokens: new Set(subjectTokens(text)),
    identifiers: identifierTokens(text),
  }));

  const namesSubject = (segment: (typeof segments)[number]) =>
    required.every((token) => segment.tokens.has(token));

  // Same subject and a different value: the response may simply be wrong about this product, and
  // that is the grader model's call to make, not arithmetic's. A clause naming an extra product
  // identifier ("pH7Q Dual" against a "pH7Q" criterion) is a different subject, so it says nothing.
  const contradicted = segments.some(
    (segment) =>
      namesSubject(segment) &&
      [...segment.identifiers].every((token) => criterionIdentifiers.has(token)) &&
      segment.readings.some((reading) => !rationalsEqual(reading.value, target)),
  );
  if (contradicted) return null;

  for (const segment of segments) {
    const hit = segment.readings.find((reading) => rationalsEqual(reading.value, target));
    if (!hit || !namesSubject(segment)) continue;
    // A clause naming an EXTRA product identifier ("pH7Q Dual uses 2 oz/gal" against a "pH7Q"
    // criterion) is about a sibling product, whose rate is legitimately different — it can never
    // be evidence for this one. Same test the contradiction guard above applies; without it here,
    // a wrong rate stated for the sibling would certify the criterion.
    if (![...segment.identifiers].every((token) => criterionIdentifiers.has(token))) continue;
    // A clause holding two different dilutions cannot say which one belongs to this criterion.
    if (segment.readings.some((reading) => !rationalsEqual(reading.value, target))) continue;

    return {
      matched: hit.text.trim(),
      evidence:
        segment.text.length > MAX_EVIDENCE_LENGTH
          ? `${segment.text.slice(0, MAX_EVIDENCE_LENGTH).trimEnd()}…`
          : segment.text,
    };
  }

  return null;
}

/**
 * Full per-criterion grading for one item. Returns `null` when the item carries no
 * no concepts — callers fall back to the existing behavior-only
 * `gradeChatTestResponse` (~/lib/tests/runner.ts), so test sets without criteria are
 * completely unaffected (zero migration required, per the business case).
 */
export async function gradeWithCriteria(params: {
  prompt: string;
  responseText: string;
  criteria: ExpectedCriterion[];
  modelTag?: string;
  /** B0-1109 — when present, the successful semantic-grading call's token usage is persisted. */
  context?: GradingUsageContext;
}): Promise<CriteriaGradingOutcome | null> {
  if (params.criteria.length === 0) {
    return null;
  }

  const deterministicVerdicts: CriterionVerdict[] = [];
  const semanticCriteria: Array<{ index: number; criterion: ExpectedCriterion }> = [];

  params.criteria.forEach((criterion, index) => {
    if (criterion.match === 'exact') {
      deterministicVerdicts.push({
        ...gradeExactCriterion(criterion.concept, params.responseText),
        criterionIndex: index,
        source: 'exact', // B0-832 — provenance tag; aggregateCriteriaVerdicts never lets this lose a collision
      });
      return;
    }

    // B0-953 — the response states this criterion's dilution in the other unit at exactly the same
    // value. Settled here rather than asked of the model, and the criterion is not sent to it.
    const equivalence = findDilutionEquivalence(criterion.concept, params.responseText);
    if (equivalence) {
      deterministicVerdicts.push({
        criterionIndex: index,
        met: true,
        evidence: equivalence.evidence,
        source: 'dilution_equivalence',
      });
      return;
    }

    semanticCriteria.push({ index, criterion });
  });

  const semanticResult = await gradeSemanticCriteria({
    prompt: params.prompt,
    responseText: params.responseText,
    semanticCriteria,
    modelTag: params.modelTag,
    context: params.context,
  });

  // B0-902 — no model call happened (every criterion was settled in code, by the `exact` check or
  // B0-953's dilution equivalence): purely deterministic outcome.
  if (semanticResult === null) {
    return {
      ...aggregateCriteriaVerdicts(params.criteria, deterministicVerdicts),
      gradingModel: null,
      gradingProvider: null,
    };
  }

  // B0-902 — the model could not judge. The deterministic verdicts still stand; every semantic criterion
  // reads not-met (nothing is fabricated), the item is NOT passed, and the reason is carried on the
  // outcome so a reviewer sees "unable to evaluate", not a substantive fail — and the runner never
  // falls through to the behaviour-only heuristic, which could have passed the item silently.
  if (!semanticResult.ok) {
    const aggregated = aggregateCriteriaVerdicts(params.criteria, deterministicVerdicts);
    return {
      ...aggregated,
      passed: false,
      failureReason: [
        `Unable to evaluate ${semanticCriteria.length} semantic criterion${semanticCriteria.length > 1 ? 'ia' : ''}: ${semanticResult.reason}`,
        aggregated.failureReason,
      ]
        .filter(Boolean)
        .join(' '),
      gradingModel: semanticResult.grading.model,
      gradingProvider: semanticResult.grading.provider,
      unableToEvaluate: true,
      uteReason: semanticResult.reason,
    };
  }

  const rawSemanticVerdicts = semanticResult.verdicts;

  // B0-832 — the model is only ever shown the semantic subset, but it can still answer with a
  // criterionIndex that collides with an `exact`-mode criterion's real index (or with any index
  // outside what it was shown). An exact verdict must never be silently overwritten by a semantic
  // one, so discard (and log) any semantic verdict that doesn't land on an actual semantic index.
  const semanticIndexSet = new Set(semanticCriteria.map((c) => c.index));
  const semanticVerdicts: CriterionVerdict[] = [];
  for (const verdict of rawSemanticVerdicts) {
    if (!semanticIndexSet.has(verdict.criterionIndex)) {
      console.warn(
        `[criteria-grader] B0-832: discarding semantic verdict with criterionIndex=${verdict.criterionIndex} — ` +
          `not one of the semantic-criteria indices shown to the model (${[...semanticIndexSet].join(', ') || 'none'}). ` +
          `This likely collided with an exact-criterion index and would have silently overwritten a deterministic verdict.`,
      );
      continue;
    }
    semanticVerdicts.push({ ...verdict, source: 'semantic' });
  }

  return {
    ...aggregateCriteriaVerdicts(params.criteria, [...deterministicVerdicts, ...semanticVerdicts]),
    gradingModel: semanticResult.grading.model,
    gradingProvider: semanticResult.grading.provider,
  };
}
