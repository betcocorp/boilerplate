/**
 * B0-314 — LLM cause/fix analysis for the post-mortem comparison feature (Phase 1 of epic B0-310).
 * Takes the pure diff from `run-comparison-diff.ts` plus both runs' `test_results.notes`, and asks
 * the model for a per-new-failure root cause + suggested fix and a one-line overall verdict.
 *
 * Same "build payload string -> call model -> safeParse the JSON response" shape as
 * `generateAndSaveRunInsights` in `run-insights.ts`, split into a pure `analyzeRunComparison` here
 * so persistence stays in `run-comparison.ts` / `repository.ts`.
 */
import { z } from 'zod';

import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';

import type { RunComparisonDiff } from './run-comparison-diff';
import type { RunComparisonVerdict } from './types';

/** Cap on how many new failures get sent to the model in one call — keeps token spend bounded on
 * runs with a large regression instead of growing the prompt without limit. Every new failure still
 * ends up in the persisted row (see `run-comparison.ts`); failures beyond the cap simply get a
 * generic cause/fix instead of an individually-analyzed one. */
const MAX_ANALYZED_FAILURES = 30;
/** Cap per notes field — run notes are free-text and can be long; truncate rather than let one
 * verbose note crowd out the failure list itself. */
const MAX_NOTES_CHARS = 4000;

const SYSTEM_PROMPT = `You are a QA analyst investigating a regression between two runs of the same RAG test suite.

You receive:
- The previous and current run's pass rate.
- Free-text notes a human left on each run (may describe a deploy, a known issue, or be empty).
- The list of test cases that PASSED in the previous run and FAIL now ("new failures").
- The list of test cases that FAILED in the previous run and PASS now ("fixes").

For each new failure, give a specific, plausible root cause and a concrete suggested fix, grounded
ONLY in the prompt text, error message, and notes provided. If the evidence does not point to a
clear cause, say so honestly (e.g. "no error message or note explains this; needs manual trace
review") instead of guessing.

Then give a one-line overall verdict — "improved", "regressed", or "flat" — plus a one-sentence
summary explaining it, grounded in the pass-rate numbers and notes.

Respond ONLY with valid JSON matching this exact schema:
{
  "verdict": "improved" | "regressed" | "flat",
  "verdictSummary": "one sentence",
  "failures": [
    { "testItemId": "<exact id from the list above>", "cause": "...", "fix": "..." }
  ]
}

Include exactly one "failures" entry for EVERY new failure listed above, using its exact testItemId.`;

export const runComparisonFailureAnalysisSchema = z.object({
  testItemId: z.string().min(1),
  cause: z.string().min(1),
  fix: z.string().min(1),
});

export const runComparisonAnalysisSchema = z.object({
  verdict: z.enum(['improved', 'regressed', 'flat']),
  verdictSummary: z.string().min(1),
  failures: z.array(runComparisonFailureAnalysisSchema),
});

export type RunComparisonFailureAnalysis = z.infer<typeof runComparisonFailureAnalysisSchema>;
export type RunComparisonAnalysis = z.infer<typeof runComparisonAnalysisSchema>;

export type AnalyzeRunComparisonResult =
  | { ok: true; analysis: RunComparisonAnalysis }
  | { ok: false; reason: 'parse_error' | 'invalid_shape' };

function truncateNotes(notes: string | null): string {
  if (!notes || notes.trim().length === 0) {
    return 'none';
  }
  return notes.length > MAX_NOTES_CHARS ? `${notes.slice(0, MAX_NOTES_CHARS)}… (truncated)` : notes;
}

function buildComparisonAnalysisPayload(params: {
  diff: RunComparisonDiff;
  currentNotes: string | null;
  previousNotes: string | null;
}): string {
  const { diff, currentNotes, previousNotes } = params;
  const analyzed = diff.newFailures.slice(0, MAX_ANALYZED_FAILURES);

  const failuresBlock = analyzed
    .map(
      (failure, i) =>
        `${i + 1}. [testItemId: ${failure.testItemId}] Prompt: "${failure.prompt.slice(0, 300)}"\n   Error: ${
          failure.errorMessage?.slice(0, 200) ?? 'none (assertion mismatch, not a runtime error)'
        }`,
    )
    .join('\n\n');

  const fixesBlock = diff.fixes
    .slice(0, 15)
    .map((fix, i) => `${i + 1}. Prompt: "${fix.prompt.slice(0, 200)}"`)
    .join('\n');

  return `## Run Comparison Statistics
Previous pass rate: ${(diff.previousPassRate * 100).toFixed(1)}%
Current pass rate: ${(diff.currentPassRate * 100).toFixed(1)}%
Delta: ${diff.scoreDelta >= 0 ? '+' : ''}${(diff.scoreDelta * 100).toFixed(1)} pts
New failures: ${diff.newFailures.length}${analyzed.length < diff.newFailures.length ? ` (showing ${analyzed.length})` : ''}
Fixes/recoveries: ${diff.fixes.length}

## Previous run notes
${truncateNotes(previousNotes)}

## Current run notes
${truncateNotes(currentNotes)}

## New failures — passed in the previous run, now failing
${analyzed.length > 0 ? failuresBlock : 'None'}

## Fixes — failed in the previous run, now passing
${diff.fixes.length > 0 ? fixesBlock : 'None'}`;
}

function deterministicVerdict(diff: RunComparisonDiff): { verdict: RunComparisonVerdict; verdictSummary: string } {
  if (diff.fixes.length > 0) {
    return {
      verdict: 'improved',
      verdictSummary: `No new failures; ${diff.fixes.length} previously-failing case(s) now pass.`,
    };
  }
  return {
    verdict: 'flat',
    verdictSummary: 'No new failures and no recoveries versus the previous run.',
  };
}

/**
 * Runs the cause/fix analysis for one comparison. Skips the LLM call entirely when there are no new
 * failures to explain — the verdict in that case is unambiguous from the diff alone, so spending a
 * model call on it would be pure cost with no judgment to add.
 */
export async function analyzeRunComparison(params: {
  diff: RunComparisonDiff;
  currentNotes: string | null;
  previousNotes: string | null;
}): Promise<AnalyzeRunComparisonResult> {
  const { diff } = params;

  if (diff.newFailures.length === 0) {
    return { ok: true, analysis: { ...deterministicVerdict(diff), failures: [] } };
  }

  const userContent = buildComparisonAnalysisPayload(params);
  const openai = getOpenAIClient();
  const model = resolveResponsesModel(undefined);

  const completion = await openai.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 3000,
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'parse_error' };
  }

  const validated = runComparisonAnalysisSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, reason: 'invalid_shape' };
  }

  return { ok: true, analysis: validated.data };
}
