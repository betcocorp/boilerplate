import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaseConcepts, CaseScore } from '~/lib/tests/report/schemas';
import { reportStateSchema, type ReportState } from '~/lib/tests/report/schemas';
import type { TestItemRecord, TestRecord, TestResultRecord } from '~/lib/tests/types';

/**
 * B0-1101 — the latest displayed score per item across full AND partial golden runs.
 *
 * The fold is exercised on hand-built snapshots (the rules), `snapshotRunScores` on a stored
 * `report_state` (the number is the run page's `metrics.perCase[].overall`, floor/ceiling applied),
 * and `getLatestItemScores` end to end against a stubbed `test_results` read.
 */

/* ---------------------------------- DB stubs ---------------------------------- */

const dbRuns: unknown[] = [];
const dbCalls: { method: string; args: unknown[] }[] = [];

function chain() {
  const self: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'not', 'order', 'limit']) {
    self[method] = (...args: unknown[]) => {
      dbCalls.push({ method, args });
      return self;
    };
  }
  self.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: dbRuns, error: null }).then(resolve);
  return self;
}

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({ from: () => chain() }),
}));

vi.mock('~/lib/tests/repository', () => ({
  getTestById: vi.fn(),
  getTestItemsByTestId: vi.fn(),
}));

const { getTestById, getTestItemsByTestId } = await import('~/lib/tests/repository');
const {
  absorbRunScores,
  foldLatestItemScores,
  getLatestItemScores,
  isFoldComplete,
  isScoredChatRun,
  snapshotRunScores,
} = await import('~/lib/tests/latest-item-scores');

/* ---------------------------------- Fixtures ---------------------------------- */

const TEST_ID = 'b2c3d4e5-2222-4222-8222-222222222222';
const A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = '33333333-cccc-4ccc-8ccc-cccccccccccc';

const TEST = { id: TEST_ID, name: 'Golden — dilution', intended_agent: null } as unknown as TestRecord;

function item(id: string, partial: Partial<TestItemRecord> = {}): TestItemRecord {
  return {
    id,
    test_id: TEST_ID,
    row_index: 0,
    prompt: `prompt ${id}`,
    prompt_category: null,
    priority: null,
    ideal_response: null,
    expected_concepts: ['States the 1:64 ratio.', 'Metric equivalent as printed: 15.6 mL/L'],
    minimum_concepts: ['States the 1:64 ratio.'],
    expected_sources: [],
    ...partial,
  } as unknown as TestItemRecord;
}

const ITEMS = [item(A), item(B), item(C)];

/** All concepts satisfied: 0.4·92 + 0.3·100 + 0.2·95 + 0.1·90 = 94.8 → 95 (assemble.test.ts pins the same). */
const CONCEPTS_FULL: CaseConcepts = {
  mandatory: { required: ['States the 1:64 ratio.'], satisfied: ['States the 1:64 ratio.'], missing: [] },
  expected: {
    required: ['States the 1:64 ratio.', 'Metric equivalent as printed: 15.6 mL/L'],
    satisfied: ['States the 1:64 ratio.', 'Metric equivalent as printed: 15.6 mL/L'],
    missing: [],
  },
  materialIssue: false,
  materialIssueNote: null,
};

/** Nothing satisfied, must-have missed: 0.4·30 + 0.3·0 + 0.2·50 + 0.1·60 = 28, under the 59 ceiling. */
const CONCEPTS_NONE: CaseConcepts = {
  mandatory: { required: ['States the 1:64 ratio.'], satisfied: [], missing: ['States the 1:64 ratio.'] },
  expected: {
    required: ['States the 1:64 ratio.', 'Metric equivalent as printed: 15.6 mL/L'],
    satisfied: [],
    missing: ['States the 1:64 ratio.', 'Metric equivalent as printed: 15.6 mL/L'],
  },
  materialIssue: false,
  materialIssueNote: null,
};

