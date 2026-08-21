import {
  GOLDEN_TIERS,
  isGoldenTier,
  listGoldenCandidateRuns,
  listGoldenItems,
  listGoldenTests,
  type GoldenItemRow,
  type GoldenResultItemRow,
  type GoldenRunRow,
  type GoldenTier,
} from './golden-set';
import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-576 — per-tier daily pass-rate trend for the tier-card sparklines.
 *
 * Golden-set membership is exactly what `~/lib/tests/golden-set.ts` defines
 * (`tests.is_golden` + `test_items.priority`); non-golden runs never move the line because
 * only golden tests' completed full-mode runs are fetched at all. A day with no golden-set
 * run is a GAP — that day is simply absent from the series, never a zero point. Items with
 * a NULL priority are a B0-572 data error surfaced by the golden-set reader's validation
 * list; the trend skips their rows (they belong to no tier) rather than inventing a bucket.
 *
 * Days are UTC calendar days of the RUN's `created_at`, so all rows of one run land on one
 * day even when item rows straddle midnight.
 *
 * ## Why this folds rows in Node instead of a Postgres RPC
 * Same reasoning and budget as `~/lib/observability/aggregates.ts` and
 * `~/lib/tests/golden-set.ts`: the window is short (default 14 days) and golden sets are a
 * small curated subset, so the scans are a few 1000-row pages at most. Documented trigger
 * for change: if a window's scans ever exceed `MAX_SCAN_PAGES * SCAN_PAGE_SIZE` rows
 * (20,000), or this reader becomes a visible source of latency, replace the scans with a
 * Postgres RPC following the `admin_latest_failures_*` precedent rather than growing the
 * page budget here.
 */

/** PostgREST caps a request at 1000 rows; sweep in pages of that size. */
const SCAN_PAGE_SIZE = 1000;
const MAX_SCAN_PAGES = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 14;

export type TierTrendPoint = {
  tier: GoldenTier;
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  passed: number;
  total: number;
};

/**
 * Delta vs the preceding equal-length window, in percentage POINTS (the "↗/↘ n pts" chip).
 * `null` — not zero — when either window has no graded golden-set rows for the tier: a
 * missing prior window is "no comparison", not "no change".
 */
export type TierTrendDelta = Record<GoldenTier, number | null>;

export type GoldenSetTrend = {
  /** Chronological, gap days absent. */
  series: TierTrendPoint[];
  deltaByTier: TierTrendDelta;
  window: { from: string; to: string };
};

// ---------------------------------------------------------------------------
// Pure computation (unit-tested without a database)
// ---------------------------------------------------------------------------

export type TrendResultItemRow = Pick<
  GoldenResultItemRow,
  'test_result_id' | 'test_item_id' | 'passed'
>;

function utcDayOf(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/**
 * Folds result rows into per-tier daily {passed, total} points. Days with no rows for a
 * tier produce NO point for that tier (gap, not zero). Output is sorted day-asc, tier-asc.
 */
export function buildDailyTierSeries(input: {
  runs: GoldenRunRow[];
  items: Pick<GoldenItemRow, 'id' | 'priority'>[];
  resultItems: TrendResultItemRow[];
}): TierTrendPoint[] {
  const dayByRunId = new Map(input.runs.map((run) => [run.id, utcDayOf(run.created_at)]));
  const tierByItemId = new Map<string, GoldenTier>();
  for (const item of input.items) {
    if (isGoldenTier(item.priority)) {
      tierByItemId.set(item.id, item.priority);
    }
  }

  const pointByKey = new Map<string, TierTrendPoint>();
  for (const row of input.resultItems) {
    const day = dayByRunId.get(row.test_result_id);
    if (!day) continue; // not a golden run in the window
    const tier = tierByItemId.get(row.test_item_id);
    if (!tier) continue; // untiered (data error — surfaced by golden-set.ts) or deleted item

    const key = `${day}|${tier}`;
    const point = pointByKey.get(key) ?? { tier, day, passed: 0, total: 0 };
    point.total += 1;
    if (row.passed) point.passed += 1;
    pointByKey.set(key, point);
  }

  return [...pointByKey.values()].sort((a, b) =>
    a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.tier - b.tier,
  );
}

/**
 * Per-tier pass-rate delta (current minus prior) in percentage points, rounded to one
 * decimal. `null` when either window has no graded rows for the tier — an absent prior
 * window is no comparison, never a zero delta.
 */
export function computeTierTrendDeltas(
  currentSeries: TierTrendPoint[],
  priorSeries: TierTrendPoint[],
): TierTrendDelta {
  const rateOf = (series: TierTrendPoint[], tier: GoldenTier): number | null => {
    let passed = 0;
    let total = 0;
    for (const point of series) {
      if (point.tier !== tier) continue;
      passed += point.passed;
      total += point.total;
    }
    return total > 0 ? passed / total : null;
  };

  const deltas = {} as TierTrendDelta;
  for (const tier of GOLDEN_TIERS) {
    const current = rateOf(currentSeries, tier);
    const prior = rateOf(priorSeries, tier);
    deltas[tier] =
      current === null || prior === null
        ? null
        : Math.round((current - prior) * 1000) / 10;
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

async function listTrendResultItems(runIds: string[]): Promise<TrendResultItemRow[]> {
  if (runIds.length === 0) return [];
  const supabase = getSupabaseServiceRoleClient();
  const all: TrendResultItemRow[] = [];
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    const result = await supabase
      .from('test_result_items')
      .select('test_result_id, test_item_id, passed')
      .in('test_result_id', runIds)
      .order('id', { ascending: true })
      .range(start, start + SCAN_PAGE_SIZE - 1);
    const rows = (assertNoError(result) ?? []) as TrendResultItemRow[];
    all.push(...rows);
    if (rows.length < SCAN_PAGE_SIZE) break;
  }
  return all;
}

/**
 * The tier-card sparkline reader: per-tier daily pass points over the trailing
 * `windowDays` (default 14), plus the delta against the preceding equal-length window.
 * Both windows are fetched in ONE run scan and split in Node.
 */
export async function getGoldenSetDailyTrend(
  options: { windowDays?: number; now?: Date } = {},
): Promise<GoldenSetTrend> {
  const windowDays = Math.min(Math.max(options.windowDays ?? DEFAULT_WINDOW_DAYS, 1), 90);
  const now = options.now ?? new Date();
  const windowFrom = new Date(now.getTime() - windowDays * DAY_MS);
  const priorFrom = new Date(now.getTime() - 2 * windowDays * DAY_MS);

  const tests = await listGoldenTests();
  const testIds = tests.map((test) => test.id);
  const emptyDeltas = { 1: null, 2: null, 3: null } as TierTrendDelta;
  const window = { from: windowFrom.toISOString(), to: now.toISOString() };
  if (testIds.length === 0) {
    return { series: [], deltaByTier: emptyDeltas, window };
  }

  const [items, runs] = await Promise.all([
    listGoldenItems(testIds),
    // One scan covering both the current and the prior comparison window.
    listGoldenCandidateRuns(testIds, {
      from: priorFrom.toISOString(),
      to: now.toISOString(),
    }),
  ]);
  const resultItems = await listTrendResultItems(runs.map((run) => run.id));

  const currentRuns = runs.filter((run) => run.created_at >= window.from);
  const priorRuns = runs.filter((run) => run.created_at < window.from);

  const series = buildDailyTierSeries({ runs: currentRuns, items, resultItems });
  const priorSeries = buildDailyTierSeries({ runs: priorRuns, items, resultItems });

  return {
    series,
    deltaByTier: computeTierTrendDeltas(series, priorSeries),
    window,
  };
}
