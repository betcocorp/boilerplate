import { describe, expect, it } from 'vitest';

import type { ReportCase, ReportGroupRate } from '~/lib/tests/report/data-schemas';

import {
  applyBulkDisclosure,
  buildLedgerChips,
  bulkDisclosureAction,
  groupCasesByTier,
  isDefaultOpenCase,
  isExceptionCase,
  ledgerFilterEquals,
  matchesLedgerFilter,
  parseLedgerFilter,
  seedOpenCaseIds,
  serializeLedgerFilter,
} from './ReportCaseLedger';

/**
 * B0-590 — pure grouping/filtering logic only. Testing Library is c360-only per AGENTS.md, so the
 * component itself is exercised by hand; everything worth asserting is a plain function.
 */

const CONCEPTS = {
  mandatory: { required: ['States the ratio'], satisfied: ['States the ratio'], missing: [] },
  expected: { required: ['States the ratio'], satisfied: ['States the ratio'], missing: [] },
  materialIssue: false,
  materialIssueNote: null,
};

function makeCase(overrides: Partial<ReportCase> & Pick<ReportCase, 'id'>): ReportCase {
  const priorityRaw = overrides.priorityRaw ?? 1;
  return {
    anchorId: `case-${overrides.id}`,
    question: 'Q',
    tier: priorityRaw == null ? 'Unspecified' : `Tier ${priorityRaw}`,
    priorityRaw,
    category: 'General',
    idealResponse: null,
    expectedConcepts: [],
    minimumConcepts: [],
    expectedSources: [],
    actual: '(no response recorded)',
    responseRecorded: false,
    score: {
      unableToEvaluate: false,
      uteReason: null,
      accuracy: 90,
      completeness: 90,
      relevance: 90,
      clarity: 90,
      explanation: '',
      missed: '',
      incorrect: '',
      improvement: '',
    },
    unableToEvaluate: false,
    evaluated: {
      id: overrides.id,
      question: 'Q',
      tier: priorityRaw == null ? 'Unspecified' : `Tier ${priorityRaw}`,
      priorityRaw,
      category: 'General',
      accuracy: 90,
      completeness: 90,
      relevance: 90,
      clarity: 90,
      overall: 90,
      grade: 'A',
      status: 'Pass',
      coverage: { satisfied: 1, required: 1 },
      mandatoryMissing: false,
      materialIssue: false,
      passesOnlyUnderCurrentMark: false,
      concepts: CONCEPTS,
    },
    concepts: CONCEPTS,
    latencySeconds: null,
    latencyMs: null,
    ttftSeconds: null,
    ttftMs: null,
    speed: null,
    harness: null,
    retrievedDocumentIds: [],
    workflowRunId: null,
    answerProvenance: null,
    routingDecision: null,
    ...overrides,
  };
}

function uteCase(id: string, priorityRaw: number | null, reason: string): ReportCase {
  const base = makeCase({ id, priorityRaw });
  return {
    ...base,
    score: { ...base.score, unableToEvaluate: true, uteReason: reason },
    unableToEvaluate: true,
    evaluated: null,
  };
}

function block(n: number, avg: number | null, grade: ReportGroupRate['block']['grade']) {
  return { n, avg, grade, pass: n, fail: 0, passPct: 100, failPct: 0 };
}

