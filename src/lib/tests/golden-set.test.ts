import { describe, expect, it } from 'vitest';

import {
  computeGoldenSetItemOrigins,
  computeGoldenSetMembership,
  computeGoldenSetRollup,
  readDerivedFromTestId,
  resolveGoldenRunsForVersion,
  type GoldenItemRow,
  type GoldenResultItemRow,
  type GoldenRunRow,
  type GoldenTestRow,
} from './golden-set';
import { verdictForTier } from './tier-targets';

const goldenTest = (id: string, name = `Test ${id}`): GoldenTestRow => ({
  id,
  name,
  row_count: 0,
});

const item = (
  id: string,
  testId: string,
  priority: number | null,
  rowIndex = 1,
): GoldenItemRow => ({
  id,
  test_id: testId,
  row_index: rowIndex,
  prompt: `prompt ${id}`,
  priority,
});

const run = (
  id: string,
  testId: string,
  appVersion: string | null,
  createdAt: string,
): GoldenRunRow => ({
  id,
  test_id: testId,
  app_version: appVersion,
  created_at: createdAt,
});

const resultRow = (
  runId: string,
  itemId: string,
  passed: boolean,
  appVersion: string | null = '2.0.0',
): GoldenResultItemRow => ({
  test_result_id: runId,
  test_item_id: itemId,
  passed,
  app_version: appVersion,
});

describe('computeGoldenSetRollup', () => {
  it('returns no_golden_sets when nothing is marked golden', () => {
    const rollup = computeGoldenSetRollup({
      tests: [],
      items: [],
      runs: [],
      resultItems: [],
      query: {},
    });
    expect(rollup).toEqual({ kind: 'no_golden_sets' });
  });

  it('reports untiered golden items as data errors, never silently excluded', () => {
    const tests = [goldenTest('t1', 'Golden A')];
    const items = [
      item('i1', 't1', 1),
      item('i2', 't1', null, 2), // the data error
      item('i3', 't1', 2, 3),
    ];
    const runs = [run('r1', 't1', '2.0.0', '2026-08-20T10:00:00Z')];
    const resultItems = [
      resultRow('r1', 'i1', true),
      resultRow('r1', 'i2', true), // graded row on the untiered item
      resultRow('r1', 'i3', false),
    ];

    const rollup = computeGoldenSetRollup({
      tests,
      items,
      runs,
      resultItems,
      query: { version: '2.0.0' },
    });

    expect(rollup.kind).toBe('rollup');
    if (rollup.kind !== 'rollup') return;

    expect(rollup.membership.missingPriority).toHaveLength(1);
    expect(rollup.membership.missingPriority[0]).toMatchObject({
      testId: 't1',
      testName: 'Golden A',
      testItemId: 'i2',
      rowIndex: 2,
    });
    // Untiered item is still part of the membership total…
    expect(rollup.membership.totalItems).toBe(3);
    // …its graded row is surfaced separately, never folded into a tier.
    expect(rollup.resultRowsOnMissingPriorityItems).toBe(1);
    const tier1 = rollup.tiers.find((t) => t.tier === 1)!;
    const tier2 = rollup.tiers.find((t) => t.tier === 2)!;
    expect(tier1.gradedCount + tier2.gradedCount).toBe(2);
  });

  it('computes per-tier item counts and pass rates', () => {
    const tests = [goldenTest('t1')];
    const items = [
      item('i1', 't1', 1, 1),
      item('i2', 't1', 1, 2),
      item('i3', 't1', 2, 3),
      item('i4', 't1', 3, 4),
    ];
    const runs = [run('r1', 't1', '2.0.0', '2026-08-20T10:00:00Z')];
    const resultItems = [
      resultRow('r1', 'i1', true),
      resultRow('r1', 'i2', false),
      resultRow('r1', 'i3', true),
      resultRow('r1', 'i4', false),
    ];

    const rollup = computeGoldenSetRollup({
      tests,
      items,
      runs,
      resultItems,
      query: { version: '2.0.0' },
    });

    expect(rollup.kind).toBe('rollup');
    if (rollup.kind !== 'rollup') return;

    expect(rollup.membership.itemCountByTier).toEqual({ 1: 2, 2: 1, 3: 1 });
    const [tier1, tier2, tier3] = [1, 2, 3].map(
      (tier) => rollup.tiers.find((t) => t.tier === tier)!,
    );
    expect(tier1).toMatchObject({ itemCount: 2, gradedCount: 2, passedCount: 1, passRate: 0.5 });
    expect(tier2).toMatchObject({ itemCount: 1, gradedCount: 1, passedCount: 1, passRate: 1 });
    expect(tier3).toMatchObject({ itemCount: 1, gradedCount: 1, passedCount: 0, passRate: 0 });
  });

  it('a tier with no graded rows has passRate null, not 0%', () => {
    const tests = [goldenTest('t1')];
    const items = [item('i1', 't1', 1), item('i2', 't1', 3, 2)];
    const runs = [run('r1', 't1', '2.0.0', '2026-08-20T10:00:00Z')];
    const resultItems = [resultRow('r1', 'i1', true)]; // tier 3 item never graded

    const rollup = computeGoldenSetRollup({
      tests,
      items,
      runs,
      resultItems,
      query: {},
    });

    expect(rollup.kind).toBe('rollup');
    if (rollup.kind !== 'rollup') return;
    expect(rollup.tiers.find((t) => t.tier === 3)!.passRate).toBeNull();
  });

  it('returns no_golden_run_for_version instead of 0% or another version', () => {
    const tests = [goldenTest('t1')];
    const items = [item('i1', 't1', 1)];
    const runs = [run('r1', 't1', '1.9.0', '2026-08-20T10:00:00Z')];
    const resultItems = [resultRow('r1', 'i1', false, '1.9.0')];

    const rollup = computeGoldenSetRollup({
      tests,
      items,
      runs,
      resultItems,
      query: { version: '2.0.0' },
    });

    expect(rollup).toMatchObject({
      kind: 'no_golden_run_for_version',
      version: '2.0.0',
    });
  });

  it('version null selects only unversioned runs; unattributed rows are counted', () => {
    const tests = [goldenTest('t1')];
    const items = [item('i1', 't1', 1)];
    const runs = [
      run('r-old', 't1', null, '2026-08-01T10:00:00Z'),
      run('r-new', 't1', '2.0.0', '2026-08-20T10:00:00Z'),
    ];
    const resultItems = [
      resultRow('r-old', 'i1', true, null),
      resultRow('r-new', 'i1', false, '2.0.0'),
    ];

    const rollup = computeGoldenSetRollup({
      tests,
      items,
      runs,
      resultItems,
      query: { version: null },
    });

    expect(rollup.kind).toBe('rollup');
    if (rollup.kind !== 'rollup') return;
    expect(rollup.resolvedRuns).toEqual([
      { testId: 't1', runId: 'r-old', appVersion: null, createdAt: '2026-08-01T10:00:00Z' },
    ]);
    const tier1 = rollup.tiers.find((t) => t.tier === 1)!;
    expect(tier1).toMatchObject({ gradedCount: 1, passedCount: 1, passRate: 1 });
    expect(rollup.unattributedResultItemCount).toBe(1);
  });
});

