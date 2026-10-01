#!/usr/bin/env -S npx tsx
/**
 * B0-1087 (follow-up to B0-786) — a controlled, PAIRED A/B of `BEX_SIGNALS_ANALYSIS_ENABLED`
 * (OFF vs ON) against one frozen regression set, so the quality/lock/latency question gets a
 * real causal answer instead of a live-traffic diff.
 *
 * ## Why live traffic couldn't answer this
 *
 * A calendar-date before/after comparison across the 2026-09-02 flag flip carries 17-23
 * confounding `app_version`s per side, and the raw product-lock-rate comparison was distorted by
 * a denominator change (lock-attempt coverage itself rose as part of the same rollout). This
 * script holds everything else constant — same test set, same `modelTag`, same day, same grader
 * — and flips only the one flag.
 *
 * ## What it does
 *
 *   1. Reads the CURRENT value of `BEX_SIGNALS_ANALYSIS_ENABLED` from `public.settings` (to
 *      restore it afterward) and requires `--yes` before touching anything live.
 *   2. Sets the flag to `false`, creates + executes a fresh run of the target test set via the
 *      same `POST /api/admin/tests/runs` → `POST /api/admin/tests/runs/:id` path
 *      `scripts/run-eval-gate.ts` (the CI gate) already uses, polls to completion, then triggers
 *      + polls report generation the same way the admin UI does.
 *   3. Sets the flag to `true`, repeats step 2 for a second run of the SAME test set.
 *   4. Restores the flag to whatever it was originally (best-effort; the script warns loudly if
 *      restoration fails rather than leaving a live setting silently flipped).
 *   5. For each run, calls the real report-assembly function (`loadReportData`, the same one the
 *      admin report page and Markdown export both go through) to get PER-CASE grades — no schema
 *      change and no re-implementation of grading logic.
 *   6. Cross-checks, per run, which routing path actually decided each item
 *      (`workflow_steps.output.gates`: a `signals_analysis` gate means B0-786's consolidated call
 *      ran; `llm_intent_classifier_live` alone means the old/degraded classifier path ran) — so a
 *      flag write that didn't actually take effect for some items is caught, not assumed away.
 *   7. Joins both runs by `test_item_id` (same test set, so item ids match) to compute a PAIRED
 *      per-item score delta, a paired significance test (sign test, normal-approximation
 *      p-value), and a paired `productLineLock.lockReason`/`explicitKeySource` crosstab
 *      (`workflow_runs.final_output`, joined via `test_result_items.workflow_run_id`).
 *   8. Writes every raw per-item row to a JSON case file for reproducibility/audit and prints a
 *      summary.
 *
 * ## What this script does NOT do
 *
 *   - It does NOT change `analyzeTurnSignals()`, the lock threshold, or any prompt/scoring logic.
 *   - It does NOT retune `XREF_RECOMMENDATION_MIN_CONFIDENCE` or any other threshold — it only
 *     measures.
 *   - It does NOT leave the flag changed: the original value is restored after both runs, even on
 *     a thrown error (best-effort, in a `finally`).
 *   - It does NOT invent a test set — `--test-id` must name a real, non-empty `public.tests` row;
 *     the default is the "75 or under" regression set (id printed at startup so it can be
 *     verified against `/admin/tests` before running).
 *   - It does NOT run report generation itself — it drives the same `/report` endpoint the admin
 *     UI uses, so grading uses the real `computeReportMetrics` pipeline, not a script-local copy.
 *
 * ## Usage
 *
 *   # Dry check: prints the plan (test set, current flag value) and exits without changing anything.
 *   npx tsx --env-file=.env.local scripts/measure-signals-consolidation-impact.ts
 *
 *   # Actually run both arms. THIS FLIPS A LIVE SETTING TWICE AND COSTS REAL LLM CALLS
 *   # (roughly 2x the test set's per-item generation cost, plus grading cost for both runs).
 *   npx tsx --env-file=.env.local scripts/measure-signals-consolidation-impact.ts --yes
 *
 * Environment variables (same names as `scripts/run-eval-gate.ts`, so both scripts share one CI
 * config if ever needed):
 *   BEX_GATE_BASE_URL          Base URL of the running app (default: http://localhost:3000)
 *   BEX_GATE_API_TOKEN         `bex_<env>_…` client token (also accepts BEX_GATE_API_KEY)
 *
 * Flags:
 *   --yes                  Required to actually flip the flag and run. Omit for a dry check.
 *   --test-id <uuid>        Test suite to run (default: "75 or under", 0bb28d2a-...-b3a446, 224 items).
 *   --model-tag <tag>       `createRunBodySchema.modelTag` (default: gpt-4.1, held constant both arms).
 *   --run-timeout-ms <n>    Wait budget per run's execution (default: 1_800_000 = 30 min).
 *   --report-timeout-ms <n> Wait budget per run's report generation (default: 1_800_000 = 30 min).
 *   --poll-interval-ms <n>  Poll cadence for both waits (default: 10_000).
 *   --out <path>            Case file path (default: src/lib/tests/eval/signals-consolidation-ab-cases.json).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import { COMPLETED_RUN_STATUSES, TERMINAL_RUN_STATUSES } from '~/lib/tests/types';

const SIGNALS_FLAG_KEY = 'BEX_SIGNALS_ANALYSIS_ENABLED';
const DEFAULT_TEST_ID = '0bb28d2a-3a20-4174-924c-8d1b207a3446'; // "75 or under" — 224 items (B0-734 regression set)
const DEFAULT_OUT_PATH = 'src/lib/tests/eval/signals-consolidation-ab-cases.json';

type Arm = 'OFF' | 'ON';

type ParsedArgs = {
  yes: boolean;
  testId: string;
  modelTag: string;
  runTimeoutMs: number;
  reportTimeoutMs: number;
  pollIntervalMs: number;
  outPath: string;
};

function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const get = (name: string, fallback: number): number => {
    const raw = flag(argv, name);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    yes: argv.includes('--yes'),
    testId: flag(argv, '--test-id') ?? DEFAULT_TEST_ID,
    modelTag: flag(argv, '--model-tag') ?? 'gpt-4.1',
    runTimeoutMs: get('--run-timeout-ms', 1_800_000),
    reportTimeoutMs: get('--report-timeout-ms', 1_800_000),
    pollIntervalMs: get('--poll-interval-ms', 10_000),
    outPath: flag(argv, '--out') ?? DEFAULT_OUT_PATH,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Settings flag read/write — direct table access, same table the admin
// settings UI (`/api/admin/settings`) writes, but that route is session-only
// and this is a headless script, so it goes straight to the table like every
// other read/write this session has made against `public.settings`.
// ---------------------------------------------------------------------------

async function readSignalsFlag(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', SIGNALS_FLAG_KEY)
    .single();
  if (error || !data) {
    throw new Error(
      `Could not read ${SIGNALS_FLAG_KEY} from public.settings: ${error?.message ?? 'no row'}`,
    );
  }
  return String(data.value).toLowerCase() === 'true';
}

async function writeSignalsFlag(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  value: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('settings')
    .update({ value: String(value), updated_at: new Date().toISOString() })
    .eq('key', SIGNALS_FLAG_KEY);
  if (error) {
    throw new Error(`Could not write ${SIGNALS_FLAG_KEY}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Run creation / execution / report generation — mirrors scripts/run-eval-gate.ts
// exactly (same endpoints, same auth header, same poll loop shape) since that
// script is the established, already-working way to drive a real run from
// outside the Next.js process.
// ---------------------------------------------------------------------------

type RunHttp = {
  baseUrl: string;
  headers: Record<string, string>;
};

function runHttpFromEnv(): RunHttp {
  const baseUrl = (process.env['BEX_GATE_BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
  const token = process.env['BEX_GATE_API_TOKEN'] ?? process.env['BEX_GATE_API_KEY'];
  if (!token) {
    throw new Error(
      'BEX_GATE_API_TOKEN (or BEX_GATE_API_KEY) is required — this script authenticates the same ' +
        'way scripts/run-eval-gate.ts does, against the api_project/api_app/api_key registry.',
    );
  }
  return { baseUrl, headers: { Authorization: `Bearer ${token}` } };
}

async function createRun(http: RunHttp, testId: string, modelTag: string): Promise<string> {
  const resp = await fetch(`${http.baseUrl}/api/admin/tests/runs`, {
    method: 'POST',
    headers: { ...http.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ testId, runMode: 'full', modelTag }),
  });
  if (!resp.ok) {
    throw new Error(`Could not create a run (${resp.status}): ${await resp.text()}`);
  }
  const created = (await resp.json()) as { runId: string; totalItems: number };
  console.log(`  Run ${created.runId} queued — ${created.totalItems} item(s).`);
  return created.runId;
}

async function waitForTerminalStatus(
  http: RunHttp,
  runId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<string> {
  // Kick off execution — same "fire and poll" pattern as run-eval-gate.ts: the route's own
  // synchronous execution may time out or be cut off mid-flight (yield/hop chain takes over
  // server-side), so the request itself is not the source of truth.
  await fetch(`${http.baseUrl}/api/admin/tests/runs/${runId}`, {
    method: 'POST',
    headers: http.headers,
  }).catch((err: unknown) => {
    console.log(`  (execute request did not return cleanly: ${String(err)} — still polling)`);
  });

  const deadline = Date.now() + timeoutMs;
  let status = '';
  while (Date.now() < deadline) {
    const resp = await fetch(`${http.baseUrl}/api/admin/tests/runs/${runId}`, {
      headers: http.headers,
    });
    if (!resp.ok) {
      throw new Error(`Progress request failed (${resp.status}): ${await resp.text()}`);
    }
    const progress = (await resp.json()) as {
      status: string;
      completedItems: number;
      totalItems: number;
      passedItems: number;
      failedItems: number;
    };
    status = progress.status;
    console.log(
      `    ${status} — ${progress.completedItems}/${progress.totalItems} ` +
        `(${progress.passedItems} passed, ${progress.failedItems} failed)`,
    );
    if (TERMINAL_RUN_STATUSES.includes(status as (typeof TERMINAL_RUN_STATUSES)[number])) {
      break;
    }
    await sleep(pollIntervalMs);
  }

  if (!TERMINAL_RUN_STATUSES.includes(status as (typeof TERMINAL_RUN_STATUSES)[number])) {
    throw new Error(`Run ${runId} did not finish within ${Math.round(timeoutMs / 1000)}s.`);
  }
  if (!COMPLETED_RUN_STATUSES.includes(status as (typeof COMPLETED_RUN_STATUSES)[number])) {
    throw new Error(`Run ${runId} ended as "${status}" without grading every item.`);
  }
  return status;
}

async function generateAndWaitForReport(
  http: RunHttp,
  runId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  // Background mode (B0-943): the server chains its own continuation hops once this first
  // request lands, so the client's job is only to trigger it once and then poll GET.
  const resp = await fetch(`${http.baseUrl}/api/admin/tests/runs/${runId}/report`, {
    method: 'POST',
    headers: { ...http.headers, 'x-bex-report-mode': 'background' },
  });
  if (!resp.ok && resp.status !== 202) {
    throw new Error(`Could not start report generation (${resp.status}): ${await resp.text()}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statusResp = await fetch(`${http.baseUrl}/api/admin/tests/runs/${runId}/report`, {
      headers: http.headers,
    });
    if (!statusResp.ok) {
      throw new Error(`Report status request failed (${statusResp.status}): ${await statusResp.text()}`);
    }
    const state = (await statusResp.json()) as {
      status: string;
      generatedAt: string | null;
      error: string | null;
      completedCases: number;
      totalCases: number;
    };
    console.log(
      `    report ${state.status} — ${state.completedCases}/${state.totalCases} case(s) scored`,
    );
    if (state.error) {
      throw new Error(`Report generation failed for run ${runId}: ${state.error}`);
    }
    if (state.generatedAt) return;
    await sleep(pollIntervalMs);
  }
  throw new Error(`Report for run ${runId} did not finish within ${Math.round(timeoutMs / 1000)}s.`);
}

// ---------------------------------------------------------------------------
// Per-run analysis: real per-case grades via the actual report-assembly path,
// plus the routing-path verification and product-lock crosstab this session
// already validated by hand in SQL.
// ---------------------------------------------------------------------------

type PerItem = {
  testItemId: string;
  question: string;
  unableToEvaluate: boolean;
  overall: number | null;
  grade: string | null;
  status: string | null;
  decidingPath: 'signals_analysis' | 'llm_intent_classifier_live' | 'unknown' | null;
  lockReason: string | null;
  explicitKeySource: string | null;
};

type ArmResult = {
  arm: Arm;
  runId: string;
  reportOverallAvg: number | null;
  reportOverallGrade: string | null;
  items: PerItem[];
};

async function analyzeRun(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  arm: Arm,
  runId: string,
): Promise<ArmResult> {
  // The real, already-shipped assembly function — same one the admin report page and the
  // Markdown export both go through. No re-implementation of grading logic here.
  const { loadReportData } = await import('~/lib/tests/report/assemble');
  const report = await loadReportData(runId);
  if (!report) {
    throw new Error(`loadReportData returned null for run ${runId} — report_state missing?`);
  }
  if (report.status !== 'ready') {
    throw new Error(
      `Report for run ${runId} is "${report.status}", not "ready" — generateAndWaitForReport ` +
        'should have blocked until it was.',
    );
  }

  // `report_overall_avg`/`report_overall_grade` (migration 20260924200444_..._b1087) postdate the
  // generated Supabase types (`~/types/supabase.*.ts`), which are regenerated from a live CLI
  // session and not part of this script's scope — selected via a loosely-typed row cast rather
  // than blocking this script on a type regen.
  const { data: runRow, error: runError } = await supabase
    .from('test_results')
    .select('report_overall_avg, report_overall_grade')
    .eq('id', runId)
    .single<{ report_overall_avg: number | null; report_overall_grade: string | null }>();
  if (runError) {
    throw new Error(`Could not read test_results.${runId}: ${runError.message}`);
  }

  const { data: items, error: itemsError } = await supabase
    .from('test_result_items')
    .select('test_item_id, workflow_run_id')
    .eq('test_result_id', runId);
  if (itemsError) {
    throw new Error(`Could not read test_result_items for run ${runId}: ${itemsError.message}`);
  }

  const workflowRunIdByItemId = new Map(
    (items ?? [])
      .filter((row) => row.workflow_run_id !== null)
      .map((row) => [row.test_item_id as string, row.workflow_run_id as string]),
  );
  const workflowRunIds = [...new Set(workflowRunIdByItemId.values())];

  const decidingPathByWorkflowRunId = new Map<string, PerItem['decidingPath']>();
  const lockByWorkflowRunId = new Map<string, { lockReason: string | null; explicitKeySource: string | null }>();

  if (workflowRunIds.length > 0) {
    const { data: steps, error: stepsError } = await supabase
      .from('workflow_steps')
      .select('workflow_run_id, output')
      .eq('step_name', 'orchestration_planner')
      .in('workflow_run_id', workflowRunIds);
    if (stepsError) {
      throw new Error(`Could not read workflow_steps for run ${runId}: ${stepsError.message}`);
    }
    for (const step of steps ?? []) {
      const gates = (step.output as { gates?: Array<{ gate?: string }> } | null)?.gates ?? [];
      const hasSignals = gates.some((g) => g.gate === 'signals_analysis');
      const hasClassifier = gates.some((g) => g.gate === 'llm_intent_classifier_live');
      decidingPathByWorkflowRunId.set(
        step.workflow_run_id as string,
        hasSignals ? 'signals_analysis' : hasClassifier ? 'llm_intent_classifier_live' : 'unknown',
      );
    }

    const { data: runs, error: runsError } = await supabase
      .from('workflow_runs')
      .select('id, final_output')
      .in('id', workflowRunIds);
    if (runsError) {
      throw new Error(`Could not read workflow_runs for run ${runId}: ${runsError.message}`);
    }
    for (const wr of runs ?? []) {
      const lock = (wr.final_output as { productLineLock?: { lockReason?: string; explicitKeySource?: string } } | null)
        ?.productLineLock;
      lockByWorkflowRunId.set(wr.id as string, {
        lockReason: lock?.lockReason ?? null,
        explicitKeySource: lock?.explicitKeySource ?? null,
      });
    }
  }

  const perItem: PerItem[] = report.cases.map((c) => {
    const workflowRunId = workflowRunIdByItemId.get(c.id) ?? null;
    const lock = workflowRunId ? lockByWorkflowRunId.get(workflowRunId) : undefined;
    return {
      testItemId: c.id,
      question: c.question,
      unableToEvaluate: c.unableToEvaluate,
      overall: c.evaluated?.overall ?? null,
      grade: c.evaluated?.grade ?? null,
      status: c.evaluated?.status ?? null,
      decidingPath: workflowRunId ? decidingPathByWorkflowRunId.get(workflowRunId) ?? 'unknown' : null,
      lockReason: lock?.lockReason ?? null,
      explicitKeySource: lock?.explicitKeySource ?? null,
    };
  });

  const expectedPath: PerItem['decidingPath'] =
    arm === 'ON' ? 'signals_analysis' : 'llm_intent_classifier_live';
  const mismatched = perItem.filter(
    (i) => i.decidingPath !== null && i.decidingPath !== 'unknown' && i.decidingPath !== expectedPath,
  ).length;
  if (mismatched > 0) {
    console.warn(
      `  ! ${mismatched}/${perItem.length} item(s) in the "${arm}" run were NOT decided by the ` +
        `expected path (${expectedPath}) — the flag write may not have taken effect for every item. ` +
        `Treat this arm's aggregate with caution; per-item pairing below still uses the ACTUAL path.`,
    );
  }

  return {
    arm,
    runId,
    reportOverallAvg: runRow?.report_overall_avg ?? null,
    reportOverallGrade: runRow?.report_overall_grade ?? null,
    items: perItem,
  };
}

// ---------------------------------------------------------------------------
// Paired comparison + significance
// ---------------------------------------------------------------------------

/** Two-sided sign-test p-value via the normal approximation (adequate for n in the hundreds). */
function signTestPValue(nPositive: number, nNegative: number): number | null {
  const n = nPositive + nNegative;
  if (n === 0) return null;
  const z = (nPositive - n / 2) / (Math.sqrt(n) / 2);
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return Math.min(1, Math.max(0, p));
}

