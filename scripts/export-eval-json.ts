#!/usr/bin/env -S npx tsx
/**
 * B0-823 — exports one graded run's per-pass judgments in the agent-evaluation skill's `eval.json`
 * shape (one file per grading pass, `eval_run1.json … eval_runN.json`), and optionally freezes the
 * exact `computeReportMetrics` input and output as a Vitest fixture.
 *
 * Bex is the spec (Tom Bird, 2026-09-03). This script therefore never re-derives a number: every
 * case-level field comes out of `assembleReportCases` — the same assembly the report and
 * `/report/data` are built from — and every per-pass field is read verbatim off
 * `report_state.casePassScores`. The one derived value is per-pass Completeness, which Bex's grader
 * does not emit (it is `100 × expected_satisfied / expected_required`, `completenessFromCoverage`);
 * it is written so the skill's `consolidate_runs.py` has the four sub-scores it requires, and the
 * `meta.$comment` says so.
 *
 * ## Usage
 *
 *   # Export eval_run1.json … eval_runN.json (N = report_state.passes).
 *   npx tsx --env-file=.env.local scripts/export-eval-json.ts <runId> --out <dir>
 *
 *   # Also (or only) freeze the computeReportMetrics fixture used by metrics-fixture.test.ts.
 *   npx tsx --env-file=.env.local scripts/export-eval-json.ts <runId> --fixture src/lib/tests/report/__fixtures__
 *
 *   # Then, from <dir>, smoke-test the schema against the skill's consolidator:
 *   python3 ~/.claude/skills/agent-evaluation/scripts/consolidate_runs.py eval_run*.json --out eval.json
 *
 * Flags:
 *   --out <dir>        Directory for eval_run{n}.json (created if missing).
 *   --fixture <dir>    Directory for report-metrics-<run8>.input.json / .expected.json.
 *
 * Read-only against Supabase. Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 *
 * ## The fixture's guarantee
 *
 * `assembleReportCases` builds its `ReportCaseInput[]` internally and does not return it, so the
 * fixture path rebuilds it here with the same pure functions (`consolidateCasePasses`, the
 * ms → s boundary) — and then refuses to write anything unless `computeReportMetrics` over the
 * rebuilt input is byte-identical to the metrics the assembly produced. A frozen input that could
 * disagree with the report is never written.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assembleReportCases,
  indexLatestResultItems,
  type AssembledReportCases,
} from '~/lib/tests/report/assemble';
import { consolidateCasePasses } from '~/lib/tests/report/consolidate';
import {
  completenessFromCoverage,
  computeReportMetrics,
  NO_EXPECTED_CONCEPTS_UTE_REASON,
  tierLabel,
  type ComputeReportMetricsOptions,
  type ReportCaseInput,
  type ReportMetrics,
} from '~/lib/tests/report/metrics';
import { hydrateLegacyPassScores } from '~/lib/tests/report/orchestrator';
import type { CaseScore, ReportState } from '~/lib/tests/report/schemas';
import { parseReportState } from '~/lib/tests/report/schemas';
import { DEFAULT_PASS_MARK } from '~/lib/tests/report/scoring-config';
import {
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
} from '~/lib/tests/repository';
import type { TestItemRecord, TestRecord, TestResultRecord } from '~/lib/tests/types';

type Options = { runId: string; outDir: string | null; fixtureDir: string | null };

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  const runId = argv.find((a) => !a.startsWith('--') && a !== get('--out') && a !== get('--fixture'));
  const outDir = get('--out');
  const fixtureDir = get('--fixture');
  if (!runId || (!outDir && !fixtureDir)) {
    throw new Error(
      'Usage: export-eval-json.ts <runId> [--out <dir>] [--fixture <dir>] — at least one of --out / --fixture is required.',
    );
  }
  return { runId, outDir, fixtureDir };
}

type LoadedRun = {
  run: TestResultRecord;
  test: TestRecord;
  items: TestItemRecord[];
  state: ReportState;
  assembled: AssembledReportCases;
  /** Raw rows, kept for the fixture path's rebuild of the assembly's inputs. */
  resultItems: Awaited<ReturnType<typeof listAllResultItemsByResultId>>;
};

