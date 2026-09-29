import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { METRIC_ELIGIBLE_RUN_MODES, RUN_MODES } from './run-mode';

/**
 * B0-1105 / B0-1103 — a `test_results` row with `run_mode = 'partial'` must NEVER be aggregated
 * into any golden-set metric, rollup, trend, alert or report index. This suite pins that in two
 * ways:
 *
 * 1. Behaviour: every metric reader is run against a recording Supabase client, and every
 *    `test_results` query it issues (other than a by-id lookup) must carry the chokepoint
 *    predicate `in('run_mode', METRIC_ELIGIBLE_RUN_MODES)`. Removing `onlyMetricEligibleRuns`
 *    from any reader, or adding an unscoped `test_results` query to one, turns this red.
 * 2. Source: no file under `src/lib/tests/` other than `run-mode.ts` may put a `run_mode`
 *    literal into a query builder call. The single allowed exception is the search-runs list
 *    (`listSearchResultsByTestId`, `eq('run_mode', 'search')`), which is not a metric reader.
 */

type ChainCall = { method: string; args: unknown[] };
type RecordedQuery = { table: string; calls: ChainCall[] };

const GOLDEN_TEST_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const CURRENT_RUN_ID = 'a1b2c3d4-0000-4000-8000-0000000000aa';

const CHAIN_METHODS = [
  'select',
  'eq',
  'neq',
  'in',
  'not',
  'is',
  'gt',
  'gte',
  'lt',
  'lte',
  'order',
  'range',
  'limit',
] as const;

function isByIdLookup(query: RecordedQuery): boolean {
  return query.calls.some((call) => call.method === 'eq' && call.args[0] === 'id');
}

/** Rows the fake returns, chosen so each reader gets past its early-return guards. */
function rowsFor(query: RecordedQuery): unknown[] {
  if (query.table === 'tests') {
    return [
      {
        id: GOLDEN_TEST_ID,
        name: 'Golden fixture',
        row_count: 1,
        is_golden: true,
        is_archived: false,
      },
    ];
  }
  if (query.table === 'test_results' && isByIdLookup(query)) {
    return [{ id: CURRENT_RUN_ID, test_id: GOLDEN_TEST_ID, created_at: '2026-09-29T00:00:00Z' }];
  }
  return [];
}

function fakeRecordingClient(queries: RecordedQuery[]) {
  function chain(query: RecordedQuery) {
    const builder: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) {
      builder[method] = (...args: unknown[]) => {
        query.calls.push({ method, args });
        return builder;
      };
    }
    const resolveOne = (method: string) => (...args: unknown[]) => {
      query.calls.push({ method, args });
      return Promise.resolve({ data: rowsFor(query)[0] ?? null, error: null });
    };
    builder.single = resolveOne('single');
    builder.maybeSingle = resolveOne('maybeSingle');
    builder.then = (
      onFulfilled?: (value: { data: unknown[]; error: null }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: rowsFor(query), error: null }).then(onFulfilled, onRejected);
    return builder;
  }

  return {
    from: (table: string) => {
      const query: RecordedQuery = { table, calls: [] };
      queries.push(query);
      return chain(query);
    },
  };
}

let recorded: RecordedQuery[] = [];

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => fakeRecordingClient(recorded),
}));

import { getGoldenReportScoreTrendForWindow } from './golden-report-score-trend';
import { getGoldenSetTierRollup, listGoldenCandidateRuns } from './golden-set';
import { calculateGoldenSetMetrics } from './golden-set-metrics';
import { getGoldenRunSeries } from './golden-set-run-series';
import { getGoldenSetTrendForWindow } from './golden-set-trend';
import {
  getPreviousCompletedTestResult,
  listAllReportRuns,
  listSearchResultsByTestId,
  listTestResultsByTestId,
  listTests,
} from './repository';
import { listTestSetFailTrendRuns } from './test-set-fail-trend';

const EXPECTED_PREDICATE: ChainCall = {
  method: 'in',
  args: ['run_mode', [...METRIC_ELIGIBLE_RUN_MODES]],
};

function metricQueries(): RecordedQuery[] {
  return recorded.filter((query) => query.table === 'test_results' && !isByIdLookup(query));
}

function hasChokepointPredicate(query: RecordedQuery): boolean {
  return query.calls.some(
    (call) =>
      call.method === EXPECTED_PREDICATE.method &&
      JSON.stringify(call.args) === JSON.stringify(EXPECTED_PREDICATE.args),
  );
}

function expectEveryMetricQueryScoped(minimumQueries: number) {
  const queries = metricQueries();
  expect(queries.length).toBeGreaterThanOrEqual(minimumQueries);
  for (const query of queries) {
    expect(hasChokepointPredicate(query), JSON.stringify(query.calls)).toBe(true);
  }
}

const WINDOW = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-29T00:00:00.000Z' };

describe('METRIC_ELIGIBLE_RUN_MODES (B0-1105)', () => {
  it('admits only full runs — never partial, never search', () => {
    expect([...METRIC_ELIGIBLE_RUN_MODES]).toEqual(['full']);
    expect(RUN_MODES).toContain('partial');
    expect(METRIC_ELIGIBLE_RUN_MODES as readonly string[]).not.toContain('partial');
    expect(METRIC_ELIGIBLE_RUN_MODES as readonly string[]).not.toContain('search');
  });
});