describe('resolveGoldenRunsForVersion', () => {
  it('picks the most recent completed run per golden test at the version', () => {
    const runs = [
      run('r1', 't1', '2.0.0', '2026-08-18T10:00:00Z'),
      run('r2', 't1', '2.0.0', '2026-08-20T10:00:00Z'),
      run('r3', 't1', '1.9.0', '2026-08-21T10:00:00Z'), // newer but wrong version
      run('r4', 't2', '2.0.0', '2026-08-19T10:00:00Z'),
    ];
    const resolved = resolveGoldenRunsForVersion(runs, '2.0.0');
    expect(resolved.get('t1')?.id).toBe('r2');
    expect(resolved.get('t2')?.id).toBe('r4');
  });

  it('omitted version resolves the latest run regardless of version', () => {
    const runs = [
      run('r1', 't1', '2.0.0', '2026-08-18T10:00:00Z'),
      run('r2', 't1', null, '2026-08-20T10:00:00Z'),
    ];
    const resolved = resolveGoldenRunsForVersion(runs, undefined);
    expect(resolved.get('t1')?.id).toBe('r2');
  });
});

describe('computeGoldenSetMembership', () => {
  it('counts items per tier across multiple golden tests', () => {
    const tests = [goldenTest('t1'), goldenTest('t2')];
    const items = [
      item('i1', 't1', 1),
      item('i2', 't1', 2, 2),
      item('i3', 't2', 1),
      item('i4', 't2', null, 2),
    ];
    const membership = computeGoldenSetMembership(tests, items);
    expect(membership.itemCountByTier).toEqual({ 1: 2, 2: 1, 3: 0 });
    expect(membership.totalItems).toBe(4);
    expect(membership.missingPriority.map((entry) => entry.testItemId)).toEqual(['i4']);
  });
});

