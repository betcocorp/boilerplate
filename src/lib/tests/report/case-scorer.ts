import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { samplingParamsFor } from '~/lib/openai/model-capabilities';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';

import { caseScoreSchema, type CaseScore } from './schemas';

/**
 * Strict json_schema for the grading call (B0-453), mirrored by hand from `caseScoreSchema`
 * rather than generated, matching the pattern in
 * `src/lib/workflows/product-support/validator.ts`. Numeric bounds (0-100) are enforced by the
 * system prompt + post-parse clamping rather than JSON Schema `minimum`/`maximum`, which strict
 * mode does not support.
 */
const CASE_SCORE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    unableToEvaluate: {
      type: 'boolean',
      description:
        'true only if this case cannot reasonably be judged: no actual response, an empty/corrupted response, or an expected answer too ambiguous to score.',
    },
    uteReason: {
      type: ['string', 'null'],
      description: 'One-line reason, required when unableToEvaluate is true; otherwise null.',
    },
    accuracy: { type: ['number', 'null'], description: '0-100, or null when unableToEvaluate.' },
    completeness: { type: ['number', 'null'], description: '0-100, or null when unableToEvaluate.' },
    relevance: { type: ['number', 'null'], description: '0-100, or null when unableToEvaluate.' },
    clarity: { type: ['number', 'null'], description: '0-100, or null when unableToEvaluate.' },
    explanation: {
      type: 'string',
      description: 'Why these scores, citing specific evidence from expected vs. actual. Empty string when unableToEvaluate.',
    },
    missed: {
      type: 'string',
      description: 'Important expected information the response omitted. Empty string if none.',
    },
    incorrect: {
      type: 'string',
      description:
        'Incorrect, misleading, unsupported, or unverified information — name specific regulated values (dilution, ppm, EPA/CAS, log-reduction) that need confirming. Empty string if none.',
    },
    improvement: {
      type: 'string',
      description: 'The single most useful fix for this case. Empty string when unableToEvaluate.',
    },
  },
  required: [
    'unableToEvaluate',
    'uteReason',
    'accuracy',
    'completeness',
    'relevance',
    'clarity',
    'explanation',
    'missed',
    'incorrect',
    'improvement',
  ],
} as const;

const CASE_SCORING_SYSTEM_PROMPT = `You are grading one AI agent response against a golden-dataset expected answer, following Betco's internal agent-evaluation methodology. The golden dataset is the source of truth; judge substantive correctness, not wording.

Score four sub-scores, each 0-100:
- Accuracy (40% weight): is the response factually correct against the expected answer/behavior?
- Completeness (30%): did it include the important expected information?
- Relevance (20%): did it directly address the question without unrelated filler?
- Clarity (10%): was it clear, understandable, and well structured?
Do not compute or report an overall/weighted score yourself — only the four sub-scores.

Be rigorous but fair: do not require exact phrase matching. Reward a substantively correct answer even if wording, ordering, or extra helpful detail differs from the golden. Penalize confident wrongness and missing must-have content. Unsupported, fabricated, or materially incorrect information must significantly reduce Accuracy (and usually Relevance) — a confident wrong answer is worse than an incomplete one, especially for regulated content.

Regulated-data caveat: many expected answers are structural templates with placeholders like "[insert label-confirmed dilution rate]" — they define expected behavior and sourcing, not a literal fact to match. When the response supplies specific regulated values (dilution ratios, oz/gal, mL/L, ppm, %, contact times, CAS numbers, EPA registration numbers, log-reduction values) that you cannot verify against the expected answer or sources given to you: do not reward them as correct nor mark them wrong purely for being unverifiable; grade on whether the response produced the expected behavior and cited the right source; and call the specific values out under "incorrect" as items to confirm. A response that fabricates a regulated value not present in the source, or that contradicts the golden, is materially incorrect — cut Accuracy hard.

Mark unableToEvaluate=true (with a one-line uteReason, and null for uteReason otherwise) only if the case truly cannot be judged: no actual response was provided, the response is empty or corrupted, or the expected answer is too ambiguous to score. Do not invent information to force a score. When unableToEvaluate is true, set all four sub-scores to null and leave explanation/missed/incorrect/improvement as empty strings.

Ground every sub-score and every field in specific evidence from the expected and actual text given to you.`;

export type CaseScoringInput = {
  question: string;
  category: string | null;
  priorityRaw: number | null;
  idealResponse: string | null;
  expectedConcepts: string | null;
  minimumConcepts: string | null;
  expectedSources: string | null;
  expectedShouldAnswer: boolean | null;
  actualResponseText: string;
  modelTag?: string;
};

function buildUserPayload(input: CaseScoringInput): string {
  return JSON.stringify(
    {
      question: input.question,
      category: input.category,
      priority: input.priorityRaw,
      expected: {
        ideal_response: input.idealResponse,
        expected_concepts: input.expectedConcepts,
        minimum_concepts: input.minimumConcepts,
        expected_sources: input.expectedSources,
        expected_should_answer: input.expectedShouldAnswer,
      },
      actual_response: input.actualResponseText,
    },
    null,
    2,
  );
}

function clampScore(value: number | null): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return Math.min(100, Math.max(0, value));
}

export async function scoreCase(input: CaseScoringInput): Promise<CaseScore> {
  const client = getOpenAIClient();
  const model = resolveResponsesModel(input.modelTag ?? 'gpt-4.1');

  try {
    const res = await client.responses.create({
      model,
      instructions: CASE_SCORING_SYSTEM_PROMPT,
      input: [{ role: 'user', content: buildUserPayload(input), type: 'message' }],
      text: {
        format: {
          type: 'json_schema',
          name: 'case_score',
          strict: true,
          schema: CASE_SCORE_JSON_SCHEMA,
        },
      },
      store: false,
      stream: false,
      ...samplingParamsFor(model, { temperature: 0 }),
    });

    const text = extractAssistantText(res);
    const parsed = caseScoreSchema.parse(JSON.parse(text));
    return {
      ...parsed,
      accuracy: clampScore(parsed.accuracy),
      completeness: clampScore(parsed.completeness),
      relevance: clampScore(parsed.relevance),
      clarity: clampScore(parsed.clarity),
    };
  } catch (error) {
    return {
      unableToEvaluate: true,
      uteReason: `Grading call failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      accuracy: null,
      completeness: null,
      relevance: null,
      clarity: null,
      explanation: '',
      missed: '',
      incorrect: '',
      improvement: '',
    };
  }
}
