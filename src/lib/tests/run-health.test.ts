import { describe, expect, it } from 'vitest';

import {
  DEGRADED_FALLBACK_RATE_THRESHOLD,
  DEGRADED_MEAN_CONFIDENCE_THRESHOLD,
  computeRunRoutingHealth,
  formatRunHealthPercent,
  type RunRoutingHealthInput,
} from './run-health';

function healthy(confidence = 0.9): RunRoutingHealthInput {
  return { routingConfidence: confidence, routingFallbackReason: null };
}

function fellBack(reason: string, confidence = 0): RunRoutingHealthInput {
  return { routingConfidence: confidence, routingFallbackReason: reason };
}

describe('computeRunRoutingHealth (B0-911)', () => {
  it('reports a healthy run as not degraded', () => {
    const health = computeRunRoutingHealth(Array.from({ length: 20 }, () => healthy()));

    expect(health.degraded).toBe(false);
    expect(health.reasonsForDegradation).toEqual([]);
    expect(health.fallbackItems).toBe(0);
    expect(health.fallbackRate).toBe(0);
    expect(health.meanRoutingConfidence).toBeCloseTo(0.9);
    expect(health.topFallbackReason).toBeNull();
  });

  it('reproduces the 2026-09-08 incident: every item fell back, mean confidence 0', () => {
    const reason = 'llm_router: 400 {"error":"model not found"}';
    const health = computeRunRoutingHealth(
      Array.from({ length: 106 }, () => fellBack(reason)),
    );

    expect(health.degraded).toBe(true);
    expect(health.reasonsForDegradation).toEqual(['fallback_rate', 'low_mean_confidence']);
    expect(health.fallbackItems).toBe(106);
    expect(health.measuredItems).toBe(106);
    expect(health.fallbackRate).toBe(1);
    expect(health.meanRoutingConfidence).toBe(0);
    expect(health.topFallbackReason).toBe(reason);
  });

  it('still flags a pre-B0-911 run off confidence alone, with no reason to name', () => {
    // Rows written before `routing_fallback_reason` existed: confidence recorded, reason not.
    const health = computeRunRoutingHealth(
      Array.from({ length: 106 }, () => ({
        routingConfidence: 0,
        routingFallbackReason: null,
      })),
    );

    expect(health.degraded).toBe(true);
    expect(health.reasonsForDegradation).toEqual(['low_mean_confidence']);
    expect(health.fallbackItems).toBe(0);
    expect(health.topFallbackReason).toBeNull();
  });

  it('tolerates a single blip below the 5% rate threshold', () => {
    const items = [...Array.from({ length: 99 }, () => healthy()), fellBack('llm_router: timeout')];
    const health = computeRunRoutingHealth(items);

    expect(health.fallbackRate).toBeCloseTo(0.01);
    expect(health.fallbackRate! <= DEGRADED_FALLBACK_RATE_THRESHOLD).toBe(true);
    expect(health.degraded).toBe(false);
    // The reason is still recorded even when the run is not degraded.
    expect(health.topFallbackReason).toBe('llm_router: timeout');
  });

  it('trips the rate rule strictly above 5%, not at it', () => {
    // 5 of 100 = exactly the threshold → healthy; 6 of 100 → degraded.
    const at = computeRunRoutingHealth([
      ...Array.from({ length: 95 }, () => healthy()),
      ...Array.from({ length: 5 }, () => fellBack('llm_router: timeout', 0.9)),
    ]);
    const over = computeRunRoutingHealth([
      ...Array.from({ length: 94 }, () => healthy()),
      ...Array.from({ length: 6 }, () => fellBack('llm_router: timeout', 0.9)),
    ]);

    expect(at.degraded).toBe(false);
    expect(over.degraded).toBe(true);
    expect(over.reasonsForDegradation).toEqual(['fallback_rate']);
  });

  it('trips the confidence rule strictly below the threshold, not at it', () => {
    const at = computeRunRoutingHealth([healthy(DEGRADED_MEAN_CONFIDENCE_THRESHOLD)]);
    const under = computeRunRoutingHealth([healthy(0.29)]);

    expect(at.degraded).toBe(false);
    expect(under.degraded).toBe(true);
    expect(under.reasonsForDegradation).toEqual(['low_mean_confidence']);
  });

  it('computes both thresholds over MEASURED items only, never diluted by legacy rows', () => {
    // 4 measured items, all of which fell back, plus 96 rows with no instrumentation at all.
    const health = computeRunRoutingHealth([
      ...Array.from({ length: 4 }, () => fellBack('llm_router: 400')),
      ...Array.from({ length: 96 }, () => ({
        routingConfidence: null,
        routingFallbackReason: null,
      })),
    ]);

    expect(health.totalItems).toBe(100);
    expect(health.measuredItems).toBe(4);
    expect(health.fallbackRate).toBe(1);
    expect(health.degraded).toBe(true);
  });

  it('ranks distinct reasons by count, breaking ties alphabetically', () => {
    const health = computeRunRoutingHealth([
      fellBack('signals: b'),
      fellBack('llm_router: a'),
      fellBack('llm_router: a'),
      fellBack('signals: c'),
    ]);

    expect(health.fallbackReasons).toEqual([
      { reason: 'llm_router: a', count: 2 },
      { reason: 'signals: b', count: 1 },
      { reason: 'signals: c', count: 1 },
    ]);
    expect(health.topFallbackReason).toBe('llm_router: a');
  });

  it('is not degraded when there is nothing to judge', () => {
    expect(computeRunRoutingHealth([]).degraded).toBe(false);

    // A search-mode run, or one predating the B0-500 columns: no routing data at all.
    const noInstrumentation = computeRunRoutingHealth(
      Array.from({ length: 30 }, () => ({
        routingConfidence: null,
        routingFallbackReason: null,
      })),
    );
    expect(noInstrumentation.degraded).toBe(false);
    expect(noInstrumentation.measuredItems).toBe(0);
    expect(noInstrumentation.fallbackRate).toBeNull();
    expect(noInstrumentation.meanRoutingConfidence).toBeNull();
  });

  it('ignores a blank fallback reason rather than counting it as a fallback', () => {
    const health = computeRunRoutingHealth([
      { routingConfidence: 0.9, routingFallbackReason: '   ' },
      healthy(),
    ]);

    expect(health.fallbackItems).toBe(0);
    expect(health.degraded).toBe(false);
  });
});

describe('formatRunHealthPercent', () => {
  it('renders one decimal place', () => {
    expect(formatRunHealthPercent(1)).toBe('100.0%');
    expect(formatRunHealthPercent(0.05)).toBe('5.0%');
    expect(formatRunHealthPercent(0.0566)).toBe('5.7%');
  });
});