describe('parseLedgerFilter / serializeLedgerFilter', () => {
  const tiers = ['Tier 1', 'Tier 2', 'Unspecified'];

  it('defaults to "all" for missing, empty and unknown values', () => {
    expect(parseLedgerFilter(null, tiers)).toEqual({ kind: 'all' });
    expect(parseLedgerFilter(undefined, tiers)).toEqual({ kind: 'all' });
    expect(parseLedgerFilter('', tiers)).toEqual({ kind: 'all' });
    expect(parseLedgerFilter('all', tiers)).toEqual({ kind: 'all' });
    expect(parseLedgerFilter('nonsense', tiers)).toEqual({ kind: 'all' });
  });

  it('parses the exceptions and tier filters', () => {
    expect(parseLedgerFilter('exceptions', tiers)).toEqual({ kind: 'exceptions' });
    expect(parseLedgerFilter('tier:Tier 2', tiers)).toEqual({ kind: 'tier', tier: 'Tier 2' });
    expect(parseLedgerFilter('tier:Unspecified', tiers)).toEqual({
      kind: 'tier',
      tier: 'Unspecified',
    });
  });

  it('falls back to "all" for a tier the run does not have', () => {
    expect(parseLedgerFilter('tier:Tier 9', tiers)).toEqual({ kind: 'all' });
  });

  it('round-trips through the query param, dropping it entirely for "all"', () => {
    expect(serializeLedgerFilter({ kind: 'all' })).toBeNull();
    expect(serializeLedgerFilter({ kind: 'exceptions' })).toBe('exceptions');
    expect(serializeLedgerFilter({ kind: 'tier', tier: 'Tier 1' })).toBe('tier:Tier 1');
    expect(parseLedgerFilter(serializeLedgerFilter({ kind: 'tier', tier: 'Tier 1' }), tiers)).toEqual(
      { kind: 'tier', tier: 'Tier 1' },
    );
  });

  it('compares filters by kind and tier', () => {
    expect(ledgerFilterEquals({ kind: 'all' }, { kind: 'all' })).toBe(true);
    expect(ledgerFilterEquals({ kind: 'all' }, { kind: 'exceptions' })).toBe(false);
    expect(
      ledgerFilterEquals({ kind: 'tier', tier: 'Tier 1' }, { kind: 'tier', tier: 'Tier 1' }),
    ).toBe(true);
    expect(
      ledgerFilterEquals({ kind: 'tier', tier: 'Tier 1' }, { kind: 'tier', tier: 'Tier 2' }),
    ).toBe(false);
  });
});

describe('isExceptionCase / isDefaultOpenCase', () => {
  const pass = makeCase({ id: 'p' });
  const fail = makeCase({
    id: 'f',
    evaluated: { ...makeCase({ id: 'f' }).evaluated!, overall: 40, grade: 'F', status: 'Fail' },
  });
  // A D that passes under the mark is a pass, not an exception — even with a must-have missing.
  const marginal = makeCase({
    id: 'x',
    evaluated: {
      ...makeCase({ id: 'x' }).evaluated!,
      overall: 65,
      grade: 'D',
      status: 'Pass',
      mandatoryMissing: true,
      passesOnlyUnderCurrentMark: true,
    },
  });
  const ute = uteCase('u', 1, 'no golden answer recorded');

  it('counts fails as exceptions, never a pass, a marginal pass or a UTE case', () => {
    expect(isExceptionCase(fail)).toBe(true);
    expect(isExceptionCase(marginal)).toBe(false);
    expect(isExceptionCase(pass)).toBe(false);
    expect(isExceptionCase(ute)).toBe(false);
  });

  it('opens exceptions and UTE cases by default, but not passes', () => {
    expect(isDefaultOpenCase(fail)).toBe(true);
    expect(isDefaultOpenCase(marginal)).toBe(false);
    expect(isDefaultOpenCase(ute)).toBe(true);
    expect(isDefaultOpenCase(pass)).toBe(false);
  });
});

describe('seedOpenCaseIds', () => {
  const pass = makeCase({ id: 'p' });
  const fail = makeCase({
    id: 'f',
    evaluated: { ...makeCase({ id: 'f' }).evaluated!, overall: 10, grade: 'F', status: 'Fail' },
  });
  const cases = [pass, fail];

  it('derives the first-paint open set from the data alone', () => {
    expect([...seedOpenCaseIds(cases, null)]).toEqual(['f']);
  });

  it('also opens an incoming #case-… deep-link target', () => {
    expect([...seedOpenCaseIds(cases, 'case-p')].sort()).toEqual(['f', 'p']);
  });

  it('ignores a hash that matches no case', () => {
    expect([...seedOpenCaseIds(cases, 'case-nothing')]).toEqual(['f']);
  });
});

