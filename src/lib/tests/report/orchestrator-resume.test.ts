import { describe, expect, it } from 'vitest';

import type { TestItemRecord } from '~/lib/tests/types';

import {
  finalizeCaseIfReady,
  hydrateLegacyPassScores,
  pendingPasses,
  stripFailedGradingPasses,
} from './orchestrator';
import {
  GRADING_CALL_FAILED_PREFIX,
  emptyReportState,
  type CaseScore,
  type ReportState,
} from './schemas';

/**
 * B0-719 — the resumption unit. `generateReport` itself needs a database and a grading model, so
 * what is pinned here is the part that decides *what still has to be paid for*: which (case, pass)
 * grading calls a resumed report re-runs, and which it must not.
 */

const SCORE: CaseScore = {
  unableToEvaluate: false,
  uteReason: null,
  accuracy: 80,
  completeness: 80,
  relevance: 80,
  clarity: 80,
  explanation: '',
  missed: '',
  incorrect: '',
  improvement: '',
};

function item(id: string): TestItemRecord {
  return { id } as TestItemRecord;
}

const ITEMS = [item('a'), item('b'), item('c')];

function state(passes: number, casePassScores: Record<string, CaseScore[]> = {}): ReportState {
  return { ...emptyReportState('gpt-4.1', ITEMS.length, passes), casePassScores };
}

describe('stripFailedGradingPasses (B0-991)', () => {
  const CALL_FAILED: CaseScore = {
    ...SCORE,
    unableToEvaluate: true,
    uteReason: `${GRADING_CALL_FAILED_PREFIX}: ANTHROPIC_API_KEY is not configured.`,
    accuracy: null,
    completeness: null,
    relevance: null,
    clarity: null,
  };
  const JUDGED_UTE: CaseScore = {
    ...CALL_FAILED,
    uteReason: 'The response is empty.',
  };

  it('drops only call-failure passes, un-consolidates those cases, and re-owes the calls', () => {
    const s = state(3, {
      a: [SCORE, SCORE, SCORE],
      b: [SCORE, CALL_FAILED, CALL_FAILED],
      c: [CALL_FAILED, CALL_FAILED, CALL_FAILED],
    });
    s.caseScores = { a: SCORE, b: SCORE, c: CALL_FAILED };
    s.completedCases = 3;

    expect(stripFailedGradingPasses(s)).toBe(5);
    expect(s.casePassScores).toEqual({ a: [SCORE, SCORE, SCORE], b: [SCORE], c: [] });
    expect(Object.keys(s.caseScores)).toEqual(['a']);
    expect(s.completedCases).toBe(1);
    expect(pendingPasses(ITEMS, s)).toEqual([
      { item: ITEMS[2], passIndex: 0 },
      { item: ITEMS[1], passIndex: 1 },
      { item: ITEMS[2], passIndex: 1 },
      { item: ITEMS[1], passIndex: 2 },
      { item: ITEMS[2], passIndex: 2 },
    ]);
  });

  it('keeps a judged Unable to Evaluate — that is a verdict, not a failed call', () => {
    const s = state(1, { a: [JUDGED_UTE], b: [SCORE], c: [SCORE] });
    s.caseScores = { a: JUDGED_UTE, b: SCORE, c: SCORE };
    s.completedCases = 3;

    expect(stripFailedGradingPasses(s)).toBe(0);
    expect(s.caseScores).toEqual({ a: JUDGED_UTE, b: SCORE, c: SCORE });
    expect(s.completedCases).toBe(3);
  });
});