describe('metric readers apply the run_mode chokepoint (B0-1105 / B0-1103)', () => {
  beforeEach(() => {
    recorded = [];
  });

  // --- B0-1103: /admin/tests cards + Test sets columns + fails chart ------------------------

  it('listTests scopes all three roll-up queries (Avg score, latest-run score/Fails/model, run count)', async () => {
    await listTests();
    expectEveryMetricQueryScoped(3);
  });

  it('listTestSetFailTrendRuns scopes the "Fails over time by test set" history', async () => {
    await listTestSetFailTrendRuns();
    expectEveryMetricQueryScoped(1);
  });

  it('listTestSetFailTrendRuns keeps the predicate under the only-golden toggle', async () => {
    await listTestSetFailTrendRuns({ onlyGolden: true });
    expectEveryMetricQueryScoped(1);
  });

  // --- B0-1103: /admin/tests/reports index + score/fail/metric trend charts -----------------

  it('listAllReportRuns scopes the cross-dataset report index', async () => {
    await listAllReportRuns();
    expectEveryMetricQueryScoped(1);
  });

  it('listAllReportRuns keeps the predicate under the only-golden toggle', async () => {
    await listAllReportRuns({ onlyGolden: true });
    expectEveryMetricQueryScoped(1);
  });

  // --- B0-1105: readers that were already filtered inline, now via the shared helper --------

  it('listTestResultsByTestId (dataset runs list) is scoped', async () => {
    await listTestResultsByTestId(GOLDEN_TEST_ID);
    expectEveryMetricQueryScoped(1);
  });

  it('getPreviousCompletedTestResult (post-mortem baseline) is scoped', async () => {
    await getPreviousCompletedTestResult(GOLDEN_TEST_ID, CURRENT_RUN_ID);
    expectEveryMetricQueryScoped(1);
  });

  it('listGoldenCandidateRuns is scoped, with and without a window', async () => {
    await listGoldenCandidateRuns([GOLDEN_TEST_ID]);
    await listGoldenCandidateRuns([GOLDEN_TEST_ID], WINDOW);
    expectEveryMetricQueryScoped(2);
  });

  it('getGoldenReportScoreTrendForWindow (report score-over-time panels) is scoped', async () => {
    await getGoldenReportScoreTrendForWindow({ window: WINDOW });
    expectEveryMetricQueryScoped(1);
  });

  // --- Transitive consumers: /admin/tests cards, /admin/bex/health rollups, alerts ----------

  it('calculateGoldenSetMetrics (golden cards on /admin/tests) is scoped end to end', async () => {
    await calculateGoldenSetMetrics();
    expectEveryMetricQueryScoped(4);
  });

  it('getGoldenSetTierRollup (/admin/bex/health tier rollup) is scoped end to end', async () => {
    await getGoldenSetTierRollup({ window: WINDOW });
    expectEveryMetricQueryScoped(1);
  });

  it('getGoldenSetTrendForWindow (tier sparklines) is scoped end to end', async () => {
    await getGoldenSetTrendForWindow({ window: WINDOW });
    expectEveryMetricQueryScoped(1);
  });

  it('getGoldenRunSeries (run-alert-evaluation input) is scoped end to end', async () => {
    await getGoldenRunSeries();
    expectEveryMetricQueryScoped(1);
  });

  // --- Negative control: the harness can tell an unscoped query apart -----------------------

  it('leaves the search-runs list unscoped (search behaviour is untouched)', async () => {
    await listSearchResultsByTestId(GOLDEN_TEST_ID);
    const queries = metricQueries();
    expect(queries).toHaveLength(1);
    expect(hasChokepointPredicate(queries[0])).toBe(false);
    expect(queries[0].calls).toContainEqual({ method: 'eq', args: ['run_mode', 'search'] });
  });
});

// ---------------------------------------------------------------------------
// Source-level guard
// ---------------------------------------------------------------------------

const TESTS_LIB_DIR = join(__dirname);

/** Builder calls that put a `run_mode` literal into a query: `.eq('run_mode', …)` and friends. */
const RUN_MODE_PREDICATE = /\.(eq|neq|in|not|is|filter|or|match)\(\s*['"`]run_mode['"`][^)]*\)/g;

/** `file → matched predicate text` pairs that are allowed to exist outside `run-mode.ts`. */
const ALLOWED_RUN_MODE_PREDICATES: ReadonlyArray<{ file: string; predicate: string }> = [
  // The search-runs page list: a `search` reader, not a metric reader (B0-1105 scope note).
  { file: 'repository.ts', predicate: ".eq('run_mode', 'search')" },
  // B0-1101 — the per-item latest-score fold for threshold-filtered dispatch. It reads full AND
  // partial history by design (via the shared CHAT_RUN_MODES constant, never a literal) and feeds
  // the Run Golden working set, not a metric.
  { file: 'latest-item-scores.ts', predicate: ".in('run_mode', [...CHAT_RUN_MODES])" },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      entry.name !== 'run-mode.ts'
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('no run_mode literal outside run-mode.ts (B0-1105 source guard)', () => {
  it('every run_mode predicate in src/lib/tests/** is either the chokepoint or the search list', () => {
    const found: Array<{ file: string; predicate: string }> = [];
    for (const file of listSourceFiles(TESTS_LIB_DIR)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(RUN_MODE_PREDICATE)) {
        found.push({ file: relative(TESTS_LIB_DIR, file), predicate: match[0] });
      }
    }

    expect(found).toEqual(ALLOWED_RUN_MODE_PREDICATES);
  });

  it('the eligible-mode list is defined exactly once', () => {
    const declarations: string[] = [];
    for (const file of listSourceFiles(TESTS_LIB_DIR)) {
      const source = readFileSync(file, 'utf8');
      if (/METRIC_ELIGIBLE_RUN_MODES\s*=/.test(source)) {
        declarations.push(relative(TESTS_LIB_DIR, file));
      }
    }
    expect(declarations).toEqual([]);
  });
});
