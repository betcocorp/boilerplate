import { z } from 'zod';

import { replaceAiSuggestions } from '~/lib/ai-suggestions/repository';
import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { samplingParamsFor } from '~/lib/openai/model-capabilities';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';
import {
  resolveOpenAiRequestTimeoutMs,
  retryTransportFaults,
} from '~/lib/openai/transport-retry';
import { resolveMaxOutputTokens } from '~/lib/workflows/product-support/max-output-tokens';
import { logWarn } from '~/lib/observability/logger';

import type { CriteriaGradingOutcome } from './criteria-schemas';

/**
 * B0-617 — the entity_type scope this feature owns in the generic
 * `ai_suggestions` store (~/lib/ai-suggestions/repository.ts), alongside the
 * existing `'item'` and `'workflow_run'` scopes. entity_id is the failing
 * `test_result_items.id`.
 */
export const FAILURE_ROOT_CAUSE_ENTITY_TYPE = 'test_result_item_failure';

/** Mirrors the category vocabulary already used by the per-run insights prompt
 * (~/lib/tests/run-insights.ts) so a failure's root cause and a run's top-3
 * recommendations read as the same taxonomy across the admin UI. */
const FAILURE_CATEGORIES = ['agent', 'corpus', 'retrieval', 'evaluation'] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

const CATEGORY_LABEL: Record<FailureCategory, string> = {
  agent: 'Agent behavior',
  corpus: 'Corpus gap',
  retrieval: 'Retrieval tuning',
  evaluation: 'Eval/expectation mismatch',
};

const rootCauseResultSchema = z.object({
  category: z.enum(FAILURE_CATEGORIES),
  root_cause: z.string().min(1),
  suggested_fix: z.string().min(1),
});
type RootCauseResult = z.infer<typeof rootCauseResultSchema>;

const ROOT_CAUSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: {
      type: 'string',
      enum: FAILURE_CATEGORIES as unknown as string[],
      description:
        'agent = refused/skipped tools/misrouted; corpus = missing or poor-quality source docs; retrieval = embedding/search tuning; evaluation = the expectation or grading rule itself looks wrong.',
    },
    root_cause: {
      type: 'string',
      description: '1-2 sentences naming the specific, evidenced reason this item failed.',
    },
    suggested_fix: {
      type: 'string',
      description: '1-2 sentences: the specific, actionable next step to fix it.',
    },
  },
  required: ['category', 'root_cause', 'suggested_fix'],
} as const;

const ROOT_CAUSE_SYSTEM_PROMPT = `You are a QA analyst diagnosing why a single AI agent test item failed.

Use ONLY the evidence given. Name the specific failure — which criterion, tool call, or expectation — never a generic restatement of "the answer was wrong". Pick exactly one category:
- agent: the agent refused, skipped tool calls, or misrouted, independent of whether the corpus had the answer.
- corpus: the retrieved/available source documents are missing or insufficient for a correct answer.
- retrieval: relevant sources likely exist but were not surfaced (embedding, ranking, or query issue).
- evaluation: the test's own expectation or grading rule looks wrong given what the agent actually returned.

Respond with ONLY the JSON object in the given schema. No markdown, no extra keys.`;

export async function resolveFailureRootCauseModel(modelTag?: string): Promise<string> {
  return (
    process.env.BEX_FAILURE_ROOT_CAUSE_MODEL?.trim() ||
    resolveResponsesModel(modelTag ?? 'preview')
  );
}

export type FailureRootCauseInput = {
  testResultItemId: string;
  testName: string;
  prompt: string;
  expectedShouldAnswer: boolean | null;
  responseText: string | null;
  errorMessage: string | null;
  /** Present only for chat-eval items graded against `expected_criteria` (B0-616). */
  criteriaGrading?: CriteriaGradingOutcome | null;
  /** Present only for search/retrieval-eval items (search-run-executor.ts). */
  retrieval?: {
    similarityMin: number | null;
    similarityMax: number | null;
    matchCount: number;
  } | null;
  modelTag?: string;
};

