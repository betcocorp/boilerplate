/**
 * Run-level "Analyze this run" AI insights for the admin test run detail page
 * (`~/components/admin/tests/RunInsightsPanel.tsx`). Reasons over a whole test run's pass/fail
 * spread and retrieval similarity — unlike `~/lib/observability/prompt-insights`, which analyzes
 * a single prompt's trace.
 *
 * B0-517 — this used to live only inline in the POST handler at
 * `~/app/api/admin/tests/runs/[runId]/insights/route.ts`, which meant `test_results.insights` was
 * populated only when someone clicked "Analyze this run" — 1 of 92 runs in practice. Extracted here
 * so `executeTestRun` (`~/lib/tests/run-executor.ts`) can call the same generation on every chat run
 * that reaches a terminal status, while the route/button keep working for on-demand re-analysis.
 *
 * Scoped to CHAT runs (`executeTestRun`) only — search runs (`~/lib/tests/search-run-executor.ts`)
 * store similarity under `response_payload.matches`, not `.sources`, so
 * `extractItemSimilarityScore` would read every item as "no retrieval happened" and the model would
 * misdiagnose a healthy search run as an agent-behavior failure.
 */
import { z } from 'zod';

import {
  completeStructuredWithUsage,
  StructuredOutputRefusedError,
  StructuredOutputTruncatedError,
} from '~/lib/llm/structured-completion';
import { resolveHarnessInsightsModel } from '~/lib/tests/harness-insights-model';

import {
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
  saveTestResultInsights,
} from './repository';
import { extractItemSimilarityScore } from './response-payload';

const INSIGHT_SYSTEM_PROMPT = `You are a QA analyst reviewing RAG (retrieval-augmented generation) test results.
You receive per-item data from a test run split into three groups:

1. FAILED — NO RETRIEVAL: items that failed AND have no similarity score. This means the agent never called any search tools — it either refused, errored before tool use, or returned a direct response without querying the corpus. This is NOT a corpus gap; it is an agent behavior problem (routing, prompt engineering, or tool-calling configuration).

2. FAILED — WITH RETRIEVAL: items that failed but DO have a similarity score. RAG ran, but the result was still wrong. Low scores here suggest corpus gaps or retrieval tuning issues; high scores with failure suggest evaluation or answer-grounding problems.

3. PASSED — LOW SIMILARITY: items that passed but retrieved poorly (similarity < 0.6). These are at risk of regressing and may indicate the agent is guessing rather than grounding answers.

Your task: identify the top 3 most impactful, specific, actionable improvements to raise similarity scores and pass rate. Use ONLY the data provided as evidence. Do NOT attribute "no similarity score" failures to corpus gaps — those are agent behavior failures.

Categories:
- agent: agent refused or skipped tool calls (use for group 1 failures)
- corpus: missing or poor quality documents in the RAG corpus
- retrieval: embedding or search parameter tuning
- evaluation: pass/fail criteria issues

Respond ONLY with valid JSON matching this exact schema:
{
  "insights": [
    {
      "rank": 1,
      "title": "short title (max 60 chars)",
      "description": "2-3 sentences with specific evidence from the data",
      "category": "agent",
      "impact": "high"
    }
  ]
}

category must be one of: agent, corpus, retrieval, evaluation
impact must be one of: high, medium, low`;

export const runInsightSchema = z.object({
  rank: z.number().int(),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(['agent', 'corpus', 'retrieval', 'evaluation']),
  impact: z.enum(['high', 'medium', 'low']),
});

export const runInsightsResponseSchema = z.object({
  insights: z.array(runInsightSchema).min(1),
});

/**
 * B0-906 — JSON Schema mirror of `runInsightsResponseSchema` for the provider seam's strict
 * structured output. Strict means `additionalProperties: false` with every property required, on
 * both providers. It replaces the looser `response_format: { type: 'json_object' }` this call used
 * on the OpenAI Chat Completions API, so a malformed shape is now impossible rather than caught by
 * the `invalid_shape` branch below.
 */