async function loadRun(runId: string): Promise<LoadedRun> {
  const run = await getTestResultById(runId);
  const test = await getTestById(run.test_id);
  const [items, resultItems] = await Promise.all([
    getTestItemsByTestId(run.test_id),
    listAllResultItemsByResultId(run.id),
  ]);
  const state = parseReportState(run.report_state);
  if (!state) {
    throw new Error(`Run ${runId} has no parseable report_state — generate its report first.`);
  }
  hydrateLegacyPassScores(state);

  const short = items.filter(
    (item) => (state.casePassScores[item.id]?.length ?? 0) < state.passes,
  );
  if (short.length > 0) {
    console.warn(
      `WARNING: ${short.length} of ${items.length} cases have fewer than ${state.passes} graded passes; ` +
        `those cases are omitted from the passes they lack (never filled in): ${short.map((i) => i.id).join(', ')}`,
    );
  }

  // Default invariant severity ('throw'): a run whose report does not reconcile is not exported.
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
  });

  return { run, test, items, state, assembled, resultItems };
}

// ---------------------------------------------------------------------------------- eval.json

/** The skill's `concepts` block, field for field, phrases copied by reference (regulated text). */
function conceptsBlock(concepts: NonNullable<CaseScore['concepts']>) {
  return {
    minimal_required: concepts.mandatory.required,
    minimal_satisfied: concepts.mandatory.satisfied,
    minimal_missing: concepts.mandatory.missing,
    expected_required: concepts.expected.required,
    expected_satisfied: concepts.expected.satisfied,
    expected_missing: concepts.expected.missing,
    material_issue: concepts.materialIssue,
    material_issue_note: concepts.materialIssueNote,
  };
}

/** Bex's synthesis, when the report finished; the skill's keys are snake_case. Omitted otherwise. */
function synthesisBlock(state: ReportState) {
  const s = state.synthesis;
  if (!s) return {};
  return {
    failure_patterns: s.failurePatterns,
    strengths: s.strengths,
    weaknesses: s.weaknesses,
    top3: s.top3.map((r) => ({
      priority: r.priority,
      what: r.what,
      why_first: r.whyFirst,
      evidence: r.evidence,
      affected: r.affected,
      change: r.change,
      impact: r.impact,
    })),
    exec: {
      strongest_areas: s.exec.strongestAreas,
      improvement_areas: s.exec.improvementAreas,
      most_significant_failure: s.exec.mostSignificantFailure,
      major_risk: s.exec.majorRisk,
      readiness: s.exec.readiness,
    },
  };
}

