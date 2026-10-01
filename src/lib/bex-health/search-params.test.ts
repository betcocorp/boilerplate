import { describe, expect, it } from 'vitest';

import { UNVERSIONED_TRAFFIC } from '~/lib/observability/aggregates';

import {
  describeVersionSelection,
  resolveHealthSearchParams,
  toGoldenSetVersionQuery,
  utcDay,
} from './search-params';

const NOW = new Date('2026-08-21T15:30:00.000Z');

describe('resolveHealthSearchParams — window', () => {
  it('defaults to the trailing 7 UTC days when params are absent', () => {
    const { window } = resolveHealthSearchParams({}, NOW);
    expect(utcDay(window.from)).toBe('2026-08-15');
    expect(utcDay(window.to)).toBe('2026-08-21');
    expect(window.from.toISOString()).toBe('2026-08-15T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-08-21T23:59:59.999Z');
  });

  it('invalid day params fall back to defaults, never error', () => {
    const { window } = resolveHealthSearchParams(
      { from: 'not-a-day', to: '2026-13-45' },
      NOW,
    );
    expect(utcDay(window.from)).toBe('2026-08-15');
    expect(utcDay(window.to)).toBe('2026-08-21');
  });

  it('clamps an inverted range to a single day', () => {
    const { window } = resolveHealthSearchParams(
      { from: '2026-08-20', to: '2026-08-01' },
      NOW,
    );
    expect(utcDay(window.from)).toBe('2026-08-20');
    expect(utcDay(window.to)).toBe('2026-08-20');
  });
});

describe('resolveHealthSearchParams — version (B0-578)', () => {
  it('absent or blank version means all traffic (null)', () => {
    expect(resolveHealthSearchParams({}, NOW).version).toBeNull();
    expect(resolveHealthSearchParams({ version: '' }, NOW).version).toBeNull();
    expect(resolveHealthSearchParams({ version: '   ' }, NOW).version).toBeNull();
  });

  it('passes a version string through verbatim', () => {
    expect(resolveHealthSearchParams({ version: '2.1.0' }, NOW).version).toBe('2.1.0');
  });

  it('recognises the unversioned sentinel', () => {
    expect(resolveHealthSearchParams({ version: 'unversioned' }, NOW).version).toBe(
      UNVERSIONED_TRAFFIC,
    );
  });

  it('a repeated param takes the first value', () => {
    expect(resolveHealthSearchParams({ version: ['1.0.0', '2.0.0'] }, NOW).version).toBe('1.0.0');
  });
});

describe('toGoldenSetVersionQuery — the one selection → golden-set mapping', () => {
  it('all traffic omits the version key (any version)', () => {
    expect(toGoldenSetVersionQuery(null)).toEqual({});
    expect('version' in toGoldenSetVersionQuery(null)).toBe(false);
  });

  it('the unversioned sentinel maps to the version-null golden bucket', () => {
    expect(toGoldenSetVersionQuery(UNVERSIONED_TRAFFIC)).toEqual({ version: null });
  });

  it('a concrete version maps to an exact match', () => {
    expect(toGoldenSetVersionQuery('2.1.0')).toEqual({ version: '2.1.0' });
  });
});

describe('describeVersionSelection', () => {
  it('names each selection state in words', () => {
    expect(describeVersionSelection(null)).toBe('All traffic');
    expect(describeVersionSelection(UNVERSIONED_TRAFFIC)).toBe(
      'Unversioned traffic (pre-instrumentation)',
    );
    expect(describeVersionSelection('2.1.0')).toBe('Version 2.1.0');
  });
});
