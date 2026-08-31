import { describe, expect, it } from 'vitest';

import {
  formatDayLabel,
  formatDayTick,
  formatEventTimestamp,
  formatHourRange,
  formatHourTick,
  normalizeHour,
  truncateEvent,
} from './format';

describe('normalizeHour', () => {
  it('passes valid hours through', () => {
    expect(normalizeHour(0)).toBe(0);
    expect(normalizeHour(23)).toBe(23);
  });

  it('wraps out-of-range hours instead of producing NaN', () => {
    expect(normalizeHour(24)).toBe(0);
    expect(normalizeHour(25)).toBe(1);
    expect(normalizeHour(-1)).toBe(23);
  });

  it('falls back to 0 for non-finite input', () => {
    expect(normalizeHour(Number.NaN)).toBe(0);
    expect(normalizeHour(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('formatHourTick', () => {
  it('renders compact lowercase hour labels', () => {
    expect(formatHourTick(0)).toBe('12am');
    expect(formatHourTick(9)).toBe('9am');
    expect(formatHourTick(12)).toBe('12pm');
    expect(formatHourTick(15)).toBe('3pm');
    expect(formatHourTick(23)).toBe('11pm');
  });
});

describe('formatHourRange', () => {
  it('spans the hour bucket', () => {
    expect(formatHourRange(15)).toBe('3 PM – 4 PM');
    expect(formatHourRange(0)).toBe('12 AM – 1 AM');
  });

  it('wraps midnight at the end of the day', () => {
    expect(formatHourRange(23)).toBe('11 PM – 12 AM');
  });
});

describe('formatDayLabel', () => {
  it('renders a month/day label without timezone drift', () => {
    expect(formatDayLabel('2026-08-30')).toBe('Aug 30');
    expect(formatDayLabel('2026-01-01')).toBe('Jan 1');
    expect(formatDayLabel('2026-12-09')).toBe('Dec 9');
  });

  it('passes through anything that is not a plain day string', () => {
    expect(formatDayLabel('')).toBe('');
    expect(formatDayLabel('not-a-day')).toBe('not-a-day');
    expect(formatDayLabel('2026-13-01')).toBe('2026-13-01');
  });
});

describe('formatDayTick', () => {
  it('trims the year off a day string', () => {
    expect(formatDayTick('2026-08-30')).toBe('08-30');
  });

  it('leaves other values alone', () => {
    expect(formatDayTick('Aug 30')).toBe('Aug 30');
    expect(formatDayTick('')).toBe('');
  });
});

describe('truncateEvent', () => {
  it('leaves short names alone', () => {
    expect(truncateEvent('analytics.page.view')).toBe('analytics.page.view');
  });

  it('ellipsises long names to the requested width', () => {
    const truncated = truncateEvent('a'.repeat(80), 10);
    expect(truncated).toBe(`${'a'.repeat(9)}…`);
    expect(truncated).toHaveLength(10);
  });

  it('does not produce a lone ellipsis at tiny widths', () => {
    expect(truncateEvent('abcdef', 1)).toBe('a');
    expect(truncateEvent('abcdef', 0)).toBe('');
  });
});

describe('formatEventTimestamp', () => {
  it('renders a readable local timestamp', () => {
    const rendered = formatEventTimestamp('2026-08-30T15:04:00.000Z', 'UTC');
    expect(rendered).toContain('Aug 30');
    expect(rendered).toContain('3:04');
    expect(rendered).toContain('PM');
  });

  it('returns the raw value when the timestamp cannot be parsed', () => {
    expect(formatEventTimestamp('nonsense')).toBe('nonsense');
    expect(formatEventTimestamp('')).toBe('');
  });
});
