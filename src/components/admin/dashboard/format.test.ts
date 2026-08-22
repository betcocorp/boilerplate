import { describe, expect, it } from 'vitest';

import {
  EM_DASH,
  formatCount,
  formatDeltaPoints,
  formatMs,
  formatRatePercent,
  formatTokensPerRun,
  formatUsd,
  formatUsdPerRun,
} from './format';

describe('dashboard formatters — a missing measurement is never a zero', () => {
  it('renders null as the em dash, not 0', () => {
    expect(formatMs(null)).toBe(EM_DASH);
    expect(formatCount(null)).toBe(EM_DASH);
    expect(formatRatePercent(null)).toBe(EM_DASH);
    expect(formatUsd(null)).toBe(EM_DASH);
    expect(formatUsdPerRun(null)).toBe(EM_DASH);
    expect(formatDeltaPoints(null)).toBe(EM_DASH);
    expect(formatTokensPerRun(null)).toBe(EM_DASH);
  });

  it('still renders a genuine zero as zero', () => {
    expect(formatMs(0)).toBe('0ms');
    expect(formatCount(0)).toBe('0');
    expect(formatRatePercent(0)).toBe('0.0%');
    expect(formatUsd(0)).toBe('$0.00');
  });
});

describe('formatMs', () => {
  it('switches to seconds at one second', () => {
    expect(formatMs(999)).toBe('999ms');
    expect(formatMs(1000)).toBe('1.00s');
    expect(formatMs(8200)).toBe('8.20s');
  });

  it('rounds sub-second values to whole milliseconds', () => {
    expect(formatMs(116.4)).toBe('116ms');
  });
});

describe('formatRatePercent', () => {
  it('formats a 0..1 rate at one decimal by default', () => {
    expect(formatRatePercent(0.021)).toBe('2.1%');
    expect(formatRatePercent(1)).toBe('100.0%');
  });

  it('honours a custom precision', () => {
    expect(formatRatePercent(0.766, 0)).toBe('77%');
  });
});

describe('currency', () => {
  it('formats window spend at two decimals', () => {
    expect(formatUsd(12.84)).toBe('$12.84');
  });

  it('keeps four decimals per run, where two would round sub-cent spend to zero', () => {
    expect(formatUsdPerRun(0.0078)).toBe('$0.0078');
    expect(formatUsd(0.0078)).toBe('$0.01');
  });
});

describe('formatDeltaPoints', () => {
  it('states direction in words', () => {
    expect(formatDeltaPoints(0.6)).toBe('up 0.6 pts');
    expect(formatDeltaPoints(-0.6)).toBe('down 0.6 pts');
  });

  it('reports no movement as flat rather than "up 0.0 pts"', () => {
    expect(formatDeltaPoints(0)).toBe('flat');
    expect(formatDeltaPoints(0.04)).toBe('flat');
  });
});

describe('formatTokensPerRun', () => {
  it('groups thousands and labels the unit', () => {
    expect(formatTokensPerRun(9246.3)).toBe('9,246 tokens/run');
  });
});
