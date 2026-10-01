import { describe, expect, it } from 'vitest';

import {
  IMPLAUSIBLE_SECONDS,
  P90_MIN_N,
  P90_UNAVAILABLE_LABEL,
  SPEED_ANCHOR_SCORES,
  SPEED_METRICS,
  SPEED_RATING_BANDS,
  SPEED_THRESHOLDS,
  SPEED_WEIGHTS,
  combineSpeedScores,
  formatP90,
  implausibleSecondsWarning,
  metricBand,
  metricBandAgreesWithScore,
  normalizeSpeed,
  percentile90,
  repairSpeedThresholds,
  speedRating,
  type SpeedMetric,
} from './speed-rules';

describe('normalizeSpeed', () => {
  it('scores the ttft curve exactly at every anchor', () => {
    expect(normalizeSpeed(0, 'ttft')).toBe(100);
    expect(normalizeSpeed(2, 'ttft')).toBe(90);
    expect(normalizeSpeed(5, 'ttft')).toBe(70);
    expect(normalizeSpeed(10, 'ttft')).toBe(40);
    expect(normalizeSpeed(20, 'ttft')).toBe(0);
  });

  it('scores the total curve exactly at every anchor', () => {
    expect(normalizeSpeed(0, 'total')).toBe(100);
    expect(normalizeSpeed(5, 'total')).toBe(90);
    expect(normalizeSpeed(10, 'total')).toBe(70);
    expect(normalizeSpeed(20, 'total')).toBe(40);
    expect(normalizeSpeed(40, 'total')).toBe(0);
  });

  it('interpolates linearly between anchors', () => {
    // Halfway between the 2 s (90) and 5 s (70) ttft anchors.
    expect(normalizeSpeed(3.5, 'ttft')).toBe(80);
    // Halfway between the 5 s (70) and 10 s (40) ttft anchors.
    expect(normalizeSpeed(7.5, 'ttft')).toBe(55);
    // Halfway between the 10 s (40) and 20 s (0) ttft anchors.
    expect(normalizeSpeed(15, 'ttft')).toBe(20);
    // Quarter of the way from 0 s (100) to 2 s (90).
    expect(normalizeSpeed(0.5, 'ttft')).toBe(97.5);
    // Halfway between the 10 s (70) and 20 s (40) total anchors.
    expect(normalizeSpeed(15, 'total')).toBe(55);
  });

  it('clamps beyond the floor and below zero rather than extrapolating', () => {
    expect(normalizeSpeed(20.1, 'ttft')).toBe(0);
    expect(normalizeSpeed(1000, 'ttft')).toBe(0);
    expect(normalizeSpeed(40, 'total')).toBe(0);
    expect(normalizeSpeed(10_000, 'total')).toBe(0);
    // A negative measurement is clock skew, not a score above 100.
    expect(normalizeSpeed(-3, 'ttft')).toBe(100);
  });

  it('is monotonically non-increasing across the whole ttft curve', () => {
    let previous = Infinity;
    for (let s = 0; s <= 25; s += 0.25) {
      const score = normalizeSpeed(s, 'ttft');
      expect(score).toBeLessThanOrEqual(previous + 1e-9);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      previous = score;
    }
  });

  it('scores a non-finite measurement at the floor rather than NaN', () => {
    expect(normalizeSpeed(Number.NaN, 'ttft')).toBe(0);
  });
});

describe('metricBand', () => {
  it('places each ttft anchor in the expected band, inclusive at the edges', () => {
    expect(metricBand(0, 'ttft')).toBe('good');
    expect(metricBand(2, 'ttft')).toBe('good');
    expect(metricBand(2.01, 'ttft')).toBe('acceptable');
    expect(metricBand(5, 'ttft')).toBe('acceptable');
    expect(metricBand(5.01, 'ttft')).toBe('slow');
    expect(metricBand(10, 'ttft')).toBe('slow');
    expect(metricBand(999, 'ttft')).toBe('slow');
  });

  it('places each total anchor in the expected band', () => {
    expect(metricBand(5, 'total')).toBe('good');
    expect(metricBand(7, 'total')).toBe('acceptable');
    expect(metricBand(10, 'total')).toBe('acceptable');
    expect(metricBand(10.5, 'total')).toBe('slow');
  });
});