function buildEvidenceBlock(input: FailureRootCauseInput): string {
  const parts: string[] = [
    `Test: ${input.testName}`,
    `Prompt: ${input.prompt}`,
    `Expected should-answer: ${
      input.expectedShouldAnswer === null
        ? 'not set'
        : input.expectedShouldAnswer
          ? 'yes'
          : 'no (should decline)'
    }`,
  ];

  if (input.errorMessage) {
    parts.push(`Failure reason recorded by the harness: ${input.errorMessage}`);
  }

  if (input.criteriaGrading && input.criteriaGrading.verdicts.length > 0) {
    const criteriaLines = input.criteriaGrading.verdicts
      .map(
        (v) =>
          `  - [tier ${v.tier}, ${v.match}] "${v.concept}" — ${v.met ? 'MET' : 'NOT MET'}${
            v.evidence ? ` (evidence: "${v.evidence}")` : ''
          }`,
      )
      .join('\n');
    parts.push(`Per-criterion grading:\n${criteriaLines}`);
  }

  if (input.retrieval) {
    parts.push(
      `Retrieval: ${input.retrieval.matchCount} matches, similarity min/max ${
        input.retrieval.similarityMin !== null ? input.retrieval.similarityMin.toFixed(3) : 'n/a'
      }/${input.retrieval.similarityMax !== null ? input.retrieval.similarityMax.toFixed(3) : 'n/a'}`,
    );
  }

  if (input.responseText) {
    const snippet = input.responseText.slice(0, 1200);
    parts.push(
      `Response${input.responseText.length > 1200 ? ' (truncated)' : ''}: ${snippet}`,
    );
  } else {
    parts.push('Response: (empty)');
  }

  return parts.join('\n\n');
}

async function callRootCauseGrader(
  input: FailureRootCauseInput,
): Promise<RootCauseResult | null> {
  const client = getOpenAIClient();
  const model = await resolveFailureRootCauseModel(input.modelTag);

  try {
    const res = await retryTransportFaults(
      () =>
        client.responses.create(
          {
            model,
            instructions: ROOT_CAUSE_SYSTEM_PROMPT,
            input: [{ role: 'user', type: 'message', content: buildEvidenceBlock(input) }],
            text: {
              format: {
                type: 'json_schema',
                name: 'failure_root_cause',
                strict: true,
                schema: ROOT_CAUSE_JSON_SCHEMA,
              },
            },
            store: false,
            stream: false,
            ...samplingParamsFor(model, { temperature: 0.2 }),
            max_output_tokens: resolveMaxOutputTokens(),
          },
          { maxRetries: 0, timeout: resolveOpenAiRequestTimeoutMs() },
        ),
      { runtime: 'responses', label: 'failure-root-cause.create' },
    );

    const text = extractAssistantText(res);
    return rootCauseResultSchema.parse(JSON.parse(text));
  } catch (error) {
    logWarn('failure_root_cause_generation_failed', {
      testResultItemId: input.testResultItemId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Auto-fires the moment a test_result_item is recorded as failed (called from
 * run-executor.ts and search-run-executor.ts right after `insertTestResultItems`).
 * Never throws — a root-cause failure must not take down the eval run itself; the
 * failure queue simply shows "pending" for that row until the next attempt.
 */
export async function analyzeAndPersistFailureRootCause(
  input: FailureRootCauseInput,
): Promise<void> {
  const result = await callRootCauseGrader(input);
  if (!result) {
    return;
  }

  const model = await resolveFailureRootCauseModel(input.modelTag);

  await replaceAiSuggestions(FAILURE_ROOT_CAUSE_ENTITY_TYPE, input.testResultItemId, [
    {
      title: CATEGORY_LABEL[result.category],
      content: `${result.root_cause} ${result.suggested_fix}`,
      model,
      metadata: {
        category: result.category,
        rootCause: result.root_cause,
        suggestedFix: result.suggested_fix,
      },
    },
  ]).catch((error: unknown) => {
    logWarn('failure_root_cause_persist_failed', {
      testResultItemId: input.testResultItemId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}
