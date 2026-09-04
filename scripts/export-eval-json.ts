#!/usr/bin/env -S npx tsx
/**
 * B0-823 — exports one graded run's per-pass judgments in the agent-evaluation skill's `eval.json`
 * shape (one file per grading pass, `eval_run1.json … eval_runN.json`), and optionally freezes the
 * exact `computeReportMetrics` input and output as a Vitest fixture.
 *
 * Bex is the spec (Tom Bird, 2026-09-03). This script therefore never re-derives a number: every
 * case-level field comes out of `assembleReportCases` — the same assembly the report and
 * `/report/data` are built from — and every per-pass field is read verbatim off
 * `report_state.casePassScores`. Completeness is exported as the grader judged it, uncapped
 * (B0-835); a pass graded in the B0-813 window (2026-09-03 → 2026-09-04) emitted none, and for it
 * the expected-concept coverage share is written instead — the same fallback `deriveCaseScoreline`
 * applies, and the `meta.$comment` says so. `scoring_config` declares the concept rules the run was
 * scored under (`report_state.scoringRules`, or the shipped defaults for a report that predates the
 * field) in the skill's own `SCORING_DEFAULTS` shape, so `consolidate_runs.py` /
 * `compute_metrics.py` reproduce Bex's numbers instead of re-scoring under their own.
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
import {
  DEFAULT_PASS_MARK,
  DEFAULT_SCORING_RULES,
  type ScoringRules,
} from '~/lib/tests/report/scoring-config';
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
    scoringRules: state.scoringRules,
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

/**
 * B0-835 — `scoring_config` in the skill's `concept_rules.py` `SCORING_DEFAULTS` shape, key for
 * key, from the rules this run was actually scored under. Every rule is declared, on or off, so the
 * skill's per-run overalls are computed under the rulebook these grades were produced by.
 */
function toSkillScoringConfig(rules: ScoringRules, passMark: number) {
  return {
    pass_mark: { score: passMark },
    minimal_gate: { enabled: rules.minimalGate.enabled },
    minimal_floor: {
      enabled: rules.minimalFloor.enabled,
      score: rules.minimalFloor.score,
      respect_material_issue: rules.minimalFloor.respectMaterialIssue,
    },
    minimal_ceiling: { enabled: rules.minimalCeiling.enabled, score: rules.minimalCeiling.score },
    expected_coverage: { enabled: rules.expectedCoverage.enabled },
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
    // expected concepts — a concept-less case is never graded holistically (B0-826 / B0-835).
    const coverage = pass.unableToEvaluate ? null : completenessFromCoverage(pass.concepts);
    const unableToEvaluate = pass.unableToEvaluate || coverage == null;
    // B0-835 — Completeness as the grader judged it, uncapped: the skill's own expected-coverage
    // rule caps it under `scoring_config`, exactly as `deriveCaseScoreline` does here. A pass graded
    // in the B0-813 window emitted no judged value; coverage is then its only Completeness — the
    // same fallback the report applies.
    const completeness = unableToEvaluate ? null : (pass.completeness ?? coverage);
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
        'Exported from Bex (scripts/export-eval-json.ts, B0-823 / B0-835). Bex’s grader judges all ' +
        'four sub-scores — Accuracy, Completeness, Relevance, Clarity — plus the per-concept verdicts. ' +
        '`completeness` is the judged value, UNCAPPED: apply `scoring_config` (expected-coverage cap, ' +
        'weights 40/30/20/10, mandatory floor, mandatory ceiling, automatic Pass, mandatory gate) to ' +
        'reproduce Bex’s numbers. A pass graded between 2026-09-03 and 2026-09-04 (the B0-813 window) ' +
        'carries no judged Completeness; its `completeness` is the expected-concept coverage share ' +
        '(100 × expected_satisfied / expected_required, half-up), exactly as Bex scores such a pass. ' +
        'A pass with no expected concepts is unable_to_evaluate under Bex’s rules and is exported as ' +
        'such. Bex is the spec.',
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
          // B0-835 — Bex's own record of the rules; null on a report_state that predates the field.
          scoring_rules: state.scoringRules,
        },
        exported_at: exportedAt,
      },
    },
    tier_labels: tierLabels,
    // B0-835 — the concept rules these grades were actually scored under, declared explicitly
    // (never left to the skill's defaults). A report_state persisted before the field existed was
    // produced under the shipped defaults, which is what the read path applies to it too.
    scoring_config: toSkillScoringConfig(state.scoringRules ?? DEFAULT_SCORING_RULES, passMark),
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
            {
              spreadThreshold: state.spreadThreshold ?? undefined,
              passMark: state.passMark,
              scoringRules: state.scoringRules,
            },
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
    // B0-835 — only when the state recorded rules: a legacy run's fixture keeps the key absent, so
    // `computeReportMetrics` falls back to the defaults exactly as the read path does for that run.
    ...(state.scoringRules ? { scoringRules: state.scoringRules } : {}),
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
      scoringRules: state.scoringRules,
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
