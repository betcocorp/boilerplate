'use server';

import { replaceAiSuggestions } from '~/lib/ai-suggestions/repository';
import { getOpenAIClient } from '~/lib/openai/client';

export type ItemHistoryRow = {
  passed: boolean;
  status: string;
  errorMessage: string | null;
  responseText: string | null;
  elapsedMs: number | null;
  similarityMin: number | null;
  similarityMax: number | null;
  similarityAvg: number | null;
  ragSearchMs: number | null;
};

export type AnalyzeTestItemPayload = {
  itemId: string;
  testName: string;
  prompt: string;
  expectedShouldAnswer: boolean | null;
  historyRows: ItemHistoryRow[];
};

export type AiSuggestion = {
  id: string;
  title: string;
  content: string;
  sort_order: number;
  model: string | null;
  created_at: string;
};

function formatHistoryForPrompt(rows: ItemHistoryRow[]): string {
  if (rows.length === 0) {
    return 'No historical runs available.';
  }

  return rows
    .map((row, i) => {
      const parts: string[] = [
        `Run ${i + 1}: ${row.passed ? 'PASSED' : 'FAILED'} (status: ${row.status})`,
      ];
      if (row.elapsedMs !== null) {
        parts.push(`  Prompt elapsed: ${(row.elapsedMs / 1000).toFixed(2)}s`);
      }
      if (row.ragSearchMs !== null) {
        parts.push(`  RAG search: ${(row.ragSearchMs / 1000).toFixed(2)}s`);
      }
      if (
        row.similarityMin !== null ||
        row.similarityMax !== null ||
        row.similarityAvg !== null
      ) {
        const fmt = (v: number | null) =>
          v !== null ? `${(v * 100).toFixed(1)}%` : 'n/a';
        parts.push(
          `  Similarity min/max/avg: ${fmt(row.similarityMin)} / ${fmt(row.similarityMax)} / ${fmt(row.similarityAvg)}`,
        );
      }
      if (row.errorMessage) {
        parts.push(`  Error: ${row.errorMessage}`);
      }
      if (row.responseText) {
        const snippet = row.responseText.slice(0, 400);
        parts.push(
          `  Response snippet: ${snippet}${row.responseText.length > 400 ? '…' : ''}`,
        );
      }
      return parts.join('\n');
    })
    .join('\n\n');
}

const MODEL = 'gpt-4.1-mini';

export async function analyzeTestItem(
  payload: AnalyzeTestItemPayload,
): Promise<AiSuggestion[]> {
  const client = getOpenAIClient();

  const totalRuns = payload.historyRows.length;
  const passCount = payload.historyRows.filter((r) => r.passed).length;
  const failCount = totalRuns - passCount;
  const passRate =
    totalRuns > 0 ? ((passCount / totalRuns) * 100).toFixed(0) : '0';

  const systemPrompt = `You are a QA/AI system analyst. You review prompt-level test results for an AI agent system and provide clear, actionable recommendations.

You must respond with ONLY a valid JSON object in this exact shape:
{"suggestions":[{"title":"...","content":"..."},{"title":"...","content":"..."},{"title":"...","content":"..."}]}

Rules:
- Exactly 3 items in the "suggestions" array.
- "title": 5-10 words, plain text, no markdown.
- "content": 2-4 sentences of actionable explanation, plain text, no markdown.
- No other keys, no extra text outside the JSON object.`;

  const userMessage = `Test: ${payload.testName}
Prompt: ${payload.prompt}
Expected should-answer: ${payload.expectedShouldAnswer === null ? 'Not set' : payload.expectedShouldAnswer ? 'Yes (the AI should answer)' : 'No (the AI should decline)'}
Pass rate: ${passRate}% (${passCount} passed / ${failCount} failed out of ${totalRuns} total runs)

Historical Outcomes (newest first):
${formatHistoryForPrompt(payload.historyRows)}

Provide the top 3 specific, actionable recommendations to make this test item reliably pass.`;

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 800,
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    throw new Error('No response from AI analysis.');
  }

  let parsed: Array<{ title: string; content: string }>;
  try {
    const wrapper = JSON.parse(raw) as unknown;
    let arr: unknown[];

    if (Array.isArray(wrapper)) {
      arr = wrapper;
    } else if (wrapper && typeof wrapper === 'object') {
      const obj = wrapper as Record<string, unknown>;
      // Try common wrapper keys first, then fall back to first array-valued key
      const knownKey = ['suggestions', 'recommendations', 'items', 'results'].find(
        (k) => Array.isArray(obj[k]),
      );
      if (knownKey) {
        arr = obj[knownKey] as unknown[];
      } else {
        const firstArrayVal = Object.values(obj).find((v) => Array.isArray(v));
        arr = Array.isArray(firstArrayVal) ? firstArrayVal : Object.values(obj);
      }
    } else {
      throw new Error('Unexpected shape');
    }

    parsed = (arr as Array<{ title: string; content: string }>)
      .filter((s) => s && typeof s === 'object' && typeof s.title === 'string' && typeof s.content === 'string')
      .slice(0, 3);

    if (parsed.length === 0) {
      throw new Error('No valid suggestions found in response');
    }
  } catch (err) {
    throw new Error(
      `AI returned an unexpected format — ${err instanceof Error ? err.message : String(err)}. Please try again.`,
    );
  }

  const saved = await replaceAiSuggestions(
    'item',
    payload.itemId,
    parsed.map((s) => ({ title: s.title, content: s.content, model: MODEL })),
  );

  return saved;
}