describe('band/score agreement', () => {
  // The property the shared-anchor design exists to guarantee: a case's band and its score can
  // never tell the reader different stories.
  it.each(SPEED_METRICS as SpeedMetric[])('never disagrees for %s', (metric) => {
    const { floor } = SPEED_THRESHOLDS[metric];
    for (let s = 0; s <= floor + 5; s += 0.05) {
      const seconds = Math.round(s * 100) / 100;
      const score = normalizeSpeed(seconds, metric);
      const band = metricBand(seconds, metric);
      expect(
        metricBandAgreesWithScore(band, score),
        `${metric} @ ${seconds}s: band=${band} score=${score}`,
      ).toBe(true);
    }
  });

  it('ties the band edges to the anchor scores', () => {
    for (const metric of SPEED_METRICS) {
      const t = SPEED_THRESHOLDS[metric];
      expect(normalizeSpeed(t.good, metric)).toBe(SPEED_ANCHOR_SCORES.good);
      expect(normalizeSpeed(t.acceptable, metric)).toBe(SPEED_ANCHOR_SCORES.acceptable);
    }
  });
});

describe('speedRating', () => {
  it('labels each band boundary and its interior', () => {
    expect(speedRating(100)).toBe('Excellent');
    expect(speedRating(90)).toBe('Excellent');
    expect(speedRating(89.9)).toBe('Good');
    expect(speedRating(75)).toBe('Good');
    expect(speedRating(74.9)).toBe('Acceptable');
    expect(speedRating(60)).toBe('Acceptable');
    expect(speedRating(59.9)).toBe('Slow');
    expect(speedRating(40)).toBe('Slow');
    expect(speedRating(39.9)).toBe('Very slow');
    expect(speedRating(0)).toBe('Very slow');
  });

  it('uses word labels that can never be confused with the A-F content grades', () => {
    for (const band of SPEED_RATING_BANDS) {
      expect(band.rating).not.toMatch(/^[A-F]$/);
      expect(band.rating.length).toBeGreaterThan(1);
    }
  });
});

describe('combineSpeedScores', () => {
  it('weights ttft 0.60 and total 0.40 when both are present', () => {
    expect(SPEED_WEIGHTS.ttft).toBe(0.6);
    expect(SPEED_WEIGHTS.total).toBe(0.4);

    // ttft 2 s -> 90, total 10 s -> 70. 0.6*90 + 0.4*70 = 82.
    const result = combineSpeedScores({ ttftSeconds: 2, totalSeconds: 10 });
    expect(result.score).toBeCloseTo(82, 10);
    expect(result.rating).toBe('Good');
    expect(result.metrics.map((m) => m.metric)).toEqual(['ttft', 'total']);
    expect(result.metrics.map((m) => m.weight)).toEqual([0.6, 0.4]);
    expect(result.warnings).toEqual([]);
  });

  it('renormalizes to 1.0 when only ttft was measured, without imputing total', () => {
    const result = combineSpeedScores({ ttftSeconds: 5, totalSeconds: null });
    expect(result.score).toBe(70);
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0].metric).toBe('ttft');
    expect(result.metrics[0].weight).toBe(1);
  });

  it('renormalizes to 1.0 when only total was measured', () => {
    const result = combineSpeedScores({ ttftSeconds: null, totalSeconds: 20 });
    expect(result.score).toBe(40);
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0].metric).toBe('total');
    expect(result.metrics[0].weight).toBe(1);
  });

  it('never zero-fills or averages in a missing metric', () => {
    const onlyTtft = combineSpeedScores({ ttftSeconds: 2, totalSeconds: null });
    const zeroFilled = combineSpeedScores({ ttftSeconds: 2, totalSeconds: 40 });
    // Zero-filling total would drag a perfect-TTFT run down to 54; renormalizing keeps it at 90.
    expect(onlyTtft.score).toBe(90);
    expect(zeroFilled.score).toBeCloseTo(54, 10);
  });

  it('returns a null score, not a zero, when nothing was measured', () => {
    const result = combineSpeedScores({ ttftSeconds: null, totalSeconds: null });
    expect(result.score).toBeNull();
    expect(result.rating).toBeNull();
    expect(result.metrics).toEqual([]);
  });

  it('treats a non-finite measurement as absent rather than scoring it', () => {
    const result = combineSpeedScores({ ttftSeconds: Number.NaN, totalSeconds: 5 });
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0].metric).toBe('total');
    expect(result.score).toBe(90);
  });

  it('carries the implausible-seconds advisory through', () => {
    const result = combineSpeedScores({ ttftSeconds: 1200, totalSeconds: 5 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('millisecond');
    // The value is still scored as given — the module never rewrites a measurement.
    expect(result.metrics[0].seconds).toBe(1200);
    expect(result.metrics[0].score).toBe(0);
  });
});