describe('groupCasesByTier', () => {
  const cases = [
    makeCase({ id: 'a', priorityRaw: 1 }),
    makeCase({ id: 'b', priorityRaw: 1 }),
    uteCase('c', 1, 'response empty'),
    makeCase({ id: 'd', priorityRaw: 2 }),
    { ...makeCase({ id: 'e', priorityRaw: null }), tier: 'Unspecified' },
  ];
  const tiers: ReportGroupRate[] = [
    { name: 'Tier 1', block: block(2, 88.5, 'B') },
    { name: 'Tier 2', block: block(1, 91, 'A') },
    { name: 'Unspecified', block: block(1, 62.4, 'D') },
  ];

  it('preserves payload order for groups and rows, without re-sorting', () => {
    const groups = groupCasesByTier(cases, tiers);
    expect(groups.map((g) => g.tier)).toEqual(['Tier 1', 'Tier 2', 'Unspecified']);
    expect(groups[0]!.cases.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('reads each header block from metrics rather than averaging the rows', () => {
    const groups = groupCasesByTier(cases, tiers);
    expect(groups[0]!.block).toEqual(block(2, 88.5, 'B'));
    // 3 rows in the group, but the metrics n is 2 — the UTE row is excluded from the average.
    expect(groups[0]!.cases).toHaveLength(3);
    expect(groups[0]!.block!.n).toBe(2);
    expect(groups[0]!.uteCount).toBe(1);
  });

  it('carries the group priority and tolerates a tier with no metrics row', () => {
    const groups = groupCasesByTier(cases, []);
    expect(groups[0]!.priorityRaw).toBe(1);
    expect(groups[2]!.priorityRaw).toBeNull();
    expect(groups.every((g) => g.block === null)).toBe(true);
  });
});

describe('matchesLedgerFilter / buildLedgerChips', () => {
  const pass = makeCase({ id: 'a', priorityRaw: 1 });
  const fail = {
    ...makeCase({ id: 'b', priorityRaw: 1 }),
    evaluated: { ...makeCase({ id: 'b' }).evaluated!, overall: 12, grade: 'F' as const, status: 'Fail' as const },
  };
  const tier2 = makeCase({ id: 'c', priorityRaw: 2 });
  const ute = uteCase('d', 2, 'unscored');
  const cases = [pass, fail, tier2, ute];

  it('filters by all / exceptions / tier', () => {
    expect(cases.filter((c) => matchesLedgerFilter(c, { kind: 'all' }))).toHaveLength(4);
    expect(
      cases.filter((c) => matchesLedgerFilter(c, { kind: 'exceptions' })).map((c) => c.id),
    ).toEqual(['b']);
    expect(
      cases.filter((c) => matchesLedgerFilter(c, { kind: 'tier', tier: 'Tier 2' })).map((c) => c.id),
    ).toEqual(['c', 'd']);
  });

  it('builds All / Exceptions / per-tier chips whose counts are row counts', () => {
    const chips = buildLedgerChips(cases, groupCasesByTier(cases, []));
    expect(chips.map((c) => [c.label, c.count])).toEqual([
      ['All', 4],
      ['Exceptions', 1],
      ['Tier 1', 2],
      // Includes the UTE row: chips count visible rows, not the metrics denominator.
      ['Tier 2', 2],
    ]);
    expect(chips[3]!.filter).toEqual({ kind: 'tier', tier: 'Tier 2' });
  });
});

describe('bulkDisclosureAction / applyBulkDisclosure', () => {
  const visible = ['a', 'b', 'c'];

  it('offers collapse while any visible row is open, expand once none are', () => {
    expect(bulkDisclosureAction(new Set(['b']), visible)).toBe('collapse');
    expect(bulkDisclosureAction(new Set(visible), visible)).toBe('collapse');
    expect(bulkDisclosureAction(new Set(), visible)).toBe('expand');
    // An open row hidden by the filter must not make the button offer "collapse".
    expect(bulkDisclosureAction(new Set(['hidden']), visible)).toBe('expand');
  });

  it('opens or closes every visible row in one step', () => {
    expect([...applyBulkDisclosure(new Set(['a']), visible, 'expand')].sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect([...applyBulkDisclosure(new Set(visible), visible, 'collapse')]).toEqual([]);
  });

  it('leaves rows the filter hides untouched in both directions', () => {
    expect([...applyBulkDisclosure(new Set(['hidden']), visible, 'collapse')]).toEqual(['hidden']);
    expect([...applyBulkDisclosure(new Set(['hidden']), visible, 'expand')].sort()).toEqual([
      'a',
      'b',
      'c',
      'hidden',
    ]);
  });

  it('round-trips: collapse then expand restores every visible row', () => {
    const open = new Set(['a', 'b', 'c', 'hidden']);
    const collapsed = applyBulkDisclosure(open, visible, 'collapse');
    expect(bulkDisclosureAction(collapsed, visible)).toBe('expand');
    expect([...applyBulkDisclosure(collapsed, visible, 'expand')].sort()).toEqual([
      'a',
      'b',
      'c',
      'hidden',
    ]);
  });
});

