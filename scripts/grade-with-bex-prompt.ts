#!/usr/bin/env -S npx tsx
/**
 * B0-854 — a reproducible "desktop-style" grading run of a Bex test run that uses Bex's grader
 * exactly: `CASE_SCORING_SYSTEM_PROMPT` verbatim, `GRADER_JSON_SCHEMA` strict, one case per
 * stateless call, the same provider/model/effort the run's own report was graded with — but
 * outside the report pipeline, so nothing it produces is written back to `report_state`.
 *
 * Why: the B0-824 parity study compared Bex's report with the desktop agent-evaluation skill, whose
 * grader differs in CONTEXT (whole SKILL.md + methodology, all 20 cases in one conversation,
 * free-form JSON). This script holds the prompt and the context constant so the residual the
 * `compare-eval-runs.ts` table shows is grader (model) variance alone, with no prompt or rounding
 * caveat (rounding: B0-851).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/grade-with-bex-prompt.ts <runId> --out <dir> [--passes 3] [--concurrency 4]
 *
 * Output (in --out): eval_run1.json … eval_runN.json in the agent-evaluation skill's schema, built by
 * the same `buildEvalRunDocument` the exporter uses, plus `grades.jsonl` — a checkpoint of every
 * (item, pass) grade as it lands, so an interrupted run resumes without re-paying for finished calls.
 *
 * Guards, before any API call is made:
 *   - `GRADING_PROMPT_HASH` must equal the run's `report_state.gradingPromptHash` — a changed prompt
 *     makes the comparison meaningless, so the script exits 2 and grades nothing.
 *   - the resolved model's provider must be callable from this host (`describeGradingProviderGap`).
 * A provider error that reads like billing/credit exhaustion aborts immediately with the exact
 * message; any other grading failure is retried once, then aborts (the checkpoint keeps what landed).
 *
 * Read-only against Supabase. Requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the
 * grading provider's key (ANTHROPIC_API_KEY for a `claude-*` model, OPENAI_API_KEY otherwise).
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { modelProviderFor } from '~/lib/constants/models';
import { assembleReportCases, indexLatestResultItems } from '~/lib/tests/report/assemble';
import {
  GRADER_JSON_SCHEMA,
  GRADING_PROMPT_HASH,
  GRADING_PROMPT_VERSION,
  scoreCase,
  unableToEvaluateScore,
  type CaseScoringInput,
} from '~/lib/tests/report/case-scorer';
import { buildEvalRunDocument } from '~/lib/tests/report/eval-json-export';
import { resolveExpectedSourceRefs } from '~/lib/tests/report/expected-sources';
import { loadExpectedSourceIndexForItems } from '~/lib/tests/report/expected-sources-repository';
import { describeGradingProviderGap, effortFromState } from '~/lib/tests/report/grading-model';
import { resolveReportCategory } from '~/lib/tests/report/report-category';
import {
  GRADING_CALL_FAILED_PREFIX,
  parseReportState,
  type CaseScore,
} from '~/lib/tests/report/schemas';
import {
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
} from '~/lib/tests/repository';
import type { TestItemRecord, TestResultItemRecord } from '~/lib/tests/types';

type Options = { runId: string; outDir: string; passes: number | null; concurrency: number };

const USAGE =
  'Usage: npx tsx --env-file=.env.local scripts/grade-with-bex-prompt.ts <runId> --out <dir> [--passes 3] [--concurrency 4]';

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value.\n${USAGE}`);
      flags.set(arg, value);
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  const runId = positional[0];
  const outDir = flags.get('--out');
  if (!runId || !outDir || positional.length !== 1) throw new Error(USAGE);
  const intFlag = (flag: string, fallback: number | null): number | null => {
    const raw = flags.get(flag);
    if (raw === undefined) return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer, got "${raw}".`);
    return value;
  };
  return {
    runId,
    outDir: path.resolve(outDir),
    passes: intFlag('--passes', null),
    concurrency: intFlag('--concurrency', 4) ?? 4,
  };
}

/** `grades.jsonl` line: one (item, pass) grade. */
type CheckpointLine = { itemId: string; passIndex: number; score: CaseScore; gradedAt: string };