function score(partial: Partial<CaseScore>): CaseScore {
  return {
    unableToEvaluate: false,
    uteReason: null,
    accuracy: null,
    completeness: null,
    relevance: null,
    clarity: null,
    explanation: '',
    missed: '',
    incorrect: '',
    improvement: '',
    ...partial,
  };
}

const HIGH = score({ accuracy: 92, relevance: 95, clarity: 90, concepts: CONCEPTS_FULL });
const LOW = score({ accuracy: 30, relevance: 50, clarity: 60, concepts: CONCEPTS_NONE });
const UTE = score({ unableToEvaluate: true, uteReason: 'Grader could not evaluate.' });

function state(caseScores: Record<string, CaseScore>, status: ReportState['status'] = 'completed') {
  return reportStateSchema.parse({
    status,
    model: 'gpt-4.1',
    totalCases: Object.keys(caseScores).length,
    completedCases: Object.keys(caseScores).length,
    startedAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:10:00.000Z',
    caseScores,
    synthesis: null,
    error: null,
  });
}

function run(partial: {
  id: string;
  run_mode?: string;
  status?: string;
  item_scope?: string[] | null;
  report_state?: unknown;
}): TestResultRecord {
  return {
    test_id: TEST_ID,
    run_mode: 'full',
    status: 'completed',
    item_scope: null,
    partial_score_threshold: null,
    report_state: null,
    ...partial,
  } as unknown as TestResultRecord;
}

/* ---------------------------------- Pure fold ---------------------------------- */

describe('foldLatestItemScores (B0-1101)', () => {
  it('full-only history: the newest run wins for every item', () => {
    const fold = foldLatestItemScores([
      { runId: 'newer', itemScope: null, scores: new Map([[A, 90], [B, 40]]) },
      { runId: 'older', itemScope: null, scores: new Map([[A, 10], [B, 10]]) },
    ]);

    expect(fold.get(A)).toEqual({ overall: 90, asOfRunId: 'newer' });
    expect(fold.get(B)).toEqual({ overall: 40, asOfRunId: 'newer' });
  });

  it('partial-then-full: a newer full run supersedes the partial for every item', () => {
    const fold = foldLatestItemScores([
      { runId: 'full-new', itemScope: null, scores: new Map([[A, 85], [B, 70], [C, 60]]) },
      { runId: 'partial-old', itemScope: [B], scores: new Map([[B, 20]]) },
    ]);

    expect(fold.get(B)).toEqual({ overall: 70, asOfRunId: 'full-new' });
    expect(fold.size).toBe(3);
  });

  it('full-then-partial: out-of-scope items fall through to the older full run', () => {
    const fold = foldLatestItemScores([
      { runId: 'partial-new', itemScope: [B], scores: new Map([[B, 80]]) },
      { runId: 'full-old', itemScope: null, scores: new Map([[A, 50], [B, 20], [C, 95]]) },
    ]);

    expect(fold.get(A)).toEqual({ overall: 50, asOfRunId: 'full-old' });
    expect(fold.get(B)).toEqual({ overall: 80, asOfRunId: 'partial-new' });
    expect(fold.get(C)).toEqual({ overall: 95, asOfRunId: 'full-old' });
  });

  it('a partial run never supplies a value for an item outside its scope, even if its snapshot has one', () => {
    const fold = foldLatestItemScores([
      { runId: 'partial-new', itemScope: [B], scores: new Map([[A, 99], [B, 80]]) },
      { runId: 'full-old', itemScope: null, scores: new Map([[A, 50]]) },
    ]);

    expect(fold.get(A)).toEqual({ overall: 50, asOfRunId: 'full-old' });
  });

  it('Unable to Evaluate on the latest run records null and stops folding', () => {
    const fold = foldLatestItemScores([
      { runId: 'newer', itemScope: null, scores: new Map([[A, null]]) },
      { runId: 'older', itemScope: null, scores: new Map([[A, 88]]) },
    ]);

    expect(fold.get(A)).toEqual({ overall: null, asOfRunId: 'newer' });
  });

  it('an item no run graded is absent', () => {
    const fold = foldLatestItemScores([
      { runId: 'r', itemScope: null, scores: new Map([[A, 1]]) },
    ]);

    expect(fold.has(C)).toBe(false);
  });

  it('stops reading older runs once every item has a value', () => {
    const fold = foldLatestItemScores(
      [
        { runId: 'r1', itemScope: null, scores: new Map([[A, 1], [B, 2]]) },
        { runId: 'r2', itemScope: null, scores: new Map([[C, 3]]) },
      ],
      [A, B],
    );

    expect(fold.has(C)).toBe(false);
    expect(isFoldComplete(fold, [A, B])).toBe(true);
    expect(isFoldComplete(fold, [A, B, C])).toBe(false);
  });

  it('absorbRunScores is first-wins across calls', () => {
    const fold = new Map();
    absorbRunScores(fold, { runId: 'r1', itemScope: null, scores: new Map([[A, 5]]) });
    absorbRunScores(fold, { runId: 'r2', itemScope: null, scores: new Map([[A, 6]]) });
    expect(fold.get(A)).toEqual({ overall: 5, asOfRunId: 'r1' });
  });
});

