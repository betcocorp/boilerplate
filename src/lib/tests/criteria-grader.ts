import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { samplingParamsFor } from '~/lib/openai/model-capabilities';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';
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

/**
 * B0-616 — model tag for the criteria grader, following the same env-override
 * convention as `resolveValidatorModel` (~/lib/workflows/product-support/validator.ts):
 * a dedicated env var wins, otherwise fall back to the standard Responses model
 * resolution so the grader tracks whatever the rest of the harness defaults to.
 */
export function resolveGraderModel(modelTag?: string): string {
  return (
    process.env.BEX_GRADER_MODEL?.trim() || resolveResponsesModel(modelTag ?? 'preview')
  );
}

const GRADER_SYSTEM_PROMPT = `You are grading a single AI assistant response against a fixed list of criteria.

For EACH criterion, decide only: does the response state this concept? Semantic equivalence and paraphrasing count as met — the wording does not need to match verbatim. If the response contradicts the concept, or never addresses it, it is not met.

Do not judge overall quality, tone, or completeness beyond the listed criteria. Do not invent criteria. Return a verdict for every criterion index given, even if the answer is obviously not met.`;

function buildUserMessage(params: {
  prompt: string;
  responseText: string;
  criteria: Array<{ index: number; concept: string }>;
}): string {
  const criteriaList = params.criteria
    .map((c) => `${c.index}. ${c.concept}`)
    .join('\n');

  return `Original prompt:\n${params.prompt}\n\nAssistant response:\n${params.responseText}\n\nCriteria to check:\n${criteriaList}`;
}

/**
 * One structured-output Responses API call per item, judging only the `semantic`-tagged
 * criteria. `exact`-tagged criteria never reach the model — they are checked deterministically
 * in `gradeWithCriteria` below, per the org's regulated-data rule (never trust an LLM's judgment
 * on a dilution ratio, contact time, or EPA registration number).
 */
async function gradeSemanticCriteria(params: {
  prompt: string;
  responseText: string;
  semanticCriteria: Array<{ index: number; criterion: ExpectedCriterion }>;
  modelTag?: string;
}): Promise<CriterionVerdict[]> {
  if (params.semanticCriteria.length === 0) {
    return [];
  }

  const client = getOpenAIClient();
  const model = resolveGraderModel(params.modelTag);

  const res = await retryTransportFaults(
    () =>
      client.responses.create(
        {
          model,
          instructions: GRADER_SYSTEM_PROMPT,
          input: [
            {
              role: 'user',
              type: 'message',
              content: buildUserMessage({
                prompt: params.prompt,
                responseText: params.responseText,
                criteria: params.semanticCriteria.map(({ index, criterion }) => ({
                  index,
                  concept: criterion.concept,
                })),
              }),
            },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'criteria_grading_result',
              strict: true,
              schema: GRADER_JSON_SCHEMA,
            },
          },
          store: false,
          stream: false,
          ...samplingParamsFor(model, { temperature: 0 }),
          max_output_tokens: resolveMaxOutputTokens(),
        },
        { maxRetries: 0, timeout: resolveOpenAiRequestTimeoutMs() },
      ),
    { runtime: 'responses', label: 'criteria-grader.create' },
  );

  const text = extractAssistantText(res);
  const parsedJson = JSON.parse(text) as unknown;
  const parsed = graderResponseSchema.parse(parsedJson);
  return parsed.verdicts;
}

/**
 * Literal substring check for `match: 'exact'` criteria — case-insensitive on whitespace
 * only, never on digits/units/punctuation, so "4 oz/gal" does not accidentally match
 * "4.0 oz/gal" or "40 oz/gal". This is the deterministic guardrail the business case calls
 * out as the highest-stakes payoff: a judge that "mostly" catches a wrong dilution ratio is
 * not an acceptable control.
 *
 * B0-538 — exported so the multi-turn evaluator routes every regulated-looking expectation term
 * (dilution ratios, oz/gal, mL/L, ppm, %, contact times, CAS/EPA numbers, log reductions) through
 * this exact same literal check rather than its own case-insensitive `mentions` matching.
 */
export function gradeExactCriterion(concept: string, responseText: string): CriterionVerdict {
  const found = responseText.includes(concept);
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
      exactVerdicts.push({ ...gradeExactCriterion(criterion.concept, params.responseText), criterionIndex: index });
    } else {
      semanticCriteria.push({ index, criterion });
    }
  });

  const semanticVerdicts = await gradeSemanticCriteria({
    prompt: params.prompt,
    responseText: params.responseText,
    semanticCriteria,
    modelTag: params.modelTag,
  });

  return aggregateCriteriaVerdicts(params.criteria, [...exactVerdicts, ...semanticVerdicts]);
}
