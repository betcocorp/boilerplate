import { describe, expect, it } from 'vitest';

import {
  buildDenseDaySeries,
  clampDays,
  parseGroupFilter,
  pivotUserDaySeries,
  type UserDayMetricRow,
} from '~/lib/event-logging/analytics-repository';

/* -------------------------------------------------------------------------- *
 * All helpers under test are pure — no Supabase client, no network, no mocks.
 * `NOW` is injected so the dense-day windows are stable regardless of when CI runs.
 * -------------------------------------------------------------------------- */

const NOW = new Date('2026-08-30T18:45:00.000Z');

describe('clampDays', () => {
  it('defaults to 30 when the param is absent', () => {
    expect(clampDays(undefined)).toBe(30);
  });

  it('defaults to 30 for a non-numeric value', () => {
    expect(clampDays('not-a-number')).toBe(30);
    expect(clampDays('')).toBe(30);
  });

  it('clamps below the lower bound to 1', () => {
    expect(clampDays('0')).toBe(1);
    expect(clampDays('-90')).toBe(1);
  });

  it('clamps above the upper bound to 365', () => {
    expect(clampDays('366')).toBe(365);
    expect(clampDays('100000')).toBe(365);
  });

  it('passes an in-range value through', () => {
    expect(clampDays('7')).toBe(7);
    expect(clampDays('365')).toBe(365);
  });
});

describe('parseGroupFilter', () => {
  it('returns an empty list when nothing is supplied', () => {
    expect(parseGroupFilter(undefined)).toEqual([]);
  });

  it('splits a single comma-joined string', () => {
    expect(parseGroupFilter('it-admin,sales')).toEqual(['it-admin', 'sales']);
  });

  it('flattens a repeated search param array', () => {
    expect(parseGroupFilter(['it-admin', 'sales,marketing'])).toEqual([
      'it-admin',
      'sales',
      'marketing',
    ]);
  });

  it('trims whitespace and drops blanks', () => {
    expect(parseGroupFilter(' it-admin , , sales ,')).toEqual([
      'it-admin',
      'sales',
    ]);
  });

  it('dedupes repeated groups, preserving first-seen order', () => {
    expect(parseGroupFilter(['sales,it-admin', 'sales'])).toEqual([
      'sales',
      'it-admin',
    ]);
  });
});

describe('buildDenseDaySeries', () => {
  type LoginRow = { date: string; success: number; failure: number };
  const fill = { success: 0, failure: 0 };

  it('emits exactly one row per day in the window, oldest first', () => {
    const dense = buildDenseDaySeries<LoginRow>([], 5, fill, NOW);
    expect(dense.map((row) => row.date)).toEqual([
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
    ]);
  });

  it('fills gaps while preserving rows that exist', () => {
    const rows: LoginRow[] = [
      { date: '2026-08-28', success: 3, failure: 1 },
      { date: '2026-08-30', success: 9, failure: 0 },
    ];
    expect(buildDenseDaySeries<LoginRow>(rows, 3, fill, NOW)).toEqual([
      { date: '2026-08-28', success: 3, failure: 1 },
      { date: '2026-08-29', success: 0, failure: 0 },
      { date: '2026-08-30', success: 9, failure: 0 },
    ]);
  });

  it('ignores rows that fall outside the window', () => {
    const rows: LoginRow[] = [{ date: '2026-01-01', success: 5, failure: 5 }];
    const dense = buildDenseDaySeries<LoginRow>(rows, 2, fill, NOW);
    expect(dense).toHaveLength(2);
    expect(dense.every((row) => row.success === 0)).toBe(true);
  });

  it('is stable for the same injected now', () => {
    const a = buildDenseDaySeries<LoginRow>([], 30, fill, NOW);
    const b = buildDenseDaySeries<LoginRow>([], 30, fill, NOW);
    expect(a).toEqual(b);
    expect(a).toHaveLength(30);
  });

  it('returns an empty series for a zero or negative day count', () => {
    expect(buildDenseDaySeries<LoginRow>([], 0, fill, NOW)).toEqual([]);
    expect(buildDenseDaySeries<LoginRow>([], -3, fill, NOW)).toEqual([]);
  });
});

describe('pivotUserDaySeries', () => {
  const rows: UserDayMetricRow[] = [
    { date: '2026-08-28', userKey: 'U1', label: 'Alpha Tester', count: 2 },
    { date: '2026-08-30', userKey: 'U1', label: 'Alpha Tester', count: 5 },
    { date: '2026-08-30', userKey: 'U2', label: 'Beta Tester', count: 1 },
  ];

  it('orders users by total volume descending', () => {
    const { users } = pivotUserDaySeries(rows, 3, NOW);
    expect(users).toEqual([
      { userKey: 'U1', label: 'Alpha Tester' },
      { userKey: 'U2', label: 'Beta Tester' },
    ]);
  });

  it('zero-fills missing user-days and keys rows by userKey', () => {
    const { data } = pivotUserDaySeries(rows, 3, NOW);
    expect(data).toEqual([
      { date: '2026-08-28', U1: 2, U2: 0 },
      { date: '2026-08-29', U1: 0, U2: 0 },
      { date: '2026-08-30', U1: 5, U2: 1 },
    ]);
  });

  it('sums duplicate cells for the same user and day', () => {
    const { data } = pivotUserDaySeries(
      [
        { date: '2026-08-30', userKey: 'U1', label: 'Alpha', count: 2 },
        { date: '2026-08-30', userKey: 'U1', label: 'Alpha', count: 3 },
      ],
      1,
      NOW,
    );
    expect(data).toEqual([{ date: '2026-08-30', U1: 5 }]);
  });

  it('falls back to the userKey when no label was recorded', () => {
    const { users } = pivotUserDaySeries(
      [{ date: '2026-08-30', userKey: 'U9', label: '', count: 1 }],
      1,
      NOW,
    );
    expect(users).toEqual([{ userKey: 'U9', label: 'U9' }]);
  });

  it('caps the series at the top 10 users', () => {
    const many: UserDayMetricRow[] = Array.from({ length: 14 }, (_, i) => ({
      date: '2026-08-30',
      userKey: `U${i}`,
      label: `User ${i}`,
      count: i + 1,
    }));
    const { users, data } = pivotUserDaySeries(many, 1, NOW);
    expect(users).toHaveLength(10);
    // Highest count first: U13 (14) down to U4 (5).
    expect(users[0]?.userKey).toBe('U13');
    expect(users.at(-1)?.userKey).toBe('U4');
    expect(Object.keys(data[0] ?? {})).toHaveLength(11); // date + 10 user keys
  });

  it('skips malformed rows without a date or userKey', () => {
    const { users, data } = pivotUserDaySeries(
      [
        { date: '', userKey: 'U1', label: 'Alpha', count: 4 },
        { date: '2026-08-30', userKey: '', label: 'Ghost', count: 9 },
        { date: '2026-08-30', userKey: 'U2', label: 'Beta', count: 1 },
      ],
      1,
      NOW,
    );
    expect(users).toEqual([{ userKey: 'U2', label: 'Beta' }]);
    expect(data).toEqual([{ date: '2026-08-30', U2: 1 }]);
  });

  it('returns no users and dense empty rows for an empty input', () => {
    const { users, data } = pivotUserDaySeries([], 2, NOW);
    expect(users).toEqual([]);
    expect(data).toEqual([{ date: '2026-08-29' }, { date: '2026-08-30' }]);
  });
});