describe('computeGoldenSetItemOrigins (B0-750)', () => {
  const golden = [goldenTest('g1', 'Golden A'), goldenTest('g2', 'Golden B')];
  const goldenItems: GoldenItemRow[] = [
    { id: 'gi1', test_id: 'g1', row_index: 1, prompt: 'How do I dilute pH7Q?', priority: 1 },
    { id: 'gi2', test_id: 'g2', row_index: 1, prompt: 'What is the contact time?', priority: 2 },
  ];
  const candidate = (id: string, prompt: string, metadata: unknown) => ({ id, prompt, metadata });

  it('flags an item whose lineage points at a golden test (lineage only)', () => {
    const origins = computeGoldenSetItemOrigins(
      [candidate('c1', 'Some unrelated prompt', { derived_from_test_id: 'g1' })],
      golden,
      goldenItems,
    );
    expect(origins.get('c1')).toEqual({
      goldenTests: [{ id: 'g1', name: 'Golden A' }],
      rules: ['lineage'],
    });
  });

  it('flags an item by prompt when its lineage points at a non-golden (archived) test', () => {
    const origins = computeGoldenSetItemOrigins(
      [candidate('c1', 'How do I dilute pH7Q?', { derived_from_test_id: 'archived-not-golden' })],
      golden,
      goldenItems,
    );
    expect(origins.get('c1')).toEqual({
      goldenTests: [{ id: 'g1', name: 'Golden A' }],
      rules: ['prompt'],
    });
  });

  it('reports both rules, lineage first, and dedupes the golden test when both hit the same one', () => {
    const origins = computeGoldenSetItemOrigins(
      [candidate('c1', 'How do I dilute pH7Q?', { derived_from_test_id: 'g1' })],
      golden,
      goldenItems,
    );
    expect(origins.get('c1')).toEqual({
      goldenTests: [{ id: 'g1', name: 'Golden A' }],
      rules: ['lineage', 'prompt'],
    });
  });

  it('lists every matched golden test in goldenTests order when rules hit different tests', () => {
    const origins = computeGoldenSetItemOrigins(
      [candidate('c1', 'What is the contact time?', { derived_from_test_id: 'g1' })],
      golden,
      goldenItems,
    );
    expect(origins.get('c1')).toEqual({
      goldenTests: [
        { id: 'g1', name: 'Golden A' },
        { id: 'g2', name: 'Golden B' },
      ],
      rules: ['lineage', 'prompt'],
    });
  });

  it('omits items that match neither rule', () => {
    const origins = computeGoldenSetItemOrigins(
      [
        candidate('c1', 'Nothing golden here', { derived_from_test_id: 'not-golden' }),
        candidate('c2', 'Uploaded row', {}),
      ],
      golden,
      goldenItems,
    );
    expect(origins.size).toBe(0);
    expect(origins.has('c1')).toBe(false);
  });

  it('never throws on odd metadata shapes and treats them as no lineage', () => {
    const origins = computeGoldenSetItemOrigins(
      [
        candidate('null', 'x', null),
        candidate('string', 'x', 'g1'),
        candidate('array', 'x', ['g1']),
        candidate('no-key', 'x', { other: 'g1' }),
        candidate('empty-id', 'x', { derived_from_test_id: '' }),
        candidate('non-string-id', 'x', { derived_from_test_id: 42 }),
      ],
      golden,
      goldenItems,
    );
    expect(origins.size).toBe(0);
  });

  it('matches prompts after trimming and case-folding', () => {
    const origins = computeGoldenSetItemOrigins(
      [candidate('c1', '  HOW do i DILUTE ph7q?  \n', null)],
      golden,
      goldenItems,
    );
    expect(origins.get('c1')?.rules).toEqual(['prompt']);
  });

  it('returns an empty map when there are no golden tests', () => {
    const origins = computeGoldenSetItemOrigins(
      [candidate('c1', 'How do I dilute pH7Q?', { derived_from_test_id: 'g1' })],
      [],
      goldenItems,
    );
    expect(origins.size).toBe(0);
  });

  it('ignores golden items whose test_id is not in goldenTests (stale rows)', () => {
    const origins = computeGoldenSetItemOrigins(
      [candidate('c1', 'orphan prompt', null)],
      golden,
      [{ id: 'gx', test_id: 'not-golden', row_index: 1, prompt: 'orphan prompt', priority: 1 }],
    );
    expect(origins.size).toBe(0);
  });
});

describe('readDerivedFromTestId (B0-750)', () => {
  it('reads a non-empty string id', () => {
    expect(readDerivedFromTestId({ derived_from_test_id: 'abc' })).toBe('abc');
  });

  it('returns null for null, strings, arrays, missing keys, empty and non-string ids', () => {
    expect(readDerivedFromTestId(null)).toBeNull();
    expect(readDerivedFromTestId(undefined)).toBeNull();
    expect(readDerivedFromTestId('abc')).toBeNull();
    expect(readDerivedFromTestId(['abc'])).toBeNull();
    expect(readDerivedFromTestId({})).toBeNull();
    expect(readDerivedFromTestId({ derived_from_test_item_id: 'abc' })).toBeNull();
    expect(readDerivedFromTestId({ derived_from_test_id: '' })).toBeNull();
    expect(readDerivedFromTestId({ derived_from_test_id: 7 })).toBeNull();
  });
});

describe('verdictForTier (B0-573)', () => {
  it('a non-gating tier can never be blocked', () => {
    expect(verdictForTier({ targetPassRate: 0.8, isGate: false }, 0)).toBe('miss');
    expect(verdictForTier({ targetPassRate: 0.8, isGate: false }, 0.79)).toBe('miss');
    expect(verdictForTier({ targetPassRate: 1, isGate: false }, 0.5)).toBe('miss');
  });

  it('a gating tier below target is blocked; at/above target passes', () => {
    expect(verdictForTier({ targetPassRate: 1, isGate: true }, 0.99)).toBe('blocked');
    expect(verdictForTier({ targetPassRate: 1, isGate: true }, 1)).toBe('pass');
    expect(verdictForTier({ targetPassRate: 0.8, isGate: false }, 0.8)).toBe('pass');
  });

  it('no graded rows is no_data, not a 0% verdict', () => {
    expect(verdictForTier({ targetPassRate: 1, isGate: true }, null)).toBe('no_data');
  });
});