function buildEvalRun(loaded: LoadedRun, passIndex: number, exportedAt: string) {
  const { run, test, items, state, assembled } = loaded;
  const caseById = new Map(assembled.cases.map((c) => [c.id, c]));
  const passMark = state.passMark ?? DEFAULT_PASS_MARK;

  const cases = [];
  for (const item of items) {
    const pass = state.casePassScores[item.id]?.[passIndex];
    if (!pass) continue;
    const rc = caseById.get(item.id);
    if (!rc) throw new Error(`assembly produced no case for item ${item.id}`);

    // Evaluability under Bex's rules for THIS pass: the grader said so, or the pass has no
    // expected concepts to compute Completeness from (pure-math scoring, B0-813).
    const completeness = pass.unableToEvaluate ? null : completenessFromCoverage(pass.concepts);
    const unableToEvaluate = pass.unableToEvaluate || completeness == null;
    const uteReason = pass.unableToEvaluate
      ? (pass.uteReason ?? 'unspecified')
      : unableToEvaluate
        ? NO_EXPECTED_CONCEPTS_UTE_REASON
        : null;

    cases.push({
      id: item.id,
      question: rc.question,
      priority_raw: rc.priorityRaw,
      tier: rc.tier,
      category: rc.category,
      expected: rc.idealResponse,
      actual: rc.actual,
      ...(unableToEvaluate
        ? {}
        : {
            accuracy: pass.accuracy,
            completeness,
            relevance: pass.relevance,
            clarity: pass.clarity,
            explanation: pass.explanation,
            missed: pass.missed,
            incorrect: pass.incorrect,
            improvement: pass.improvement,
          }),
      ...(rc.ttftSeconds != null ? { ttft_seconds: rc.ttftSeconds } : {}),
      ...(rc.latencySeconds != null ? { latency_seconds: rc.latencySeconds } : {}),
      ...(pass.concepts ? { concepts: conceptsBlock(pass.concepts) } : {}),
      unable_to_evaluate: unableToEvaluate,
      ute_reason: uteReason,
      ...(pass.similarity != null ? { similarity: pass.similarity } : {}),
      ...(pass.similarityNote != null ? { similarity_note: pass.similarityNote } : {}),
      ...(pass.evalConfidence != null ? { eval_confidence: pass.evalConfidence } : {}),
      ...(pass.confidenceNote != null ? { confidence_note: pass.confidenceNote } : {}),
    });
  }

  // Priority → tier, from the priorities this dataset actually uses, in dataset order.
  const tierLabels: Record<string, string> = {};
  for (const item of items) {
    if (item.priority != null) tierLabels[tierLabel(item.priority)] = String(item.priority);
  }

  return {
    meta: {
      workbook: test.name,
      ...(test.intended_agent ? { workflow: test.intended_agent } : {}),
      prepared_for: 'Betco / Bex',
      run_url: `/admin/tests/${test.id}/runs/${run.id}`,
      $comment:
        'Exported from Bex (scripts/export-eval-json.ts, B0-823). Bex’s grader judges Accuracy, ' +
        'Relevance, Clarity and the per-concept verdicts; it emits NO Completeness. The `completeness` ' +
        'on every evaluable case here is derived as 100 × expected_satisfied / expected_required ' +
        '(half-up), which is exactly how Bex computes it (pure-math scoring, B0-813), and is written ' +
        'only so consolidate_runs.py has four sub-scores. A pass with no expected concepts is ' +
        'unable_to_evaluate under Bex’s rules and is exported as such. Bex is the spec.',
      bex: {
        run_id: run.id,
        test_id: test.id,
        app_version: run.app_version,
        pass: passIndex + 1,
        passes: state.passes,
        grading: {
          model: state.model,
          effort: state.gradingEffort,
          pass_mark: passMark,
          spread_threshold: state.spreadThreshold,
          grading_prompt_hash: state.gradingPromptHash,
          judged_thresholds: state.judgedThresholds,
        },
        exported_at: exportedAt,
      },
    },
    tier_labels: tierLabels,
    // Bex has no mandatory gate, floor or ceiling (B0-813). Declared, not defaulted, so the
    // skill's per-run overalls are computed under the rules these grades were actually produced by.
    scoring_config: {
      pass_mark: { score: passMark },
      minimal_gate: { enabled: false },
      minimal_floor: { enabled: false },
      minimal_ceiling: { enabled: false },
    },
    cases,
    ...synthesisBlock(state),
  };
}

async function writeEvalRuns(loaded: LoadedRun, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const exportedAt = new Date().toISOString();
  for (let passIndex = 0; passIndex < loaded.state.passes; passIndex += 1) {
    const evalRun = buildEvalRun(loaded, passIndex, exportedAt);
    const file = path.join(outDir, `eval_run${passIndex + 1}.json`);
    const body = `${JSON.stringify(evalRun, null, 2)}\n`;
    await writeFile(file, body, 'utf8');
    const ute = evalRun.cases.filter((c) => c.unable_to_evaluate).length;
    console.log(
      `Wrote ${path.relative(process.cwd(), file)} — ${evalRun.cases.length} cases, ${ute} unable to evaluate, ${body.length} bytes`,
    );
  }
}

// ----------------------------------------------------------------------------------- fixture

/**
 * The exact `ReportCaseInput[]` the assembly hands to `computeReportMetrics` — rebuilt here with
 * the same pure functions, then proven equal (see `writeFixture`). Mirrors `assembleReportCases`:
 * timings converted once at the ms → s boundary, passes consolidated per case, a case with no pass
 * data falling back to its consolidated `caseScores` entry.
 */
function rebuildCaseInputs(loaded: LoadedRun): ReportCaseInput[] {
  const { items, state, resultItems } = loaded;
  const resultItemByTestItemId = indexLatestResultItems(resultItems);

  return items.map((item) => {
    const resultItem = resultItemByTestItemId.get(item.id);
    const latencySeconds = resultItem ? resultItem.elapsed_ms / 1000 : null;
    const ttftMs = resultItem?.ttft_ms;
    const ttftSeconds =
      typeof ttftMs === 'number' && Number.isFinite(ttftMs) ? ttftMs / 1000 : null;

    const passScores = state.casePassScores[item.id];
    const consolidated =
      passScores && passScores.length > 0
        ? consolidateCasePasses(
            passScores.map((score) => ({
              score,
              concepts: score.concepts ?? undefined,
              ttftSeconds,
              totalSeconds: latencySeconds,
            })),
            { spreadThreshold: state.spreadThreshold ?? undefined, passMark: state.passMark },
          )
        : null;

    const score = consolidated?.score ?? state.caseScores[item.id];
    if (!score) {
      // The assembly substitutes an "unscored" placeholder here; a fixture must not freeze one.
      throw new Error(
        `Item ${item.id} was never graded in this report — a fixture needs a fully graded run.`,
      );
    }

    return {
      testItemId: item.id,
      question: item.prompt,
      priorityRaw: item.priority,
      category: item.prompt_category,
      score,
      latencySeconds,
      ttftSeconds,
      concepts: consolidated ? consolidated.concepts : (score.concepts ?? undefined),
      variance: consolidated?.variance ?? null,
    };
  });
}

