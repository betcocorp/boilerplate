import { describe, expect, it } from 'vitest';

import type { SemanticRouteDecision } from '~/lib/orchestrator/semantic-router';
import { gateRecordSchema } from '~/lib/workflows/product-support/product-support-schemas';
import {
  buildSemanticRouterGate,
  resolveSemanticRoute,
  resolveSemanticRouterMode,
  semanticRouterRationale,
  semanticRouterRuntimeConfigFields,
} from '~/lib/workflows/product-support/semantic-router-decision';

/**
 * B0-649 — the pure half of the semantic-router integration: the three-state precedence, and the
 * gate/rationale/runtime-config records built from a decision. The wired-into-the-workflow half is
 * covered end-to-end by `semantic-router-integration.test.ts`.
 */

function decision(overrides: Partial<SemanticRouteDecision> = {}): SemanticRouteDecision {
  return {
    route: 'floor',
    confidence: 0.66,
    similarity: 0.66,
    margin: 0.21,
    path: 'semantic',
    scores: [
      { route: 'floor', similarity: 0.66 },
      { route: 'product', similarity: 0.45 },
    ],
    thresholds: { confidence: 0.5, margin: 0.1 },
    thresholdsPassed: { confidence: true, margin: true },
    latencyMs: 210,
    embeddingMs: 205,
    scoringMs: 5,
    embeddingModel: 'text-embedding-3-large',
    examplesVersion: 'v1',
    error: null,
    ...overrides,
  };
}

describe('resolveSemanticRouterMode', () => {
  it('is off when the flag is off', () => {
    expect(
      resolveSemanticRouterMode({ enabled: false, shadowMode: false, agentMode: 'orchestrator' }),
    ).toBe('off');
    expect(
      resolveSemanticRouterMode({ enabled: false, shadowMode: true, agentMode: 'orchestrator' }),
    ).toBe('off');
  });

  it('is off for a forced direct agentMode even when enabled', () => {
    expect(
      resolveSemanticRouterMode({ enabled: true, shadowMode: false, agentMode: 'floor' }),
    ).toBe('off');
  });

  it('is shadow when enabled with shadow mode on, live otherwise', () => {
    expect(
      resolveSemanticRouterMode({ enabled: true, shadowMode: true, agentMode: 'orchestrator' }),
    ).toBe('shadow');
    expect(
      resolveSemanticRouterMode({ enabled: true, shadowMode: false, agentMode: 'orchestrator' }),
    ).toBe('live');
  });
});

describe('resolveSemanticRoute', () => {
  it('returns the route only on the live + semantic path', () => {
    expect(resolveSemanticRoute('live', decision())).toBe('floor');
  });

  it('returns null on a live fallback, so the caller keeps the old safety net', () => {
    expect(resolveSemanticRoute('live', decision({ path: 'fallback', route: 'ambiguous' }))).toBe(
      null,
    );
  });

  it('returns null in shadow mode and when the router never ran', () => {
    expect(resolveSemanticRoute('shadow', decision())).toBe(null);
    expect(resolveSemanticRoute('off', decision())).toBe(null);
    expect(resolveSemanticRoute('live', null)).toBe(null);
  });
});

describe('semanticRouterRuntimeConfigFields', () => {
  it('reports a null path when the router never ran — not "fallback"', () => {
    expect(
      semanticRouterRuntimeConfigFields({
        mode: 'off',
        enabled: false,
        shadowMode: false,
        decision: null,
        decidedRoute: null,
      }),
    ).toEqual({
      semanticRouterEnabled: false,
      semanticRouterShadowMode: false,
      semanticRouterPath: null,
      semanticRouterDecided: false,
    });
  });

  it('distinguishes "ran and decided" from "ran and degraded"', () => {
    expect(
      semanticRouterRuntimeConfigFields({
        mode: 'live',
        enabled: true,
        shadowMode: false,
        decision: decision(),
        decidedRoute: 'floor',
      }),
    ).toMatchObject({ semanticRouterPath: 'semantic', semanticRouterDecided: true });

    expect(
      semanticRouterRuntimeConfigFields({
        mode: 'live',
        enabled: true,
        shadowMode: false,
        decision: decision({ path: 'fallback', route: 'ambiguous' }),
        decidedRoute: null,
      }),
    ).toMatchObject({ semanticRouterPath: 'fallback', semanticRouterDecided: false });
  });
});

describe('buildSemanticRouterGate', () => {
  it('produces a schema-valid live record carrying every observable field', () => {
    const record = buildSemanticRouterGate({
      mode: 'live',
      decision: decision(),
      routingDecision: 'floor',
      decidedBy: 'semantic_router',
    });

    expect(gateRecordSchema.safeParse(record).success).toBe(true);
    expect(record.gate).toBe('semantic_router_live');
    expect(record.verdict).toBe('agrees_with_routing_decision');
    expect(record.inputs).toMatchObject({
      semanticRoute: 'floor',
      semanticConfidence: 0.66,
      semanticMargin: 0.21,
      semanticPath: 'semantic',
      semanticLatencyMs: 210,
      semanticEmbeddingMs: 205,
      semanticScoringMs: 5,
    });
    expect(record.inputs.semanticScores).toEqual([
      { route: 'floor', similarity: 0.66 },
      { route: 'product', similarity: 0.45 },
    ]);
    expect(record.thresholds).toMatchObject({
      confidenceThreshold: 0.5,
      marginThreshold: 0.1,
      confidenceThresholdPassed: true,
      marginThresholdPassed: true,
      mode: 'live',
    });
  });

  it('records a fallback as "fell_back", not as a disagreement', () => {
    const record = buildSemanticRouterGate({
      mode: 'live',
      decision: decision({
        path: 'fallback',
        route: 'ambiguous',
        error: 'router_not_initialized',
      }),
      routingDecision: 'dilution',
      decidedBy: 'llm_classifier',
    });

    expect(record.verdict).toBe('fell_back');
    expect(record.effect).toContain('router_not_initialized');
    expect(record.effect).toContain('DEGRADED');
  });

  it('uses the shadow gate id and says the decision was not used', () => {
    const record = buildSemanticRouterGate({
      mode: 'shadow',
      decision: decision(),
      routingDecision: 'dilution',
      decidedBy: 'llm_classifier',
    });

    expect(record.gate).toBe('semantic_router_shadow');
    expect(record.verdict).toBe('disagrees_with_routing_decision');
    expect(record.effect).toContain('Not used to route this turn');
  });
});

describe('semanticRouterRationale', () => {
  it('states the latency split rather than a single blended number', () => {
    const rationale = semanticRouterRationale(decision());
    expect(rationale).toContain('210ms');
    expect(rationale).toContain('embedding 205ms');
    expect(rationale).toContain('scoring 5ms');
    expect(rationale).toContain('"floor"');
  });
});
