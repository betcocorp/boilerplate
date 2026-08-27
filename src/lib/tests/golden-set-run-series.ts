/**
 * B0-466 — golden-set pass rate PER RUN, newest first, so a regression between two consecutive
 * runs of the same dataset is computable and therefore alertable.
 *
 * ## Why this is neither `golden-set.ts` nor `golden-set-trend.ts`
 * - `getGoldenSetTierRollup` (B0-572/B0-575) resolves exactly ONE run per golden test — the latest
 *   matching the version/window. Right for the /admin/tests verdict strip, useless for detecting a
 *   drop, because there is no earlier point to compare against.
 * - `getGoldenSetTrendForWindow` (B0-576) gives per-tier DAILY points aggregated across every
 *   golden test that ran that day, plus a delta against the preceding equal-length window. Right
 *   for the tier-card sparkline; wrong as an alert input, because which datasets ran varies by day
 *   (live check 2026-08-27: 12 golden tests, 1–8 completed full runs each, clustered on working
 *   days). A day where only a 5-item subset ran, compared against a day where a 20-item set ran,
 *   would produce a large delta caused entirely by dataset composition, not by any regression.
 *
 * So this module compares a dataset against ITSELF, run to run — the same identity rule
 * `~/lib/tests/run-comparison-diff.ts` uses for its post-mortem delta. Everything about pass-rate
 * semantics is reused rather than re-derived: candidate runs from `listGoldenCandidateRuns`
 * (completed, `run_mode = 'full'`), tier attribution from `isGoldenTier` on `test_items.priority`,
 * result rows from `listResultItemsForRuns`, and a NULL-priority golden item stays a REPORTED data
 * error (`rowsOnMissingPriorityItems`) that never enters a denominator, exactly as
 * `computeGoldenSetRollup` does it.
 */

import {
  isGoldenTier,
  listGoldenCandidateRuns,
  listGoldenItems,
  listGoldenTests,
  listResultItemsForRuns,
  GOLDEN_TIERS,
  type GoldenItemRow,
  type GoldenResultItemRow,
  type GoldenRunRow,
  type GoldenTestRow,
  type GoldenTier,
} from '~/lib/tests/golden-set';

/** How many recent runs per golden test the series keeps by default. Two is enough to diff. */
export const DEFAULT_MAX_RUNS_PER_TEST = 5;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export type GoldenTierPassRate = {
  tier: GoldenTier;
  gradedCount: number;
  passedCount: number;
  /** `null` when `gradedCount` is 0 — "no data" is not 0%, per the golden-set module's rule. */
  passRate: number | null;
};

export type GoldenRunPassRatePoint = {
  runId: string;
  appVersion: string | null;
  createdAt: string;
  /** Tier-attributed rows only, summed across tiers — the same rows the tier rollup counts. */
  gradedCount: number;
  passedCount: number;
  passRate: number | null;
  tiers: GoldenTierPassRate[];
  /** Graded rows on NULL-priority items: surfaced as a data error, never in a denominator. */
  rowsOnMissingPriorityItems: number;
};

export type GoldenTestRunSeries = {
  testId: string;
  testName: string;
  /** NEWEST FIRST, so `points[0]` is current and `points[1]` is what it is compared against. */
  points: GoldenRunPassRatePoint[];
};

export type GoldenRunSeries = {
  windowFrom: string | null;
  windowTo: string | null;
  /** One entry per golden test that has at least one completed run in the window. */
  tests: GoldenTestRunSeries[];
  /** Golden tests with no completed run in the window at all — reported, not silently absent. */
  testsWithoutRuns: { testId: string; testName: string }[];
};

/**
 * Pure fold, exported for unit tests. `runs` must already be the completed, full-mode candidate
 * rows and `resultItems` their result rows; no filtering beyond that is repeated here.
 */