describe('implausibleSecondsWarning', () => {
  it('stays silent at and below the ceiling', () => {
    expect(implausibleSecondsWarning(IMPLAUSIBLE_SECONDS.ttft, 'ttft')).toBeNull();
    expect(implausibleSecondsWarning(IMPLAUSIBLE_SECONDS.total, 'total')).toBeNull();
    expect(implausibleSecondsWarning(19, 'ttft')).toBeNull();
  });

  it('names the millisecond mix-up above the ttft ceiling', () => {
    const warning = implausibleSecondsWarning(1500, 'ttft');
    expect(warning).toContain('TTFT');
    expect(warning).toContain('60s plausibility ceiling');
    expect(warning).toContain('1500 ms = 1.5s');
  });

  it('names the millisecond mix-up above the total ceiling', () => {
    const warning = implausibleSecondsWarning(45_000, 'total');
    expect(warning).toContain('Total response time');
    expect(warning).toContain('600s plausibility ceiling');
    expect(warning).toContain('45s');
  });
});

describe('percentile90', () => {
  it(`reports n/a below ${P90_MIN_N} samples instead of a percentile of a handful of points`, () => {
    expect(P90_MIN_N).toBe(5);
    expect(percentile90([])).toBeNull();
    expect(percentile90([1, 2, 3])).toBeNull();
    expect(percentile90([1, 2, 3, 4])).toBeNull();
    expect(formatP90([1, 2, 3])).toBe(P90_UNAVAILABLE_LABEL);
  });

  it('computes an interpolated P90 at and above the minimum sample size', () => {
    // n=5, position = 0.9*4 = 3.6 -> between the 4th (4) and 5th (5) values.
    expect(percentile90([1, 2, 3, 4, 5])).toBeCloseTo(4.6, 10);
    // n=11, position = 0.9*10 = 9 -> exactly the 10th value.
    expect(percentile90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toBe(10);
    expect(formatP90([1, 2, 3, 4, 5])).toBe('4.6s');
  });

  it('sorts and ignores non-finite samples', () => {
    expect(percentile90([5, 1, 4, 2, 3])).toBeCloseTo(4.6, 10);
    // Two non-finite values drop the usable sample below P90_MIN_N.
    expect(percentile90([5, 1, Number.NaN, Number.POSITIVE_INFINITY, 3])).toBeNull();
  });
});

describe('repairSpeedThresholds', () => {
  it('honours a valid, strictly increasing override', () => {
    const { thresholds, warnings } = repairSpeedThresholds(
      { good: 1, acceptable: 3, poor: 8, floor: 15 },
      'ttft',
    );
    expect(thresholds).toEqual({ good: 1, acceptable: 3, poor: 8, floor: 15 });
    expect(warnings).toEqual([]);
  });

  it('leaves unspecified fields at their defaults', () => {
    const { thresholds, warnings } = repairSpeedThresholds({ good: 1 }, 'ttft');
    expect(thresholds).toEqual({ good: 1, acceptable: 5, poor: 10, floor: 20 });
    expect(warnings).toEqual([]);
  });

  it('repairs a non-positive field with a warning rather than honouring it', () => {
    const { thresholds, warnings } = repairSpeedThresholds({ good: -1 }, 'ttft');
    expect(thresholds.good).toBe(SPEED_THRESHOLDS.ttft.good);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not a positive number');
  });

  it('falls back entirely when the override is non-monotonic', () => {
    const { thresholds, warnings } = repairSpeedThresholds(
      { good: 9, acceptable: 4, poor: 10, floor: 20 },
      'ttft',
    );
    expect(thresholds).toEqual(SPEED_THRESHOLDS.ttft);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not strictly increasing');
  });

  it('still yields a usable curve after repair', () => {
    const { thresholds } = repairSpeedThresholds({ good: 0, acceptable: 0 }, 'total');
    expect(normalizeSpeed(5, 'total', thresholds)).toBe(90);
    expect(normalizeSpeed(10, 'total', thresholds)).toBe(70);
  });
});
