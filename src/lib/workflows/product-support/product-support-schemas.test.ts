import { describe, expect, it } from 'vitest';

import {
  answerProvenanceSchema,
  gateRecordSchema,
  productSupportFinalOutputSchema,
  productSupportStepInputSchema,
  productSupportStepOutputSchema,
  promptRecordSchema,
  readStepGateRecords,
} from '~/lib/workflows/product-support/product-support-schemas';

/** A `workflow_run.final_output` payload as written before B0-388 existed. */
const legacyFinalOutput = {
  answerText: 'Use 2 oz/gal of warm water.',
  sources: [{ documentId: 'doc-1', title: 'Label', snippet: '2 oz/gal' }],
  retrieved_document_chunks: [{ document_id: 'doc-1', chunk_id: 'chunk-1' }],
  confidence: 0.82,
  workflowRunId: '11111111-1111-4111-8111-111111111111',
  latestOpenaiResponseId: 'resp_abc',
  validation: {
    approved: true,
    confidence: 0.82,
    issues: [],
    requires_human_review: false,
  },
  routingDecision: 'product',
  timingBreakdown: { toolRounds: 2, cacheSource: null, searchMs: 120 },
  usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
};

describe('productSupportFinalOutputSchema — B0-388 additions are backward compatible', () => {
  it('still parses a pre-B0-388 payload that has none of the new fields', () => {
    const parsed = productSupportFinalOutputSchema.safeParse(legacyFinalOutput);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.promptVersion).toBeUndefined();
    expect(parsed.success && parsed.data.answerProvenance).toBeUndefined();
    expect(parsed.success && parsed.data.priorMessageCount).toBeUndefined();
    expect(parsed.success && parsed.data.previousResponseId).toBeUndefined();
  });

  it('parses a payload carrying the new prompt, provenance and chat-context fields', () => {
    const parsed = productSupportFinalOutputSchema.safeParse({
      ...legacyFinalOutput,
      promptVersion: 'sha256:prompt',
      promptBundleVersion: 'sha256:bundle',
      answerProvenance: 'cross_reference_composed',
      priorMessageCount: 4,
      previousResponseId: 'resp_prev',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a null previousResponseId (first turn of a conversation)', () => {
    expect(
      productSupportFinalOutputSchema.safeParse({
        ...legacyFinalOutput,
        previousResponseId: null,
        priorMessageCount: 0,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown answerProvenance value', () => {
    expect(
      productSupportFinalOutputSchema.safeParse({
        ...legacyFinalOutput,
        answerProvenance: 'made_up',
      }).success,
    ).toBe(false);
  });
});

describe('answerProvenanceSchema', () => {
  it('covers exactly the seven answer branches', () => {
    expect(answerProvenanceSchema.options).toEqual([
      'model_generated',
      'template_override',
      'cross_reference_composed',
      'decline_gate',
      'usage_safety_fallback',
      'validator_fallback',
      'revision_pass',
    ]);
  });
});

describe('promptRecordSchema', () => {
  it('accepts each LLM boundary and both runtimes', () => {
    for (const stage of ['openai_responses_agent', 'validator', 'revision'] as const) {
      for (const runtime of ['responses', 'ai-sdk'] as const) {
        expect(
          promptRecordSchema.safeParse({
            stage,
            instructions: 'You are a Betco product-support specialist.',
            model: 'gpt-5',
            runtime,
          }).success,
        ).toBe(true);
      }
    }
  });

  it('rejects an unknown stage or runtime', () => {
    const base = { instructions: 'x', model: 'gpt-5', runtime: 'responses' };
    expect(promptRecordSchema.safeParse({ ...base, stage: 'planner' }).success).toBe(false);
    expect(
      promptRecordSchema.safeParse({ ...base, stage: 'validator', runtime: 'ai_sdk' }).success,
    ).toBe(false);
  });
});

describe('gateRecordSchema', () => {
  it('accommodates all four gates despite their differing input shapes', () => {
    const records = [
      {
        gate: 'keyword_routing' as const,
        inputs: { product: 3, bathroom: 0, dilution: 1, floor: 0, recommendations: 0 },
        thresholds: { minScore: 1 },
        verdict: 'routed',
        effect: 'Routed to the product SME.',
      },
      {
        gate: 'early_decline_gate' as const,
        inputs: { reason: 'chemical_mixing_or_safety' },
        thresholds: {},
        verdict: 'applied',
        effect: 'Declined before any model call.',
      },
      {
        gate: 'usage_safety_coverage' as const,
        inputs: { hasUsageEvidence: true, hasSafetyEvidence: false },
        thresholds: { cap: 0.55 },
        verdict: 'capped',
        effect: 'Confidence capped at 0.55; insufficient_safety_evidence added.',
      },
      {
        gate: 'recommendation_confidence' as const,
        inputs: { overallConfidence: 0.74 },
        thresholds: { minConfidence: 0.8 },
        verdict: 'declined',
        effect: 'Cross-reference recommendation withheld.',
      },
    ];

    for (const record of records) {
      expect(gateRecordSchema.safeParse(record).success).toBe(true);
    }
  });

  it('rejects an unknown gate id', () => {
    expect(
      gateRecordSchema.safeParse({
        gate: 'regulated_claim_guardrail',
        inputs: {},
        thresholds: {},
        verdict: 'applied',
        effect: '',
      }).success,
    ).toBe(false);
  });
});

describe('persisted workflow-step payload schemas', () => {
  it('keeps existing step-specific keys and validates the reused tool trace', () => {
    const parsed = productSupportStepOutputSchema.safeParse({
      responseIds: ['resp_1'],
      toolCalls: 2,
      toolTrace: [
        {
          toolName: 'semantic_search',
          callId: 'call_1',
          argumentsPreview: '{"query":"dilution"}',
          outputPreview: '[{"documentId":"doc-1"}]',
          ok: true,
          durationMs: 42,
        },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.responseIds).toEqual(['resp_1']);
    expect(parsed.success && parsed.data.toolTrace?.[0]?.toolName).toBe('semantic_search');
  });

  it('rejects a malformed tool-trace entry', () => {
    expect(
      productSupportStepOutputSchema.safeParse({ toolTrace: [{ toolName: 'x' }] }).success,
    ).toBe(false);
  });

  it('carries a prompt record on step input alongside existing keys', () => {
    const parsed = productSupportStepInputSchema.safeParse({
      model: 'gpt-5',
      hasPreviousResponse: true,
      prompt: {
        stage: 'openai_responses_agent',
        instructions: 'You are a Betco product-support specialist.',
        model: 'gpt-5',
        runtime: 'responses',
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.prompt?.stage).toBe('openai_responses_agent');
    expect(parsed.success && parsed.data.model).toBe('gpt-5');
  });
});

describe('step gate records (B0-391)', () => {
  const usageSafety = {
    gate: 'usage_safety_coverage' as const,
    inputs: { hasUsageEvidence: true, hasSafetyEvidence: false },
    thresholds: { confidenceCap: 0.55 },
    verdict: 'capped',
    effect: 'Confidence capped at 0.55.',
  };
  const recommendation = {
    gate: 'recommendation_confidence' as const,
    inputs: { baseConfidence: 0.9, topSimilarity: 0.5 },
    thresholds: { lowSimilarityThreshold: 0.6 },
    verdict: 'capped',
    effect: 'Confidence 0.9 → 0.75.',
  };

  it('carries several records on one step row, in evaluation order', () => {
    const parsed = productSupportStepOutputSchema.safeParse({
      approved: false,
      gates: [usageSafety, recommendation],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.gates?.map((record) => record.gate)).toEqual([
      'usage_safety_coverage',
      'recommendation_confidence',
    ]);
  });

  it('reads either spelling, and yields nothing for a row with no gates', () => {
    expect(readStepGateRecords({ gates: [usageSafety, recommendation] })).toHaveLength(2);
    expect(readStepGateRecords({ gate: usageSafety })).toEqual([usageSafety]);
    expect(readStepGateRecords({ responseIds: ['resp_1'] })).toEqual([]);
    expect(readStepGateRecords(null)).toEqual([]);
    // Malformed rows degrade to "no records" rather than throwing at a read site.
    expect(readStepGateRecords({ gates: [{ gate: 'not-a-gate' }] })).toEqual([]);
  });
});
