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
export async function resolveGraderModel(modelTag?: string): Promise<string> {
  return (
    process.env.BEX_GRADER_MODEL?.trim() || resolveResponsesModel(modelTag ?? 'preview')
  );
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
  const model = await resolveGraderModel(params.modelTag);

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

  const rawSemanticVerdicts = await gradeSemanticCriteria({
    prompt: params.prompt,
    responseText: params.responseText,
    semanticCriteria,
    modelTag: params.modelTag,
  });

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

  return aggregateCriteriaVerdicts(params.criteria, [...exactVerdicts, ...semanticVerdicts]);
}