export const RUN_INSIGHTS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['insights'],
  properties: {
    insights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rank', 'title', 'description', 'category', 'impact'],
        properties: {
          rank: { type: 'integer' },
          title: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string', enum: ['agent', 'corpus', 'retrieval', 'evaluation'] },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;

export type RunInsight = z.infer<typeof runInsightSchema>;

type AnalysisItem = {
  prompt: string;
  passed: boolean;
  similarity: number | null;
  errorMessage: string | null;
  elapsedMs: number;
};

type RunStats = {
  total: number;
  passed: number;
  failed: number;
  failedNoRetrieval: number;
  failedWithRetrieval: number;
  avgSimilarity: number | null;
  minSimilarity: number | null;
  maxSimilarity: number | null;
};

function fmtItem(item: AnalysisItem, i: number): string {
  return `${i + 1}. Prompt: "${item.prompt.slice(0, 200)}"\n   Similarity: ${item.similarity !== null ? item.similarity.toFixed(3) : 'none — retrieval skipped'}\n   Error: ${item.errorMessage?.slice(0, 150) ?? 'none'}`;
}

function buildAnalysisPayload(items: AnalysisItem[], stats: RunStats): string {
  const failedNoRetrieval = items.filter((i) => !i.passed && i.similarity === null).slice(0, 15);
  const failedWithRetrieval = items.filter((i) => !i.passed && i.similarity !== null).slice(0, 15);
  const lowSimPassed = items
    .filter((i) => i.passed && i.similarity !== null && i.similarity < 0.6)
    .slice(0, 10);

  const passRate = stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0;
  const failRate = stats.total > 0 ? Math.round((stats.failed / stats.total) * 100) : 0;

  return `## Run Statistics
Total items: ${stats.total}
Passed: ${stats.passed} (${passRate}%)
Failed: ${stats.failed} (${failRate}%)
  - Failed with NO retrieval (agent skipped tool calls): ${stats.failedNoRetrieval}
  - Failed WITH retrieval (RAG ran but still wrong): ${stats.failedWithRetrieval}
Avg similarity (items where retrieval ran): ${stats.avgSimilarity !== null ? stats.avgSimilarity.toFixed(3) : 'n/a'}
Min similarity: ${stats.minSimilarity !== null ? stats.minSimilarity.toFixed(3) : 'n/a'}
Max similarity: ${stats.maxSimilarity !== null ? stats.maxSimilarity.toFixed(3) : 'n/a'}

## Group 1 — FAILED, NO RETRIEVAL (${failedNoRetrieval.length} of ${stats.failedNoRetrieval} shown)
These items failed without the agent ever calling a search tool.
${failedNoRetrieval.length > 0 ? failedNoRetrieval.map(fmtItem).join('\n\n') : 'None'}

## Group 2 — FAILED, WITH RETRIEVAL (${failedWithRetrieval.length} of ${stats.failedWithRetrieval} shown)
These items had RAG search run but still failed.
${failedWithRetrieval.length > 0 ? failedWithRetrieval.map(fmtItem).join('\n\n') : 'None'}

## Group 3 — PASSED, LOW SIMILARITY (<0.6) — ${lowSimPassed.length} shown
${lowSimPassed.length > 0 ? lowSimPassed.map((item, i) => `${i + 1}. Prompt: "${item.prompt.slice(0, 200)}" | Similarity: ${item.similarity?.toFixed(3) ?? 'n/a'}`).join('\n') : 'None'}`;
}

export type GenerateRunInsightsResult =
  | { ok: true; insights: RunInsight[]; generatedAt: string }
  | { ok: false; reason: 'no_items' | 'parse_error' | 'invalid_shape' };

/**
 * Builds the analysis payload for `runId`, calls the model, validates the response, and persists
 * it via `saveTestResultInsights`. Shared by the on-demand POST route and the automatic
 * run-completion hook in `~/lib/tests/run-executor.ts` — callers decide how to surface failures
 * (HTTP status vs. a logged warning that does not fail the run).
 */
export async function generateAndSaveRunInsights(
  runId: string,
): Promise<GenerateRunInsightsResult> {
  const run = await getTestResultById(runId);

  const [resultItems, testItems] = await Promise.all([
    listAllResultItemsByResultId(run.id),
    getTestItemsByTestId(run.test_id),
  ]);

  if (resultItems.length === 0) {
    return { ok: false, reason: 'no_items' };
  }

  const promptByItemId = new Map(testItems.map((item) => [item.id, item.prompt]));

  const items: AnalysisItem[] = resultItems.map((item) => ({
    prompt: promptByItemId.get(item.test_item_id) ?? '',
    passed: item.passed,
    similarity: extractItemSimilarityScore(item.response_payload),
    errorMessage: item.error_message ?? null,
    elapsedMs: item.elapsed_ms ?? 0,
  }));

  const similarities = items
    .map((i) => i.similarity)
    .filter((s): s is number => s !== null);

  const failed = items.filter((i) => !i.passed);
  const stats: RunStats = {
    total: items.length,
    passed: items.filter((i) => i.passed).length,
    failed: failed.length,
    failedNoRetrieval: failed.filter((i) => i.similarity === null).length,
    failedWithRetrieval: failed.filter((i) => i.similarity !== null).length,
    avgSimilarity:
      similarities.length > 0
        ? similarities.reduce((a, b) => a + b, 0) / similarities.length
        : null,
    minSimilarity: similarities.length > 0 ? Math.min(...similarities) : null,
    maxSimilarity: similarities.length > 0 ? Math.max(...similarities) : null,
  };

  const userContent = buildAnalysisPayload(items, stats);

  /**
   * B0-906 — one structured call through the provider seam (`~/lib/llm/structured-completion`),
   * which routes on the resolved model id: a `claude-*` tag from the `HARNESS_INSIGHTS_MODEL` row
   * goes to the Anthropic Messages API, anything else to the OpenAI Responses API. Replaces a
   * hardcoded `gpt-4.1-mini` on the legacy Chat Completions API. `temperature` is still 0.3 for
   * OpenAI and is dropped for Claude models, which reject sampling controls.
   */
  const model = await resolveHarnessInsightsModel();

  let raw: string;
  try {
    raw = (
      await completeStructuredWithUsage({
        model,
        system: INSIGHT_SYSTEM_PROMPT,
        user: userContent,
        schemaName: 'run_insights',
        schema: RUN_INSIGHTS_JSON_SCHEMA,
        maxOutputTokens: 1200,
        temperature: 0.3,
      })
    ).text;
  } catch (error) {
    // A truncated or refused answer is not an insight set; surface it the same way an unparseable
    // one already was, so the caller keeps its existing two failure branches.
    if (
      error instanceof StructuredOutputTruncatedError ||
      error instanceof StructuredOutputRefusedError
    ) {
      return { ok: false, reason: 'parse_error' };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'parse_error' };
  }

  const validated = runInsightsResponseSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, reason: 'invalid_shape' };
  }

  const saved = await saveTestResultInsights(run.id, validated.data.insights);

  return {
    ok: true,
    insights: validated.data.insights,
    generatedAt: saved.insights_generated_at ?? new Date().toISOString(),
  };
}
