import { describe, expect, it } from 'vitest';

import type { SemanticRoutingItem } from './routing-comparison';
import {
  DEFAULT_SEMANTIC_ROUTING_GATE_THRESHOLDS,
  evaluateSemanticRoutingGate,
  formatSemanticRoutingGateResult,
} from './semantic-routing-gate';

/** Builds `count` perfectly-routed, confident items so accuracy checks have a real denominator. */
function correctItems(count: number, label = 'floor'): SemanticRoutingItem[] {
  return Array.from({ length: count }, () => ({
    intendedAgentLabel: label,
    plausibleAgentLabels: [label],
    semanticRoute: label,
    semanticPath: 'semantic',
    semanticRouteLatencyMs: 120,
    semanticEmbeddingMs: 118,
    semanticScoringMs: 2,
  }));
}

describe('evaluateSemanticRoutingGate', () => {
  it('passes a clean run and reports every check', () => {
    const result = evaluateSemanticRoutingGate({ items: correctItems(30) });

    expect(result.pass).toBe(true);
    expect(result.checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(result.report.accuracy.strictAccuracy).toBe(1);
  });

  it('fails when the confidently-wrong (false-positive) rate exceeds the cap', () => {
    const items: SemanticRoutingItem[] = [
      ...correctItems(20),
      // 5 confident + wrong out of 25 confident routes = 20% > 5%.
      ...Array.from({ length: 5 }, () => ({
        intendedAgentLabel: 'bathroom',
        plausibleAgentLabels: ['bathroom'],
        semanticRoute: 'product',
        semanticPath: 'semantic',
        semanticScoringMs: 2,
      })),
    ];

    const result = evaluateSemanticRoutingGate({ items });
    const check = result.checks.find((c) => c.name.startsWith('false-positive'));

    expect(check?.status).toBe('fail');
    expect(check?.actual).toBeCloseTo(0.2);
    expect(result.pass).toBe(false);
  });

  it('does not count a WRONG fallback route as a false positive', () => {
    const items: SemanticRoutingItem[] = [
      ...correctItems(20),
      ...Array.from({ length: 5 }, () => ({
        intendedAgentLabel: 'bathroom',
        plausibleAgentLabels: ['bathroom'],
        semanticRoute: 'ambiguous',
        semanticPath: 'fallback',
        semanticScoringMs: 2,
      })),
    ];

    const result = evaluateSemanticRoutingGate({ items });
    expect(result.report.falsePositives.falsePositiveRate).toBe(0);
    expect(result.report.fallback.fallbackRate).toBeCloseTo(0.2);
  });

  it('fails when the fallback rate exceeds the cap', () => {
    const items: SemanticRoutingItem[] = [
      ...correctItems(20),
      ...Array.from({ length: 20 }, () => ({
        intendedAgentLabel: 'floor',
        plausibleAgentLabels: ['floor'],
        semanticRoute: 'ambiguous',
        semanticPath: 'fallback',
        semanticScoringMs: 2,
      })),
    ];

    const result = evaluateSemanticRoutingGate({ items });
    expect(result.checks.find((c) => c.name === 'fallback rate')?.status).toBe('fail');
    expect(result.pass).toBe(false);
  });

  it('gates the SCORING p95 only — a slow embedding round-trip never fails the gate', () => {
    const items = correctItems(30).map((item) => ({
      ...item,
      // Cold embedding: a 400ms total wait, but 2ms of actual scoring.
      semanticRouteLatencyMs: 402,
      semanticEmbeddingMs: 400,
      semanticScoringMs: 2,
    }));

    const result = evaluateSemanticRoutingGate({ items });
    expect(result.checks.find((c) => c.name === 'scoring p95')?.status).toBe('pass');
    expect(result.report.latency.total.p95Ms).toBe(402);
    expect(result.report.latency.embedding.p95Ms).toBe(400);
    expect(result.pass).toBe(true);
  });

  it('fails when scoring itself blows the ms budget', () => {
    const items = correctItems(30).map((item) => ({ ...item, semanticScoringMs: 42 }));
    const result = evaluateSemanticRoutingGate({ items });
    expect(result.checks.find((c) => c.name === 'scoring p95')?.status).toBe('fail');
    expect(result.pass).toBe(false);
  });

  it('skips (never passes) accuracy checks when the sample is too small to mean anything', () => {
    const result = evaluateSemanticRoutingGate({ items: correctItems(3) });
    const strict = result.checks.find((c) => c.name === 'strict accuracy');

    expect(strict?.status).toBe('skip');
    expect(strict?.actual).toBeNull();
    expect(strict?.detail).toContain('not counted as a pass');
  });

  it('skips every check on an empty measurement rather than reporting green numbers', () => {
    const result = evaluateSemanticRoutingGate({ items: [] });
    expect(result.checks.every((c) => c.status === 'skip')).toBe(true);
    expect(result.checks.some((c) => c.status === 'pass')).toBe(false);
    expect(result.report.accuracy.strictAccuracy).toBeNull();
  });

  it('compares against a supplied LLM baseline and fails a regression below it', () => {
    // 24/30 correct = 80% strict.
    const items: SemanticRoutingItem[] = [
      ...correctItems(24),
      ...Array.from({ length: 6 }, () => ({
        intendedAgentLabel: 'bathroom',
        plausibleAgentLabels: ['bathroom', 'product'],
        semanticRoute: 'product',
        semanticPath: 'fallback',
        semanticScoringMs: 2,
      })),
    ];

    const below = evaluateSemanticRoutingGate({ items, baselineAccuracy: 0.9 });
    expect(below.baselineComparison?.status).toBe('fail');
    expect(below.pass).toBe(false);

    const above = evaluateSemanticRoutingGate({ items, baselineAccuracy: 0.75 });
    expect(above.baselineComparison?.status).toBe('pass');
    expect(above.pass).toBe(true);
  });

  it('reports no baseline comparison when none was supplied (never assumes it held)', () => {
    const result = evaluateSemanticRoutingGate({ items: correctItems(30) });
    expect(result.baselineComparison).toBeNull();
    expect(result.checks.some((c) => c.name.includes('baseline'))).toBe(false);
  });

  it('honours overridden thresholds', () => {
    const items = correctItems(30).map((item) => ({ ...item, semanticScoringMs: 42 }));
    const result = evaluateSemanticRoutingGate({ items, thresholds: { maxScoringP95Ms: 50 } });
    expect(result.pass).toBe(true);
    expect(DEFAULT_SEMANTIC_ROUTING_GATE_THRESHOLDS.maxScoringP95Ms).toBe(10);
  });

  it('grades strict and lenient separately, so a near miss can pass lenient and fail strict', () => {
    // Every item is a plausible near miss: strict 0%, lenient 100%.
    const items: SemanticRoutingItem[] = Array.from({ length: 30 }, () => ({
      intendedAgentLabel: 'bathroom',
      plausibleAgentLabels: ['bathroom', 'product'],
      semanticRoute: 'product',
      semanticPath: 'fallback',
      semanticScoringMs: 2,
    }));

    const result = evaluateSemanticRoutingGate({ items });
    expect(result.report.accuracy.strictAccuracy).toBe(0);
    expect(result.report.accuracy.lenientAccuracy).toBe(1);
    expect(result.checks.find((c) => c.name === 'strict accuracy')?.status).toBe('fail');
    expect(result.checks.find((c) => c.name.startsWith('lenient accuracy'))?.status).toBe('pass');
  });
});

describe('formatSemanticRoutingGateResult', () => {
  it('renders the three latency components and the per-route table', () => {
    const output = formatSemanticRoutingGateResult(
      evaluateSemanticRoutingGate({ items: correctItems(30) }),
    );

    expect(output).toContain('latency total');
    expect(output).toContain('latency embed');
    expect(output).toContain('latency scoring');
    expect(output).toContain('floor');
    expect(output).toContain('gate: PASS');
  });
});