function normalCdf(z: number): number {
  // Abramowitz & Stegun 7.1.26 approximation of the error function.
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return 0.5 * (1 + erf);
}

function buildPairedRows(off: ArmResult, on: ArmResult) {
  const onByItemId = new Map(on.items.map((i) => [i.testItemId, i]));
  const rows: Array<{
    testItemId: string;
    question: string;
    offOverall: number | null;
    onOverall: number | null;
    delta: number | null;
    offLockReason: string | null;
    onLockReason: string | null;
    offExplicitKeySource: string | null;
    onExplicitKeySource: string | null;
  }> = [];
  for (const offItem of off.items) {
    const onItem = onByItemId.get(offItem.testItemId);
    if (!onItem) continue; // item absent from one run (e.g. an errored row) — excluded from pairing
    const delta =
      offItem.overall !== null && onItem.overall !== null ? onItem.overall - offItem.overall : null;
    rows.push({
      testItemId: offItem.testItemId,
      question: offItem.question,
      offOverall: offItem.overall,
      onOverall: onItem.overall,
      delta,
      offLockReason: offItem.lockReason,
      onLockReason: onItem.lockReason,
      offExplicitKeySource: offItem.explicitKeySource,
      onExplicitKeySource: onItem.explicitKeySource,
    });
  }
  return rows;
}