/* ---------------------------------- Rule 1 ---------------------------------- */

describe('isScoredChatRun', () => {
  const completed = state({});

  it.each(['full', 'partial'])('accepts a completed, graded %s run', (mode) => {
    expect(isScoredChatRun({ run_mode: mode, status: 'completed' }, completed)).toBe(true);
    expect(isScoredChatRun({ run_mode: mode, status: 'completed_with_failures' }, completed)).toBe(true);
  });

  it('never a search run', () => {
    expect(isScoredChatRun({ run_mode: 'search', status: 'completed' }, completed)).toBe(false);
  });

  it.each(['running', 'queued', 'failed', 'cancelled', 'technical_error'])(
    'rejects a %s run',
    (status) => {
      expect(isScoredChatRun({ run_mode: 'full', status }, completed)).toBe(false);
    },
  );

  it.each(['idle', 'scoring', 'synthesizing', 'failed'] as const)(
    'rejects a run whose report is %s',
    (reportStatus) => {
      expect(isScoredChatRun({ run_mode: 'full', status: 'completed' }, state({}, reportStatus))).toBe(false);
    },
  );

  it('rejects a run with no parseable report_state', () => {
    expect(isScoredChatRun({ run_mode: 'full', status: 'completed' }, null)).toBe(false);
  });
});

/* ---------------------------------- Rule 2 ---------------------------------- */

describe('snapshotRunScores', () => {
  it('yields the displayed overall (floor/ceiling applied) per graded item, null for UTE', () => {
    const snapshot = snapshotRunScores({
      test: TEST,
      run: run({ id: 'run-1' }),
      state: state({ [A]: HIGH, [B]: LOW, [C]: UTE }),
      items: ITEMS,
    });

    expect(snapshot).toMatchObject({ runId: 'run-1', itemScope: null });
    expect(snapshot.scores.get(A)).toBe(95);
    expect(snapshot.scores.get(B)).toBe(28);
    expect(snapshot.scores.get(C)).toBeNull();
  });

  it('an item with no expected concepts is Unable to Evaluate (B0-835), so null', () => {
    const snapshot = snapshotRunScores({
      test: TEST,
      run: run({ id: 'run-1' }),
      state: state({ [A]: score({ accuracy: 90, relevance: 90, clarity: 90 }) }),
      items: [item(A, { expected_concepts: [], minimum_concepts: [] })],
    });

    expect(snapshot.scores.get(A)).toBeNull();
  });

  it('leaves out items the report never graded (dataset drift) so they fall through', () => {
    const snapshot = snapshotRunScores({
      test: TEST,
      run: run({ id: 'run-1' }),
      state: state({ [A]: HIGH }),
      items: ITEMS,
    });

    expect(snapshot.scores.has(A)).toBe(true);
    expect(snapshot.scores.has(B)).toBe(false);
    expect(snapshot.scores.has(C)).toBe(false);
  });

  it('a partial run only yields in-scope items and carries its scope', () => {
    const snapshot = snapshotRunScores({
      test: TEST,
      run: run({ id: 'run-p', run_mode: 'partial', item_scope: [B] }),
      state: state({ [A]: HIGH, [B]: LOW }),
      items: ITEMS,
    });

    expect(snapshot.itemScope).toEqual([B]);
    expect(Array.from(snapshot.scores.keys())).toEqual([B]);
    expect(snapshot.scores.get(B)).toBe(28);
  });

  it('an empty graded set yields an empty snapshot without assembling', () => {
    const snapshot = snapshotRunScores({
      test: TEST,
      run: run({ id: 'run-1', item_scope: [C] }),
      state: state({ [A]: HIGH }),
      items: ITEMS,
    });

    expect(snapshot.scores.size).toBe(0);
  });
});

