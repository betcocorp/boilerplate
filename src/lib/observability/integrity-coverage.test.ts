import { describe, expect, it } from 'vitest';

import {
  DECISION_NODES,
  INSTRUMENTED_ACTIVATION_KEYS,
  INSTRUMENTED_GATE_IDS,
  buildRunIntegrityView,
  findDecisionNodeCoverageGaps,
  formatCoverageGaps,
  groupConfidencesByProvenance,
} from '~/lib/observability/integrity-coverage';

import type { IntegrityStepRow } from '~/lib/observability/integrity-coverage';

/**
 * B0-496 — the coverage assertion (epic B0-489).
 *
 * This is the test that fails the build when a decision point that can change a run's outcome is
 * added without instrumentation. It enumerates the nodes from the CODE (`gateIdSchema`,
 * `activeGatesSchema`, and the B0-490..494 run-level measurement fields) rather than from the
 * design doc the ticket cites — `claude/prompt-observability-design.md` does not exist in this
 * repo, so anchoring to it would have made the enumeration unverifiable.
 */

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

function gateRecord(gate: string, verdict = 'passed') {
  return { gate, inputs: {}, thresholds: {}, verdict, effect: `${gate} → ${verdict}` };
}

/** A run where every decision node emitted its record. */
function fullyInstrumentedRun(): {
  runConfidence: number;
  finalOutput: Record<string, unknown>;
  steps: IntegrityStepRow[];
} {
  return {
    runConfidence: 0.55,
    finalOutput: {
      answerText: 'Dilute at 2 oz/gal.',
      answerProvenance: 'model_generated',
      confidence: 0.55,
      validation: { approved: false, confidence: 0.55, issues: [], requires_human_review: false },
      agentConfidence: 0.82,
      agentConfidenceBasis: 'Label chunk retrieved.',
      agentConfidenceReason: 'reported',
      confidenceProvenance: 'gate_capped',
      confidencePreCapValue: 0.9,
      confidencePreCapProvenance: 'validator_bypassed_heuristic',
      similaritySummary: {
        rawTopSimilarity: 0.91,
        selectedTopSimilarity: 0.74,
        droppedByFilterCount: 6,
      },
      retrievalConfig: {
        embeddingModel: 'text-embedding-3-large',
        retrievalStrategy: 'hybrid+reranked',
        embeddingSource: 'live',
        scope: 'betco_us',
        minSimilarity: 0.2,
        mixed: [],
      },
      rerankMsTotal: 143,
      productLineLock: null,
      resolvedCompetitor: { brand: 'Acme', product: 'X-7', otherCompetitorProduct: null },
      runtimeConfig: {
        useValidator: false,
        earlyDeclineGateEnabled: true,
        aiSdkGenerationEnabled: false,
        rerankerActive: true,
        confidenceGatingDisabled: false,
        agentMode: 'orchestrator',
        routedDirectly: false,
        semanticRouterEnabled: true,
        semanticRouterShadowMode: true,
        semanticRouterPath: 'semantic',
        semanticRouterDecided: false,
      },
      activeGates: {
        validator: { state: 'skipped', reason: 'disabled_by_flag' },
        earlyDeclineGate: { state: 'ran' },
        usageSafetyCoverage: { state: 'ran' },
        regulatedClaimGuardrail: { state: 'ran' },
        recommendationConfidence: { state: 'ran' },
      },
    },
    steps: [
      {
        step_name: 'orchestration_planner',
        output: {
          gates: [
            gateRecord('keyword_routing', 'overridden_by_llm_cutover'),
            gateRecord('llm_intent_classifier_live', 'agrees_with_keyword_router'),
            gateRecord('semantic_router_shadow', 'agrees'),
            gateRecord('competitor_identity_resolution', 'resolved'),
          ],
        },
      },
      {
        step_name: 'openai_responses_agent',
        output: { toolTrace: [] },
      },
      {
        step_name: 'validator',
        output: {
          approved: false,
          confidence: 0.55,
          issues: ['insufficient_safety_evidence'],
          requires_human_review: false,
          skipped: true,
          reason: 'validator_bypassed_for_testing',
          confidenceProvenance: 'gate_capped',
          confidencePreCapValue: 0.9,
          confidencePreCapProvenance: 'validator_bypassed_heuristic',
          gates: [
            gateRecord('usage_safety_coverage', 'capped'),
            gateRecord('recommendation_confidence', 'passed'),
          ],
        },
      },
    ],
  };
}

