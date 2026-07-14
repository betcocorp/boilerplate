import { NextResponse } from 'next/server';

export const maxDuration = 60;

import { getOpenAIClient } from '~/lib/openai/client';
import {
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
} from '~/lib/tests/repository';
import { extractItemSimilarityScore } from '~/lib/tests/response-payload';

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

export async function POST(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;

  const run = await getTestResultById(runId).catch(() => null);
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  const [resultItems, testItems] = await Promise.all([
    listAllResultItemsByResultId(run.id),
    getTestItemsByTestId(run.test_id),
  ]);

  if (resultItems.length === 0) {
    return NextResponse.json(
      { error: 'No completed items in this run to analyze.' },
      { status: 422 },
    );
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

  const openai = getOpenAIClient();
  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: INSIGHT_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 1200,
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Failed to parse analysis response.' }, { status: 500 });
  }

  const data = parsed as Record<string, unknown>;
  if (!Array.isArray(data.insights)) {
    return NextResponse.json({ error: 'Unexpected analysis response shape.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, insights: data.insights });
}