export function buildGoldenRunSeries(input: {
  tests: GoldenTestRow[];
  items: GoldenItemRow[];
  runs: GoldenRunRow[];
  resultItems: GoldenResultItemRow[];
  maxRunsPerTest?: number;
  window?: { from: string; to: string };
}): GoldenRunSeries {
  const maxRunsPerTest = Math.max(2, input.maxRunsPerTest ?? DEFAULT_MAX_RUNS_PER_TEST);
  const tierByItemId = new Map<string, GoldenTier | null>(
    input.items.map((item) => [item.id, isGoldenTier(item.priority) ? item.priority : null]),
  );

  const runsByTestId = new Map<string, GoldenRunRow[]>();
  for (const run of input.runs) {
    const list = runsByTestId.get(run.test_id) ?? [];
    list.push(run);
    runsByTestId.set(run.test_id, list);
  }

  const itemsByRunId = new Map<string, GoldenResultItemRow[]>();
  for (const row of input.resultItems) {
    const list = itemsByRunId.get(row.test_result_id) ?? [];
    list.push(row);
    itemsByRunId.set(row.test_result_id, list);
  }

  const tests: GoldenTestRunSeries[] = [];
  const testsWithoutRuns: { testId: string; testName: string }[] = [];

  for (const test of input.tests) {
    const runs = [...(runsByTestId.get(test.id) ?? [])].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
    if (runs.length === 0) {
      testsWithoutRuns.push({ testId: test.id, testName: test.name });
      continue;
    }

    const points = runs.slice(0, maxRunsPerTest).map((run) => {
      const tiers: GoldenTierPassRate[] = GOLDEN_TIERS.map((tier) => ({
        tier,
        gradedCount: 0,
        passedCount: 0,
        passRate: null,
      }));
      const tierIndex = new Map(tiers.map((entry) => [entry.tier, entry]));
      let rowsOnMissingPriorityItems = 0;

      for (const row of itemsByRunId.get(run.id) ?? []) {
        if (!tierByItemId.has(row.test_item_id)) {
          continue; // row for an item since deleted, as in computeGoldenSetRollup
        }
        const tier = tierByItemId.get(row.test_item_id) ?? null;
        if (tier === null) {
          rowsOnMissingPriorityItems += 1;
          continue;
        }
        const entry = tierIndex.get(tier)!;
        entry.gradedCount += 1;
        if (row.passed) {
          entry.passedCount += 1;
        }
      }

      let gradedCount = 0;
      let passedCount = 0;
      for (const entry of tiers) {
        entry.passRate =
          entry.gradedCount > 0 ? roundTo(entry.passedCount / entry.gradedCount, 4) : null;
        gradedCount += entry.gradedCount;
        passedCount += entry.passedCount;
      }

      return {
        runId: run.id,
        appVersion: run.app_version,
        createdAt: run.created_at,
        gradedCount,
        passedCount,
        passRate: gradedCount > 0 ? roundTo(passedCount / gradedCount, 4) : null,
        tiers,
        rowsOnMissingPriorityItems,
      } satisfies GoldenRunPassRatePoint;
    });

    tests.push({ testId: test.id, testName: test.name, points });
  }

  return {
    windowFrom: input.window?.from ?? null,
    windowTo: input.window?.to ?? null,
    tests: tests.sort((a, b) => a.testName.localeCompare(b.testName)),
    testsWithoutRuns,
  };
}

/** Reader half: golden membership + the last `maxRunsPerTest` completed runs per golden test. */
export async function getGoldenRunSeries(options?: {
  window?: { from: string; to: string };
  maxRunsPerTest?: number;
}): Promise<GoldenRunSeries> {
  const tests = await listGoldenTests();
  if (tests.length === 0) {
    return {
      windowFrom: options?.window?.from ?? null,
      windowTo: options?.window?.to ?? null,
      tests: [],
      testsWithoutRuns: [],
    };
  }

  const testIds = tests.map((test) => test.id);
  const [items, runs] = await Promise.all([
    listGoldenItems(testIds),
    listGoldenCandidateRuns(testIds, options?.window),
  ]);

  // Only the runs that can actually become points are fetched result rows, so widening
  // `maxRunsPerTest` is what costs rows here — not the size of the window's run history.
  const keptRunIds = new Set(
    buildGoldenRunSeries({ tests, items, runs, resultItems: [], ...options }).tests.flatMap(
      (test) => test.points.map((point) => point.runId),
    ),
  );
  const resultItems = await listResultItemsForRuns([...keptRunIds]);

  return buildGoldenRunSeries({ tests, items, runs, resultItems, ...options });
}