/** A pre-B0-388 run: real steps, but no gate records and none of the B0-490..494 blocks. */
function historicalRun() {
  return {
    runConfidence: 0.9,
    finalOutput: {
      answerText: 'Use the product per label directions.',
      confidence: 0.9,
      validation: { approved: true, confidence: 0.9, issues: [], requires_human_review: false },
    },
    steps: [
      { step_name: 'orchestration_planner', output: { routing: { decision: 'product' } } },
      { step_name: 'openai_responses_agent', output: {} },
      { step_name: 'validator', output: { approved: true, confidence: 0.9, issues: [] } },
    ] satisfies IntegrityStepRow[],
  };
}

/** A run the early-decline gate answered: no model call, no retrieval. */
function declineRun() {
  return {
    runConfidence: 0.92,
    finalOutput: {
      answerText: 'I can’t advise on mixing chemicals.',
      answerProvenance: 'decline_gate',
      confidence: 0.92,
      validation: { approved: true, confidence: 0.92, issues: [], requires_human_review: false },
      agentConfidence: null,
      agentConfidenceBasis: null,
      agentConfidenceReason: 'no_model_call',
      confidenceProvenance: 'decline_gate_constant',
      confidencePreCapValue: null,
      confidencePreCapProvenance: null,
      runtimeConfig: {
        useValidator: false,
        earlyDeclineGateEnabled: true,
        aiSdkGenerationEnabled: false,
        rerankerActive: true,
        confidenceGatingDisabled: false,
        agentMode: 'orchestrator',
        routedDirectly: false,
      },
      activeGates: {
        validator: { state: 'not_applicable' },
        earlyDeclineGate: { state: 'ran' },
        usageSafetyCoverage: { state: 'not_applicable' },
        regulatedClaimGuardrail: { state: 'not_applicable' },
        recommendationConfidence: { state: 'not_applicable' },
      },
    },
    steps: [
      {
        step_name: 'orchestration_planner',
        output: { gates: [gateRecord('keyword_routing', 'no_signal')] },
      },
      {
        step_name: 'early_decline_gate',
        output: { applied: true, gates: [gateRecord('early_decline_gate', 'declined')] },
      },
    ] satisfies IntegrityStepRow[],
  };
}

/* -------------------------------------------------------------------------- *
 * 1. Registry coverage — the build-failing assertion
 * -------------------------------------------------------------------------- */