async function readCheckpoint(file: string): Promise<CheckpointLine[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CheckpointLine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Mirrors `scoreOnePass` in `orchestrator.ts`: the same input, built the same way, from the same rows. */
function buildInput(
  item: TestItemRecord,
  resultItem: TestResultItemRecord | undefined,
  expectedSourceIndex: Awaited<ReturnType<typeof loadExpectedSourceIndexForItems>>,
  model: string,
  effort: CaseScoringInput['effort'],
): { input: CaseScoringInput } | { noResponse: CaseScore } {
  const responseText = resultItem?.response_text?.trim();
  if (!resultItem) {
    return { noResponse: unableToEvaluateScore('No result recorded for this item in this run.') };
  }
  if (!responseText) {
    return {
      noResponse: unableToEvaluateScore(
        resultItem.error_message
          ? `No response text recorded; harness error: ${resultItem.error_message}`
          : 'No response text recorded for this item in this run.',
      ),
    };
  }
  return {
    input: {
      question: item.prompt,
      category: resolveReportCategory(item),
      priorityRaw: item.priority,
      idealResponse: item.ideal_response,
      expectedSources: resolveExpectedSourceRefs(item.expected_sources, expectedSourceIndex),
      shouldCite: item.should_cite,
      mandatoryConcepts: item.minimum_concepts,
      expectedConcepts: item.expected_concepts,
      actualResponseText: responseText,
      modelTag: model,
      effort,
    },
  };
}

const BILLING_PATTERN = /credit|billing|insufficient|quota|payment|402/i;

class GradingAborted extends Error {}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const run = await getTestResultById(options.runId);
  const test = await getTestById(run.test_id);
  const [items, resultItems] = await Promise.all([
    getTestItemsByTestId(run.test_id),
    listAllResultItemsByResultId(run.id),
  ]);
  const state = parseReportState(run.report_state);
  if (!state) throw new Error(`Run ${options.runId} has no parseable report_state — generate its report first.`);

  // ---- guard 1: the prompt is the one the report was graded with
  console.log(`Run ${run.id} — "${test.name}" — report ${state.status}, model ${state.model} @ ${state.gradingEffort ?? 'n/a'}, ${state.passes} pass(es)`);
  console.log(`Prompt hash (code)   ${GRADING_PROMPT_HASH} (${GRADING_PROMPT_VERSION})`);
  console.log(`Prompt hash (report) ${state.gradingPromptHash ?? 'null'}`);
  if (state.gradingPromptHash !== GRADING_PROMPT_HASH) {
    console.error('STOP: CASE_SCORING_SYSTEM_PROMPT has changed since this report was graded; a comparison would be invalid. No grading calls were made.');
    process.exit(2);
  }

  // ---- guard 2: the provider can be called from here
  const model = state.model;
  const gap = describeGradingProviderGap(model);
  if (gap) {
    console.error(`STOP: ${gap}`);
    process.exit(2);
  }
  if (modelProviderFor(model) !== 'anthropic' && !process.env.OPENAI_API_KEY?.trim()) {
    console.error(`STOP: ${model} is an OpenAI model but OPENAI_API_KEY is not set. No grading calls were made.`);
    process.exit(2);
  }
  const effort = effortFromState(state.gradingEffort);
  const passes = options.passes ?? state.passes;

  // ---- inputs: the exact rows the report graded, assembled once
  const expectedSourceIndex = await loadExpectedSourceIndexForItems(items);
  const resultItemByTestItemId = indexLatestResultItems(resultItems);
  const assembled = assembleReportCases({
    test,
    run,
    items,
    resultItems,
    caseScores: state.caseScores,
    casePassScores: state.casePassScores,
    spreadThreshold: state.spreadThreshold,
    passMark: state.passMark,
    judgedThresholds: state.judgedThresholds,
    scoringRules: state.scoringRules,
    expectedSourceIndex,
    invariantSeverity: 'warn',
  });

  await mkdir(options.outDir, { recursive: true });
  const checkpointFile = path.join(options.outDir, 'grades.jsonl');
  const done = new Map<string, CaseScore>();
  for (const line of await readCheckpoint(checkpointFile)) {
    done.set(`${line.itemId}#${line.passIndex}`, line.score);
  }

  type Job = { item: TestItemRecord; passIndex: number };
  const jobs: Job[] = [];
  for (let passIndex = 0; passIndex < passes; passIndex += 1) {
    for (const item of items) {
      if (!done.has(`${item.id}#${passIndex}`)) jobs.push({ item, passIndex });
    }
  }
  console.log(`${items.length} cases × ${passes} passes = ${items.length * passes} grades; ${done.size} already checkpointed, ${jobs.length} to run, concurrency ${options.concurrency}`);

  const resolveModel = async () => model; // the persisted id, not a re-resolved tag
  let aborted: Error | null = null;
  let completed = 0;

  async function gradeOne(job: Job): Promise<void> {
    const built = buildInput(job.item, resultItemByTestItemId.get(job.item.id), expectedSourceIndex, model, effort);
    let score: CaseScore;
    if ('noResponse' in built) {
      score = built.noResponse;
    } else {
      score = await scoreCase(built.input, { resolveModel });
      if (score.unableToEvaluate && score.uteReason?.startsWith(GRADING_CALL_FAILED_PREFIX)) {
        const message = score.uteReason;
        if (BILLING_PATTERN.test(message)) {
          throw new GradingAborted(`Provider billing/credit error on item ${job.item.id} pass ${job.passIndex + 1}: ${message}`);
        }
        console.warn(`  retrying item ${job.item.id} pass ${job.passIndex + 1}: ${message}`);
        score = await scoreCase(built.input, { resolveModel });
        if (score.unableToEvaluate && score.uteReason?.startsWith(GRADING_CALL_FAILED_PREFIX)) {
          throw new GradingAborted(`Grading call failed twice on item ${job.item.id} pass ${job.passIndex + 1}: ${score.uteReason}`);
        }
      }
    }
    const line: CheckpointLine = { itemId: job.item.id, passIndex: job.passIndex, score, gradedAt: new Date().toISOString() };
    await appendFile(checkpointFile, `${JSON.stringify(line)}\n`, 'utf8');
    done.set(`${job.item.id}#${job.passIndex}`, score);
    completed += 1;
    const o = score.unableToEvaluate
      ? `UTE (${score.uteReason})`
      : `A${score.accuracy} C${score.completeness} R${score.relevance} Cl${score.clarity}`;
    console.log(`  [${completed}/${jobs.length}] pass ${job.passIndex + 1} item ${job.item.id.slice(0, 8)} → ${o}`);
  }

  // Small pool: one grade per slot, stop handing out work once anything aborts.
  const queue = [...jobs];
  async function worker(): Promise<void> {
    while (queue.length > 0 && !aborted) {
      const job = queue.shift()!;
      try {
        await gradeOne(job);
      } catch (error) {
        aborted = error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length || 1) }, worker));
  if (aborted) {
    console.error(`\nABORTED after ${completed} new grade(s) (checkpoint kept at ${checkpointFile}):\n${(aborted as Error).message}`);
    process.exit(1);
  }

  // ---- write eval_run{n}.json through the exporter's own shaping
  const passScores: Record<string, CaseScore[]> = {};
  for (const item of items) {
    const scores: CaseScore[] = [];
    for (let passIndex = 0; passIndex < passes; passIndex += 1) {
      const score = done.get(`${item.id}#${passIndex}`);
      if (!score) throw new Error(`missing grade for item ${item.id} pass ${passIndex + 1} after a complete run`);
      scores.push(score);
    }
    passScores[item.id] = scores;
  }

  const gradedAt = new Date().toISOString();
  for (let passIndex = 0; passIndex < passes; passIndex += 1) {
    const doc = buildEvalRunDocument({
      test,
      run,
      items,
      // The original report's synthesis belongs to the original grades, not these.
      state: { ...state, passes, synthesis: null },
      cases: assembled.cases,
      passScores,
      passIndex,
      exportedAt: gradedAt,
      meta: {
        comment:
          'Re-graded OUTSIDE the report pipeline by scripts/grade-with-bex-prompt.ts (B0-854): Bex’s ' +
          'CASE_SCORING_SYSTEM_PROMPT verbatim, GRADER_JSON_SCHEMA strict, one case per stateless call, ' +
          'the same model and effort the run’s report used. Nothing here was written to report_state. ' +
          '`completeness` is the judged value, UNCAPPED: apply `scoring_config` to reproduce Bex’s ' +
          'arithmetic. Bex is the spec.',
        extra: {
          regrade: {
            ticket: 'B0-854',
            source_run_id: run.id,
            grading_prompt_hash: GRADING_PROMPT_HASH,
            grading_prompt_version: GRADING_PROMPT_VERSION,
            grader_schema: 'GRADER_JSON_SCHEMA (strict json_schema, case_score)',
            grader_schema_keys: Object.keys(GRADER_JSON_SCHEMA.properties),
            model,
            effort: effort ?? null,
            context: 'one case per call, stateless; no pass sees another pass or another case',
            graded_at: gradedAt,
          },
        },
      },
    });
    const file = path.join(options.outDir, `eval_run${passIndex + 1}.json`);
    const body = `${JSON.stringify(doc, null, 2)}\n`;
    await writeFile(file, body, 'utf8');
    const ute = doc.cases.filter((c) => c.unable_to_evaluate).length;
    console.log(`Wrote ${file} — ${doc.cases.length} cases, ${ute} unable to evaluate, ${body.length} bytes`);
  }
  console.log(`Done: ${items.length * passes} grades (${completed} new this invocation).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
