/**
 * B0-1101 — each test item's latest displayed score across full AND partial golden runs.
 *
 * This is the read side of threshold-filtered partial runs (epic B0-1099): "Only re-run items
 * scoring below N" needs, per `test_items.id`, the number a person would see on the most recent
 * run page that graded that item. The decisions from Tom's 2026-09-29 grill, implemented here:
 *
 * 1. **Score source** — the item's most recent completed + graded run of EITHER chat mode
 *    (`run_mode in CHAT_RUN_MODES`, `status in COMPLETED_RUN_STATUSES`, `report_state.status ===
 *    'completed'`). `search` runs never count. A newer full run naturally supersedes a partial.
 * 2. **The number** — the DISPLAYED per-case `overall` after the B0-835 mandatory floor / ceiling,
 *    exactly as `computeReportMetrics` produces it for the run page. `report_state.caseScores`
 *    carries no `overall`, so it is never re-derived here: `snapshotRunScores` reuses the smallest
 *    slice of the run page's own path (`assembleReportCases` → `computeReportMetrics` →
 *    `metrics.perCase[].overall`, keyed by `test_items.id`).
 * 3. **The fold** — newest run first, first value seen per item wins. A run with a non-null
 *    `item_scope` may only supply values for items IN that scope; every other item falls through to
 *    an older run (otherwise a partial run's un-run items would look unscored). An in-scope item
 *    whose latest grading is Unable to Evaluate records `overall: null` from that run and stops
 *    folding — UTE is a result, not a gap.
 * 4. Items never graded by any scanned run are absent from the map. The caller
 *    (`~/lib/tests/threshold-working-set.ts`) treats absent and `overall: null` alike: included.
 *
 * The scan is bounded: at most {@link LATEST_SCORE_RUN_SCAN_LIMIT} qualifying runs are read, and it
 * stops early once every current item of the test has a value.
 */

import { assertSupabaseNoError } from '~/lib/utils';
import { assembleReportCases } from '~/lib/tests/report/assemble';
import { parseReportState, type ReportState } from '~/lib/tests/report/schemas';
import { getTestById, getTestItemsByTestId } from '~/lib/tests/repository';
import { CHAT_RUN_MODES } from '~/lib/tests/run-mode';
import {
  COMPLETED_RUN_STATUSES,
  type TestItemRecord,
  type TestRecord,
  type TestResultRecord,
} from '~/lib/tests/types';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * One item's latest score. `overall` is the displayed 0–100 number, or `null` when the item's
 * latest grading was Unable to Evaluate; `asOfRunId` is the `test_results.id` it came from.
 */
export type LatestItemScore =
  | { overall: number; asOfRunId: string }
  | { overall: null; asOfRunId: string };

/** Keyed by `test_items.id`. An item no scanned run graded is absent. */
export type LatestItemScores = Map<string, LatestItemScore>;

/** How many qualifying runs (newest first) the fold will read before giving up on older history. */
export const LATEST_SCORE_RUN_SCAN_LIMIT = 20;

/**
 * What the fold needs from one run: its id, its scope, and the displayed score per item it
 * graded. `scores` holds ONLY items the run's report graded (`null` = Unable to Evaluate); an item
 * missing from the map was not graded by that run and must fall through.
 */
export type RunScoreSnapshot = {
  runId: string;
  /** `test_results.item_scope` — null for a full run. */
  itemScope: readonly string[] | null;
  scores: ReadonlyMap<string, number | null>;
};

/* -------------------------------------------------------------------------- *
 * Pure fold
 * -------------------------------------------------------------------------- */

/** Folds one run (newer than everything already folded) into `fold`; first value per item wins. */
export function absorbRunScores(fold: LatestItemScores, snapshot: RunScoreSnapshot): void {
  const scope = snapshot.itemScope === null ? null : new Set(snapshot.itemScope);

  for (const [itemId, overall] of snapshot.scores) {
    if (scope !== null && !scope.has(itemId)) {
      // Out of the partial run's scope: this run says nothing about the item.
      continue;
    }
    if (fold.has(itemId)) {
      continue;
    }
    fold.set(itemId, { overall, asOfRunId: snapshot.runId });
  }
}

/** True once every id in `itemIds` has a value — the signal to stop reading older runs. */
export function isFoldComplete(fold: LatestItemScores, itemIds: readonly string[]): boolean {
  return itemIds.every((id) => fold.has(id));
}

/**
 * The whole fold over already-built snapshots, NEWEST FIRST. `itemIds` (the test's current items)
 * enables the early stop; without it every snapshot is read.
 */