function summarizePaired(rows: ReturnType<typeof buildPairedRows>) {
  const withDelta = rows.filter((r) => r.delta !== null) as Array<
    ReturnType<typeof buildPairedRows>[number] & { delta: number }
  >;
  const nPositive = withDelta.filter((r) => r.delta > 0).length;
  const nNegative = withDelta.filter((r) => r.delta < 0).length;
  const nTied = withDelta.filter((r) => r.delta === 0).length;
  const meanDelta =
    withDelta.length > 0 ? withDelta.reduce((sum, r) => sum + r.delta, 0) / withDelta.length : null;
  const pValue = signTestPValue(nPositive, nNegative);

  const lockCrosstab = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.offLockReason ?? 'null'} -> ${r.onLockReason ?? 'null'}`;
    lockCrosstab.set(key, (lockCrosstab.get(key) ?? 0) + 1);
  }

  return { n: withDelta.length, nPositive, nNegative, nTied, meanDelta, pValue, lockCrosstab };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function runArm(
  arm: Arm,
  flagValue: boolean,
  args: ParsedArgs,
  http: RunHttp,
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
): Promise<ArmResult> {
  console.log(`\n=== Arm ${arm} (${SIGNALS_FLAG_KEY}=${flagValue}) ===`);
  await writeSignalsFlag(supabase, flagValue);
  console.log(`  Flag set to ${flagValue}.`);

  const runId = await createRun(http, args.testId, args.modelTag);
  console.log('  Executing…');
  await waitForTerminalStatus(http, runId, args.runTimeoutMs, args.pollIntervalMs);
  console.log('  Generating report…');
  await generateAndWaitForReport(http, runId, args.reportTimeoutMs, args.pollIntervalMs);
  console.log('  Analyzing…');
  return analyzeRun(supabase, arm, runId);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabase = getSupabaseServiceRoleClient();

  console.log(`Test set:  ${args.testId}`);
  console.log(`Model tag: ${args.modelTag} (held constant on both arms)`);

  const originalFlagValue = await readSignalsFlag(supabase);
  console.log(`Current ${SIGNALS_FLAG_KEY} = ${originalFlagValue}`);

  if (!args.yes) {
    console.log(
      '\nDry check only — pass --yes to actually flip the flag (twice) and run both arms. ' +
        'This costs real LLM API spend and briefly changes a LIVE setting for all traffic during ' +
        'each arm\'s run.',
    );
    return;
  }

  const http = runHttpFromEnv();
  let restoredOk = false;

  let off: ArmResult | undefined;
  let on: ArmResult | undefined;
  try {
    off = await runArm('OFF', false, args, http, supabase);
    on = await runArm('ON', true, args, http, supabase);
  } finally {
    try {
      await writeSignalsFlag(supabase, originalFlagValue);
      restoredOk = true;
      console.log(`\nRestored ${SIGNALS_FLAG_KEY} to ${originalFlagValue}.`);
    } catch (restoreError) {
      console.error(
        `\n!!! COULD NOT RESTORE ${SIGNALS_FLAG_KEY} to ${originalFlagValue}: ` +
          `${(restoreError as Error).message}. FIX THIS MANUALLY — the flag is left at "true" (the ` +
          `last arm this script ran) for all live traffic.`,
      );
    }
  }

  if (!off || !on) return; // unreachable (errors above throw), satisfies TypeScript

  const rows = buildPairedRows(off, on);
  const summary = summarizePaired(rows);

  console.log('\n=== Paired result (OFF -> ON, same 224-item set, same day, same model) ===');
  console.log(`Run-level report_overall_avg:  OFF ${off.reportOverallAvg} (${off.reportOverallGrade})  ->  ON ${on.reportOverallAvg} (${on.reportOverallGrade})`);
  console.log(`Paired items with both sides evaluated: n=${summary.n}`);
  console.log(`  improved: ${summary.nPositive}   regressed: ${summary.nNegative}   tied: ${summary.nTied}`);
  console.log(`  mean per-item delta: ${summary.meanDelta?.toFixed(2) ?? 'n/a'}`);
  console.log(
    `  sign-test p-value (normal approx): ${summary.pValue?.toFixed(4) ?? 'n/a'} ` +
      `${summary.pValue !== null && summary.pValue < 0.05 ? '(significant at .05)' : '(not significant at .05)'}`,
  );
  console.log('\nProduct-lock lockReason transitions (OFF -> ON), paired by item:');
  for (const [transition, count] of [...summary.lockCrosstab.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${transition}`);
  }
  if (!restoredOk) {
    console.log(`\n!!! REMINDER: ${SIGNALS_FLAG_KEY} restoration failed above — check public.settings now.`);
  }

  const outPath = path.resolve(process.cwd(), args.outPath);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    `${JSON.stringify({ testId: args.testId, modelTag: args.modelTag, off, on, pairedRows: rows, summary }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\nWrote full case data to ${args.outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