/* ---------------------------------- End to end ---------------------------------- */

describe('getLatestItemScores', () => {
  beforeEach(() => {
    dbRuns.length = 0;
    dbCalls.length = 0;
    vi.mocked(getTestById).mockReset();
    vi.mocked(getTestItemsByTestId).mockReset();
    vi.mocked(getTestById).mockResolvedValue(TEST);
    vi.mocked(getTestItemsByTestId).mockResolvedValue(ITEMS);
  });

  it('folds newest-first: a partial re-run of B overrides the full run for B only', async () => {
    dbRuns.push(
      run({
        id: 'partial-new',
        run_mode: 'partial',
        status: 'completed_with_failures',
        item_scope: [B],
        report_state: state({ [B]: HIGH }),
      }),
      run({ id: 'full-old', report_state: state({ [A]: LOW, [B]: LOW, [C]: UTE }) }),
    );

    const scores = await getLatestItemScores(TEST_ID);

    expect(scores.get(A)).toEqual({ overall: 28, asOfRunId: 'full-old' });
    expect(scores.get(B)).toEqual({ overall: 95, asOfRunId: 'partial-new' });
    expect(scores.get(C)).toEqual({ overall: null, asOfRunId: 'full-old' });
  });

  it('ignores a search run and an unfinished report even if the query returned them', async () => {
    dbRuns.push(
      run({ id: 'search', run_mode: 'search', report_state: state({ [A]: HIGH }) }),
      run({ id: 'scoring', report_state: state({ [A]: HIGH }, 'scoring') }),
      run({ id: 'garbage', report_state: { nope: true } }),
      run({ id: 'full-old', report_state: state({ [A]: LOW }) }),
    );

    const scores = await getLatestItemScores(TEST_ID);

    expect(scores.get(A)).toEqual({ overall: 28, asOfRunId: 'full-old' });
    expect(scores.size).toBe(1);
  });

  it('scopes the read to chat modes, completed statuses and finished reports, bounded by the scan limit', async () => {
    await getLatestItemScores(TEST_ID, { scanLimit: 7 });

    const find = (method: string, column: string) =>
      dbCalls.find((c) => c.method === method && c.args[0] === column)?.args;
    expect(find('eq', 'test_id')).toEqual(['test_id', TEST_ID]);
    expect(find('in', 'run_mode')).toEqual(['run_mode', ['full', 'partial']]);
    expect(find('in', 'status')).toEqual(['status', ['completed', 'completed_with_failures']]);
    expect(find('not', 'report_state')).toEqual(['report_state', 'is', null]);
    expect(find('eq', 'report_state->>status')).toEqual(['report_state->>status', 'completed']);
    expect(dbCalls.find((c) => c.method === 'order')?.args).toEqual([
      'created_at',
      { ascending: false },
    ]);
    expect(dbCalls.find((c) => c.method === 'limit')?.args).toEqual([7]);
  });

  it('returns an empty map for a test with no graded run (every item then qualifies)', async () => {
    const scores = await getLatestItemScores(TEST_ID);
    expect(scores.size).toBe(0);
  });
});