describe('pendingPasses (B0-719)', () => {
  it('owes one grading call per case at a single pass', () => {
    expect(pendingPasses(ITEMS, state(1))).toEqual([
      { item: ITEMS[0], passIndex: 0 },
      { item: ITEMS[1], passIndex: 0 },
      { item: ITEMS[2], passIndex: 0 },
    ]);
  });

  it('owes cases × passes calls, pass-major, on a fresh multi-pass report', () => {
    const pending = pendingPasses(ITEMS, state(3));
    expect(pending).toHaveLength(9);
    // Pass-major: every case finishes pass 1 before any case starts pass 2.
    expect(pending.slice(0, 3).every((p) => p.passIndex === 0)).toBe(true);
    expect(pending.slice(3, 6).every((p) => p.passIndex === 1)).toBe(true);
  });

  it('re-runs only the incomplete pass after an interruption', () => {
    // Pass 1 finished for every case; pass 2 got as far as case "a" before the crash.
    const interrupted = state(3, {
      a: [SCORE, SCORE],
      b: [SCORE],
      c: [SCORE],
    });

    expect(pendingPasses(ITEMS, interrupted)).toEqual([
      { item: ITEMS[1], passIndex: 1 },
      { item: ITEMS[2], passIndex: 1 },
      { item: ITEMS[0], passIndex: 2 },
      { item: ITEMS[1], passIndex: 2 },
      { item: ITEMS[2], passIndex: 2 },
    ]);
  });

  it('owes nothing once every pass is in', () => {
    const done = state(2, { a: [SCORE, SCORE], b: [SCORE, SCORE], c: [SCORE, SCORE] });
    expect(pendingPasses(ITEMS, done)).toEqual([]);
  });
});

describe('pendingPasses over a scoped item list (B0-1110)', () => {
  it('owes grading calls only for the run-scoped items, never for un-run dataset rows', () => {
    // A partial run over 2 of the 3 dataset items: `generateReport` sizes the state to the scope
    // and hands `pendingPasses` only the resolved items, so the third row is never graded and can
    // never surface as an Unable to Evaluate placeholder.
    const scoped = [ITEMS[0], ITEMS[2]];
    const s: ReportState = { ...emptyReportState('gpt-4.1', scoped.length, 1), casePassScores: {} };

    expect(s.totalCases).toBe(2);
    expect(pendingPasses(scoped, s)).toEqual([
      { item: scoped[0], passIndex: 0 },
      { item: scoped[1], passIndex: 0 },
    ]);
  });
});

describe('hydrateLegacyPassScores (B0-719)', () => {
  it('seeds pass 1 from a report graded before per-pass scores existed', () => {
    const legacy = state(1);
    legacy.caseScores = { a: SCORE, b: SCORE };
    hydrateLegacyPassScores(legacy);

    expect(legacy.casePassScores).toEqual({ a: [SCORE], b: [SCORE] });
    // And so the resume owes only the case that was never scored — not all three again.
    expect(pendingPasses(ITEMS, legacy)).toEqual([{ item: ITEMS[2], passIndex: 0 }]);
  });

  it('leaves a report that already has per-pass scores alone', () => {
    const current = state(2, { a: [SCORE] });
    current.caseScores = { b: SCORE };
    hydrateLegacyPassScores(current);
    expect(current.casePassScores).toEqual({ a: [SCORE] });
  });
});

describe('finalizeCaseIfReady (B0-835 resume gap)', () => {
  it('consolidates a case whose passes are all in but whose consolidation never ran', () => {
    // Every pass landed on a prior call; the crash was in consolidation itself, so
    // `pendingPasses` sees nothing left to score and would otherwise stall here forever.
    const stuck = state(3, { a: [SCORE, SCORE, SCORE] });
    expect(pendingPasses(ITEMS, stuck)).toEqual([
      { item: ITEMS[1], passIndex: 0 },
      { item: ITEMS[2], passIndex: 0 },
      { item: ITEMS[1], passIndex: 1 },
      { item: ITEMS[2], passIndex: 1 },
      { item: ITEMS[1], passIndex: 2 },
      { item: ITEMS[2], passIndex: 2 },
    ]);

    finalizeCaseIfReady('a', stuck);
    expect(stuck.caseScores.a).toBeDefined();
  });

  it('is a no-op for a case still missing a pass', () => {
    const incomplete = state(3, { a: [SCORE, SCORE] });
    finalizeCaseIfReady('a', incomplete);
    expect(incomplete.caseScores.a).toBeUndefined();
  });

  it('is a no-op for a case already consolidated', () => {
    const done = state(3, { a: [SCORE, SCORE, SCORE] });
    done.caseScores = { a: SCORE };
    finalizeCaseIfReady('a', done);
    expect(done.caseScores.a).toBe(SCORE);
  });
});