/** JSON round-trip: drops `undefined` keys and normalises `-0`, exactly as the fixture file will. */
function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function writeFixture(loaded: LoadedRun, fixtureDir: string): Promise<ReportMetrics> {
  const { run, test, state, assembled } = loaded;
  const options: ComputeReportMetricsOptions = {
    passMark: state.passMark,
    judgedThresholds: state.judgedThresholds,
  };
  const inputs = viaJson(rebuildCaseInputs(loaded));
  const expected = viaJson(computeReportMetrics(inputs, options));

  const fromAssembly = JSON.stringify(viaJson(assembled.metrics));
  if (JSON.stringify(expected) !== fromAssembly) {
    throw new Error(
      'Rebuilt ReportCaseInput[] does not reproduce assembleReportCases().metrics — the exporter has ' +
        'drifted from assemble.ts. Nothing written.',
    );
  }

  const short = run.id.slice(0, 8);
  await mkdir(fixtureDir, { recursive: true });
  const inputFile = path.join(fixtureDir, `report-metrics-${short}.input.json`);
  const expectedFile = path.join(fixtureDir, `report-metrics-${short}.expected.json`);
  const inputDoc = {
    $provenance: {
      generated_by: 'scripts/export-eval-json.ts --fixture (B0-823)',
      run_id: run.id,
      test_id: test.id,
      test_name: test.name,
      model: state.model,
      effort: state.gradingEffort,
      grading_prompt_hash: state.gradingPromptHash,
    },
    // As recorded on report_state. `passes` and `spreadThreshold` were consumed upstream by
    // `consolidateCasePasses` and are baked into each input's `variance`; `passMark` and
    // `judgedThresholds` are what `computeReportMetrics` itself reads (below, as `options`).
    state: {
      passes: state.passes,
      passMark: state.passMark,
      spreadThreshold: state.spreadThreshold,
      judgedThresholds: state.judgedThresholds,
    },
    options,
    inputs,
  };
  await writeFile(inputFile, `${JSON.stringify(inputDoc, null, 2)}\n`, 'utf8');
  await writeFile(expectedFile, `${JSON.stringify(expected, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote ${path.relative(process.cwd(), inputFile)} (${inputs.length} inputs) and ${path.relative(process.cwd(), expectedFile)}`,
  );
  return expected;
}

// -------------------------------------------------------------------------------------- main

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const loaded = await loadRun(options.runId);
  const { test, state, assembled } = loaded;

  console.log(
    `Run ${options.runId} — "${test.name}" — report ${state.status}, model ${state.model}` +
      `${state.gradingEffort ? ` @ ${state.gradingEffort}` : ''}, ${state.passes} pass(es), pass mark ${state.passMark ?? DEFAULT_PASS_MARK}`,
  );
  if (state.status !== 'completed') {
    console.warn(
      `WARNING: report status is '${state.status}'${state.error ? ` (${state.error.slice(0, 160)}…)` : ''}; ` +
        'exporting the graded passes that exist.',
    );
  }

  if (options.outDir) await writeEvalRuns(loaded, path.resolve(options.outDir));
  if (options.fixtureDir) await writeFixture(loaded, path.resolve(options.fixtureDir));

  const m = assembled.metrics;
  console.log(
    `Headline (Bex): ${m.evaluated} evaluated / ${m.uteCount} unable to evaluate of ${m.totalCases}; ` +
      `overall avg ${m.overall.avg} (${m.overall.grade}); pass ${m.overall.pass} / fail ${m.overall.fail} (${m.overall.passPct}%)` +
      (m.consistency ? `; ${m.consistency.flagged} flagged for review` : ''),
  );
  if (m.warnings.length > 0) {
    console.log(`Metrics warnings (${m.warnings.length}):\n  ${m.warnings.join('\n  ')}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
