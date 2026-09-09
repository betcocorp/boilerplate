import { completeStructuredWithUsage } from '~/lib/llm/structured-completion';
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
}): Promise<SemanticGradingResult | null> {
  if (params.semanticCriteria.length === 0) {
    return null;
  }

  const grading = await resolveItemGradingConfig(params.modelTag);

  let text: string;
  try {
    ({ text } = await retryTransportFaults(
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
    ));
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

/**
 * Full per-criterion grading for one item. Returns `null` when the item carries no
 * `expected_criteria` — callers fall back to the existing behavior-only
 * `gradeChatTestResponse` (~/lib/tests/runner.ts), so test sets without criteria are
 * completely unaffected (zero migration required, per the business case).
 */
export async function gradeWithCriteria(params: {
  prompt: string;
  responseText: string;
  criteria: ExpectedCriterion[];
  modelTag?: string;
}): Promise<CriteriaGradingOutcome | null> {
  if (params.criteria.length === 0) {
    return null;
  }

  const exactVerdicts: CriterionVerdict[] = [];
  const semanticCriteria: Array<{ index: number; criterion: ExpectedCriterion }> = [];

  params.criteria.forEach((criterion, index) => {
    if (criterion.match === 'exact') {
      exactVerdicts.push({
        ...gradeExactCriterion(criterion.concept, params.responseText),
        criterionIndex: index,
        source: 'exact', // B0-832 — provenance tag; aggregateCriteriaVerdicts never lets this lose a collision
      });
    } else {
      semanticCriteria.push({ index, criterion });
    }
  });

  const semanticResult = await gradeSemanticCriteria({
    prompt: params.prompt,
    responseText: params.responseText,
    semanticCriteria,
    modelTag: params.modelTag,
  });

  // B0-902 — no model call happened (every criterion is `exact`): purely deterministic outcome.
  if (semanticResult === null) {
    return {
      ...aggregateCriteriaVerdicts(params.criteria, exactVerdicts),
      gradingModel: null,
      gradingProvider: null,
    };
  }

  // B0-902 — the model could not judge. The exact verdicts still stand; every semantic criterion
  // reads not-met (nothing is fabricated), the item is NOT passed, and the reason is carried on the
  // outcome so a reviewer sees "unable to evaluate", not a substantive fail — and the runner never
  // falls through to the behaviour-only heuristic, which could have passed the item silently.
  if (!semanticResult.ok) {
    const aggregated = aggregateCriteriaVerdicts(params.criteria, exactVerdicts);
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
    ...aggregateCriteriaVerdicts(params.criteria, [...exactVerdicts, ...semanticVerdicts]),
    gradingModel: semanticResult.grading.model,
    gradingProvider: semanticResult.grading.provider,
  };
}