describe('decision-node registry coverage (B0-496)', () => {
  it('claims every gate id the workflow can write and every tracked activation key', () => {
    const gaps = findDecisionNodeCoverageGaps({
      gateIds: INSTRUMENTED_GATE_IDS,
      activationKeys: INSTRUMENTED_ACTIVATION_KEYS,
    });
    expect(formatCoverageGaps(gaps)).toBe('Every decision node is measured.');
  });

  it('fails, naming the node, when a throwaway gate is added without instrumentation', () => {
    // The fixture stands in for next quarter's new rule gate: a `gateIdSchema` value that no
    // DECISION_NODES entry claims, i.e. one nothing measures or renders.
    const gaps = findDecisionNodeCoverageGaps({
      gateIds: [...INSTRUMENTED_GATE_IDS, 'throwaway_similarity_floor_gate'],
      activationKeys: INSTRUMENTED_ACTIVATION_KEYS,
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('unregistered_gate');
    expect(gaps[0].id).toBe('throwaway_similarity_floor_gate');
    expect(formatCoverageGaps(gaps)).toContain('throwaway_similarity_floor_gate');
    expect(formatCoverageGaps(gaps)).toContain('integrity-coverage.ts');
  });

  it('fails, naming the key, when a throwaway gate activation is added without instrumentation', () => {
    const gaps = findDecisionNodeCoverageGaps({
      activationKeys: [...INSTRUMENTED_ACTIVATION_KEYS, 'throwawayCoverageGate'],
    });

    expect(gaps.map((gap) => gap.id)).toEqual(['throwawayCoverageGate']);
    expect(gaps[0].kind).toBe('unregistered_activation');
    expect(formatCoverageGaps(gaps)).toContain('throwawayCoverageGate');
  });

  it('assigns every gate id to exactly one node, so no gate is rendered twice or contested', () => {
    const owners = new Map<string, string[]>();
    for (const node of DECISION_NODES) {
      for (const gateId of node.gateIds) {
        owners.set(gateId, [...(owners.get(gateId) ?? []), node.id]);
      }
    }
    const contested = [...owners.entries()].filter(([, nodes]) => nodes.length > 1);
    expect(contested).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * 2. Per-run coverage
 * -------------------------------------------------------------------------- */

describe('buildRunIntegrityView — decision node coverage (B0-496)', () => {
  it('reports no unmeasured node on a fully instrumented run', () => {
    const view = buildRunIntegrityView(fullyInstrumentedRun());
    const gaps = findDecisionNodeCoverageGaps({ view });
    expect(formatCoverageGaps(gaps)).toBe('Every decision node is measured.');
    expect(view.predatesIntegrityInstrumentation).toBe(false);
  });

  it('names the unmeasured node when one executed without emitting a record', () => {
    // The throwaway gate again, this time at RUN level: `activeGates` says the usage/safety
    // coverage gate ran, but the validator step emitted no record for it.
    const run = fullyInstrumentedRun();
    run.steps[2].output = {
      ...(run.steps[2].output as Record<string, unknown>),
      gates: [gateRecord('recommendation_confidence', 'passed')],
    };

    const view = buildRunIntegrityView(run);
    const gaps = findDecisionNodeCoverageGaps({ view });

    expect(view.unmeasuredNodeIds).toEqual(['usage_safety_coverage']);
    expect(gaps[0].kind).toBe('unmeasured_node');
    expect(formatCoverageGaps(gaps)).toContain('usage_safety_coverage');
    expect(formatCoverageGaps(gaps)).toContain('emitted no gate record');
  });

  it('flags a keyword-routing record as a gap, since that node runs on every run', () => {
    const run = fullyInstrumentedRun();
    run.steps[0].output = { gates: [] };

    const view = buildRunIntegrityView(run);
    expect(view.unmeasuredNodeIds).toContain('keyword_routing');
    expect(view.nodes.find((node) => node.id === 'keyword_routing')?.detail).toContain(
      'unconditionally',
    );
  });

  it('renders a historical run as mostly unmeasured rather than as passing', () => {
    const view = buildRunIntegrityView(historicalRun());

    expect(view.predatesIntegrityInstrumentation).toBe(true);
    expect(view.unmeasuredNodeIds).toEqual(
      expect.arrayContaining([
        'keyword_routing',
        'agent_self_confidence',
        'confidence_provenance',
        'similarity_rollup',
        'retrieval_config',
        'runtime_config',
      ]),
    );
    // The five activation-tracked gates have no activeGates block at all: "unknown", never "ran".
    for (const id of [
      'validator',
      'early_decline_gate',
      'usage_safety_coverage',
      'regulated_claim_guardrail',
      'recommendation_confidence',
    ]) {
      expect(view.nodes.find((node) => node.id === id)?.status).toBe('unknown');
    }
    expect(view.nodes.every((node) => node.status !== 'measured')).toBe(true);
  });

  it('reports a decline run’s retrieval nodes as not applicable, not as gaps', () => {
    const view = buildRunIntegrityView(declineRun());

    expect(view.unmeasuredNodeIds).toEqual([]);
    expect(view.nodes.find((node) => node.id === 'similarity_rollup')?.status).toBe(
      'not_applicable',
    );
    expect(view.nodes.find((node) => node.id === 'retrieval_config')?.status).toBe(
      'not_applicable',
    );
    expect(view.nodes.find((node) => node.id === 'early_decline_gate')?.status).toBe('measured');
    expect(view.nodes.find((node) => node.id === 'validator')?.status).toBe('not_applicable');
  });

  it('distinguishes a flag-disabled gate from one that ran', () => {
    const view = buildRunIntegrityView(fullyInstrumentedRun());
    const validator = view.nodes.find((node) => node.id === 'validator');
    expect(validator?.status).toBe('skipped');
    expect(validator?.detail).toContain('disabled_by_flag');
  });

  it('reports a kill-switched gate as bypassed, never as a cap that was applied', () => {
    const run = fullyInstrumentedRun();
    run.finalOutput.activeGates = {
      ...(run.finalOutput.activeGates as Record<string, unknown>),
      regulatedClaimGuardrail: { state: 'bypassed', reason: 'confidence_gating_disabled' },
    };

    const view = buildRunIntegrityView(run);
    const node = view.nodes.find((n) => n.id === 'regulated_claim_guardrail');
    expect(node?.status).toBe('bypassed');
    expect(node?.detail).toContain('not enforced');
  });

  it('says "unknown", not "did not run", when nothing records whether the LLM classifier ran', () => {
    const run = fullyInstrumentedRun();
    run.steps[0].output = { gates: [gateRecord('keyword_routing', 'product')] };

    const view = buildRunIntegrityView(run);
    expect(view.nodes.find((node) => node.id === 'llm_intent_classifier')?.status).toBe('unknown');
    expect(view.nodes.find((node) => node.id === 'semantic_router')?.status).toBe('unmeasured');
  });
});

/* -------------------------------------------------------------------------- *
 * 3. Confidence and similarity provenance
 * -------------------------------------------------------------------------- */

describe('confidence observations (B0-492)', () => {
  it('gives every confidence number a provenance, including the pre-cap value', () => {
    const view = buildRunIntegrityView(fullyInstrumentedRun());

    expect(view.confidences.length).toBeGreaterThan(0);
    for (const observation of view.confidences) {
      expect(observation.provenance).toBeTruthy();
      expect(observation.source).toBeTruthy();
    }
    const runConfidence = view.confidences.find((o) => o.id === 'run_row_confidence');
    expect(runConfidence?.provenance).toBe('gate_capped');
    expect(runConfidence?.preCapValue).toBe(0.9);
    expect(runConfidence?.preCapProvenance).toBe('validator_bypassed_heuristic');
  });

  it('labels a historical run’s confidence "unknown" rather than as a judgment', () => {
    const view = buildRunIntegrityView(historicalRun());
    const runConfidence = view.confidences.find((o) => o.id === 'run_row_confidence');
    expect(runConfidence?.provenance).toBe('unknown');
    expect(runConfidence?.isJudgment).toBe(false);
  });

  it('keeps the agent self-score separate from the run confidence', () => {
    const view = buildRunIntegrityView(fullyInstrumentedRun());
    const agent = view.confidences.find((o) => o.id === 'agent_self_confidence');
    expect(agent?.value).toBe(0.82);
    expect(agent?.provenance).toBe('agent_self_scored');
    expect(agent?.isJudgment).toBe(false);
    expect(agent?.note).toContain('reason: reported');
  });

  it('records the decline run’s null self-score with the reason that explains it', () => {
    const view = buildRunIntegrityView(declineRun());
    const agent = view.confidences.find((o) => o.id === 'agent_self_confidence');
    expect(agent?.value).toBeNull();
    expect(agent?.note).toContain('no_model_call');
  });
});

describe('confidence distribution by provenance (B0-492)', () => {
  it('groups by provenance instead of producing one cross-provenance mean', () => {
    const groups = groupConfidencesByProvenance([
      {
        id: 'a',
        label: 'a',
        value: 0.9,
        provenance: 'validator_judged',
        isJudgment: true,
        preCapValue: null,
        preCapProvenance: null,
        source: 'x',
        note: null,
      },
      {
        id: 'b',
        label: 'b',
        value: 0.6,
        provenance: 'validator_bypassed_heuristic',
        isJudgment: false,
        preCapValue: null,
        preCapProvenance: null,
        source: 'x',
        note: null,
      },
      {
        id: 'c',
        label: 'c',
        value: 0.4,
        provenance: 'validator_bypassed_heuristic',
        isJudgment: false,
        preCapValue: null,
        preCapProvenance: null,
        source: 'x',
        note: null,
      },
    ]);

    expect(groups.map((group) => group.provenance)).toEqual([
      'validator_judged',
      'validator_bypassed_heuristic',
    ]);
    expect(groups[0]).toMatchObject({ count: 1, mean: 0.9, isJudgment: true });
    expect(groups[1]).toMatchObject({ count: 2, min: 0.4, max: 0.6, isJudgment: false });
    // 0.5, not (0.9 + 0.6 + 0.4) / 3 — a constant is never averaged with a judgment.
    expect(groups[1].mean).toBeCloseTo(0.5, 10);
  });

  it('drops null values rather than counting them as zero', () => {
    const groups = groupConfidencesByProvenance([
      {
        id: 'a',
        label: 'a',
        value: null,
        provenance: 'agent_self_scored',
        isJudgment: false,
        preCapValue: null,
        preCapProvenance: null,
        source: 'x',
        note: null,
      },
    ]);
    expect(groups).toEqual([]);
  });
});

describe('similarity integrity (B0-490)', () => {
  it('reports raw, selected and the count filtered out between them', () => {
    const { similarity } = buildRunIntegrityView(fullyInstrumentedRun());
    expect(similarity).toMatchObject({
      measured: true,
      rawTopSimilarity: 0.91,
      selectedTopSimilarity: 0.74,
      droppedByFilterCount: 6,
    });
    expect(similarity.source).toContain('similaritySummary');
  });

  it('is explicitly unmeasured — never 0 — on a run that predates B0-490', () => {
    const { similarity } = buildRunIntegrityView(historicalRun());
    expect(similarity.measured).toBe(false);
    expect(similarity.rawTopSimilarity).toBeNull();
    expect(similarity.selectedTopSimilarity).toBeNull();
    expect(similarity.droppedByFilterCount).toBeNull();
    expect(similarity.note).toContain('predates B0-490');
  });

  it('explains a decline run’s absent similarity as "no retrieval happened"', () => {
    const { similarity } = buildRunIntegrityView(declineRun());
    expect(similarity.measured).toBe(false);
    expect(similarity.note).toContain('no retrieval');
  });
});

describe('retrieval configuration (B0-493)', () => {
  it('reports the configuration the run used, with rerank timing beside it', () => {
    const { retrieval } = buildRunIntegrityView(fullyInstrumentedRun());
    expect(retrieval.measured).toBe(true);
    expect(retrieval.config).toMatchObject({
      embeddingModel: 'text-embedding-3-large',
      retrievalStrategy: 'hybrid+reranked',
      minSimilarity: 0.2,
      mixed: [],
    });
    expect(retrieval.rerankMsTotal).toBe(143);
    expect(retrieval.runtimeConfig?.rerankerActive).toBe(true);
  });

  it('is unmeasured, with a null config, on a run that predates B0-493', () => {
    const { retrieval } = buildRunIntegrityView(historicalRun());
    expect(retrieval.measured).toBe(false);
    expect(retrieval.config).toBeNull();
    expect(retrieval.runtimeConfig).toBeNull();
  });
});
