import { describe, expect, it } from 'vitest';

import {
  completedPassCount,
  emptyReportState,
  parseReportState,
  totalPassCount,
  type CaseScore,
} from './schemas';

/**
 * B0-719 — the persisted `report_state` shape, and specifically its backward compatibility.
 *
 * A parse failure here is not cosmetic: `generateReport` falls back to `emptyReportState` when
 * `parseReportState` returns null, which throws away every already-graded case and re-pays for it.
 * The legacy fixture below is the exact key set live `test_results.report_state` rows carry.
 */

const LEGACY_SCORE = {
  unableToEvaluate: false,
  uteReason: null,
  accuracy: 92,
  completeness: 88,
  relevance: 95,
  clarity: 90,
  explanation: 'Quoted 1:64 (2 oz/gal) exactly as printed.',
  missed: '',
  incorrect: '',
  improvement: '',
} satisfies CaseScore;

/** Exactly the ten keys a `report_state` persisted before B0-719 has — nothing more. */
const LEGACY_STATE = {
  status: 'completed',
  model: 'gpt-4.1',
  totalCases: 2,
  completedCases: 2,
  startedAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:04:00.000Z',
  caseScores: { 'case-a': LEGACY_SCORE, 'case-b': LEGACY_SCORE },
  synthesis: null,
  error: null,
  overall: { avg: 90.5, grade: 'A' },
};

describe('parseReportState — backward compatibility (B0-719)', () => {
  it('parses a legacy row and defaults the multi-pass fields', () => {
    const state = parseReportState(LEGACY_STATE);

    expect(state).not.toBeNull();
    expect(state!.caseScores['case-a']).toEqual(LEGACY_SCORE);
    expect(state!.casePassScores).toEqual({});
    expect(state!.passes).toBe(1);
    expect(state!.spreadThreshold).toBeNull();
  });

  it('parses a row that predates `overall` as well, so both defaults compose', () => {
    const older: Record<string, unknown> = { ...LEGACY_STATE };
    delete older.overall;
    const state = parseReportState(older);

    expect(state).not.toBeNull();
    expect(state!.overall).toBeNull();
    expect(state!.passes).toBe(1);
  });

  it('round-trips a multi-pass row', () => {
    const state = parseReportState({
      ...LEGACY_STATE,
      passes: 3,
      spreadThreshold: 10,
      casePassScores: { 'case-a': [LEGACY_SCORE, LEGACY_SCORE, LEGACY_SCORE] },
    });

    expect(state!.passes).toBe(3);
    expect(state!.spreadThreshold).toBe(10);
    expect(state!.casePassScores['case-a']).toHaveLength(3);
  });

  it('still rejects a genuinely malformed row', () => {
    expect(parseReportState({ status: 'nonsense' })).toBeNull();
    expect(parseReportState(null)).toBeNull();
  });
});

describe('progress counting (B0-719)', () => {
  it('counts (case, pass) units, so a 3-pass bar does not stall at 33%', () => {
    const state = parseReportState({
      ...LEGACY_STATE,
      status: 'scoring',
      completedCases: 0,
      passes: 3,
      casePassScores: { 'case-a': [LEGACY_SCORE, LEGACY_SCORE], 'case-b': [LEGACY_SCORE] },
    })!;

    expect(totalPassCount(state)).toBe(6);
    expect(completedPassCount(state)).toBe(3);
  });

  it('falls back to the case count for a legacy row that has no per-pass scores', () => {
    const state = parseReportState(LEGACY_STATE)!;
    expect(totalPassCount(state)).toBe(2);
    expect(completedPassCount(state)).toBe(2);
  });

  it('starts a fresh state at the configured pass count', () => {
    const state = emptyReportState('gpt-4.1', 12, 3, 10);
    expect(state.passes).toBe(3);
    expect(state.spreadThreshold).toBe(10);
    expect(state.casePassScores).toEqual({});
    expect(totalPassCount(state)).toBe(36);
    expect(completedPassCount(state)).toBe(0);
  });

  it('defaults a fresh state to a single pass', () => {
    const state = emptyReportState('gpt-4.1', 12);
    expect(state.passes).toBe(1);
    expect(state.spreadThreshold).toBeNull();
  });
});