export function foldLatestItemScores(
  snapshots: readonly RunScoreSnapshot[],
  itemIds?: readonly string[],
): LatestItemScores {
  const fold: LatestItemScores = new Map();
  for (const snapshot of snapshots) {
    absorbRunScores(fold, snapshot);
    if (itemIds && isFoldComplete(fold, itemIds)) {
      break;
    }
  }
  return fold;
}

/* -------------------------------------------------------------------------- *
 * Per-run snapshot — the run page's own numbers
 * -------------------------------------------------------------------------- */

/** Rule 1: a chat-mode run that finished executing and whose report finished scoring. */
export function isScoredChatRun(
  run: Pick<TestResultRecord, 'run_mode' | 'status'>,
  state: ReportState | null,
): boolean {
  return (
    (CHAT_RUN_MODES as readonly string[]).includes(run.run_mode) &&
    (COMPLETED_RUN_STATUSES as readonly string[]).includes(run.status) &&
    state !== null &&
    state.status === 'completed'
  );
}

/**
 * Builds a run's snapshot through the same assemble → metrics path the run page renders from.
 *
 * Only items the report actually graded (present in `caseScores`) and, for a partial run, inside
 * `item_scope` are assembled; anything else is deliberately left out of `scores` so the fold falls
 * through to an older run rather than reading `assembleReportCases`'s "not scored in this report"
 * placeholder as a real Unable-to-Evaluate verdict.
 */
export function snapshotRunScores(input: {
  test: TestRecord;
  run: TestResultRecord;
  state: ReportState;
  items: TestItemRecord[];
}): RunScoreSnapshot {
  const { test, run, state, items } = input;
  const scope = run.item_scope === null ? null : new Set(run.item_scope);
  const gradedItems = items.filter(
    (item) => (scope === null || scope.has(item.id)) && item.id in state.caseScores,
  );

  const scores = new Map<string, number | null>();
  if (gradedItems.length === 0) {
    return { runId: run.id, itemScope: run.item_scope, scores };
  }

  const assembled = assembleReportCases({
    test,
    run,
    items: gradedItems,
    // Timings only feed the speed block; `overall` never reads them.
    resultItems: [],
    caseScores: state.caseScores,
    casePassScores: state.casePassScores,
    spreadThreshold: state.spreadThreshold,
    passMark: state.passMark,
    judgedThresholds: state.judgedThresholds,
    scoringRules: state.scoringRules,
    // A read of a stored report: surface a reconciliation failure as a warning, never a throw.
    invariantSeverity: 'warn',
  });

  for (const evaluated of assembled.metrics.perCase) {
    scores.set(evaluated.id, evaluated.overall);
  }
  for (const ute of assembled.metrics.ute) {
    if (!scores.has(ute.id)) {
      scores.set(ute.id, null);
    }
  }

  return { runId: run.id, itemScope: run.item_scope, scores };
}

/* -------------------------------------------------------------------------- *
 * Database wiring
 * -------------------------------------------------------------------------- */

/**
 * The newest `limit` runs that can carry a score, newest first. The SQL side already applies
 * rule 1 so the scan limit counts qualifying runs, not runs of any kind; `isScoredChatRun`
 * re-checks after the Zod parse because `report_state` is only trusted once it parses.
 */
async function listScoredChatRuns(testId: string, limit: number): Promise<TestResultRecord[]> {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_results')
    .select('*')
    .eq('test_id', testId)
    .in('run_mode', [...CHAT_RUN_MODES])
    .in('status', [...COMPLETED_RUN_STATUSES])
    .not('report_state', 'is', null)
    .eq('report_state->>status', 'completed')
    .order('created_at', { ascending: false })
    .limit(limit);

  return (assertSupabaseNoError(result) || []) as TestResultRecord[];
}

/**
 * The latest displayed score per item of `testId` — see the module header for the rules.
 *
 * Reads the test and its items once, then assembles at most `scanLimit` runs newest first, stopping
 * as soon as every current item has a value.
 */
export async function getLatestItemScores(
  testId: string,
  options: { scanLimit?: number } = {},
): Promise<LatestItemScores> {
  const scanLimit = options.scanLimit ?? LATEST_SCORE_RUN_SCAN_LIMIT;
  const [test, items, runs] = await Promise.all([
    getTestById(testId),
    getTestItemsByTestId(testId),
    listScoredChatRuns(testId, scanLimit),
  ]);
  const itemIds = items.map((item) => item.id);

  const fold: LatestItemScores = new Map();
  for (const run of runs) {
    const state = parseReportState(run.report_state);
    if (!state || !isScoredChatRun(run, state)) {
      continue;
    }
    absorbRunScores(fold, snapshotRunScores({ test, run, state, items }));
    if (isFoldComplete(fold, itemIds)) {
      break;
    }
  }

  return fold;
}
