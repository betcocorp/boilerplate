import { describe, expect, it } from 'vitest';

import {
  ANSWER_SHAPES,
  COMPETITOR_SELF_REFERENCE_REASONS,
  competitorSelfReferenceVerdictSchema,
  DECLINE_CLASSES,
  llmTurnSignalsSchema,
  PRODUCT_ENTITY_RESOLUTION_SOURCES,
  SIGNALS_CONTRACT_VERSION,
  turnSignalsSchema,
} from '~/lib/orchestrator/signals/signals-schemas';
import { EARLY_DECLINE_REASONS } from '~/lib/workflows/product-support/run-product-support-workflow';
import { intentEntitiesSchema } from '~/lib/orchestrator/intent-classifier';

const VALID_LLM_SIGNALS = {
  intent: 'cross_reference' as const,
  confidence: 0.82,
  betcoProduct: null,
  competitorBrand: 'Spartan',
  competitorProduct: 'BNC-15',
  otherCompetitorProduct: 'Virex II 256',
  surfaceType: null,
  taskDescription: 'find a Betco equivalent',
  brandFamily: 'competitor' as const,
  setting: null,
  productCategory: 'quat disinfectant',
  carriedProduct: null,
  suggestedTool: 'lookup_cross_reference' as const,
  crossReferenceIntent: true,
  competitorIsGenericChemistry: false,
  isConversionListAsk: false,
  answerShape: 'single_value' as const,
  declineClass: null,
  regulatedSectionIntent: true,
};

describe('B0-786 signals contract', () => {
  it('parses a complete model payload', () => {
    expect(llmTurnSignalsSchema.parse(VALID_LLM_SIGNALS)).toEqual(VALID_LLM_SIGNALS);
  });

  it('rejects a payload missing a signal rather than defaulting it', () => {
    const withoutSignal: Record<string, unknown> = { ...VALID_LLM_SIGNALS };
    delete withoutSignal.regulatedSectionIntent;
    expect(llmTurnSignalsSchema.safeParse(withoutSignal).success).toBe(false);
  });

  it('rejects an answerShape / declineClass outside the closed sets', () => {
    expect(
      llmTurnSignalsSchema.safeParse({ ...VALID_LLM_SIGNALS, answerShape: 'essay' }).success,
    ).toBe(false);
    expect(
      llmTurnSignalsSchema.safeParse({ ...VALID_LLM_SIGNALS, declineClass: 'made_up' }).success,
    ).toBe(false);
  });

  it('carries every field the intent classifier produced, under the same names', () => {
    // The flattened signals schema must not silently drop one of the entity fields every existing
    // consumer reads off `IntentClassification`.
    for (const key of Object.keys(intentEntitiesSchema.shape)) {
      expect(Object.keys(llmTurnSignalsSchema.shape)).toContain(key);
    }
    for (const key of ['intent', 'confidence', 'suggestedTool']) {
      expect(Object.keys(llmTurnSignalsSchema.shape)).toContain(key);
    }
  });

  it('DECLINE_CLASSES matches EARLY_DECLINE_REASONS at runtime, not only in the type checker', () => {
    expect([...DECLINE_CLASSES].sort()).toEqual([...EARLY_DECLINE_REASONS].sort());
  });

  it('keeps the enrichment fields off the model payload and on the full contract', () => {
    for (const key of ['resolvedProductLineKey', 'resolutionSource', 'selfReferenceVerdict']) {
      expect(Object.keys(llmTurnSignalsSchema.shape)).not.toContain(key);
      expect(Object.keys(turnSignalsSchema.shape)).toContain(key);
    }
  });

  it('parses a full TurnSignals including a suppressed self-reference verdict', () => {
    const parsed = turnSignalsSchema.parse({
      ...VALID_LLM_SIGNALS,
      source: 'llm',
      fallbackReason: null,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, cachedPromptTokens: 0 },
      model: 'gpt-4.1',
      resolvedProductLineKey: 'PL-123',
      resolutionSource: 'alias_exact',
      selfReferenceVerdict: {
        suppressed: true,
        reason: 'betco_product',
        productLineKey: 'PL-123',
        matched: 'speedex',
      },
    });
    expect(parsed.selfReferenceVerdict).toEqual({
      suppressed: true,
      reason: 'betco_product',
      productLineKey: 'PL-123',
      matched: 'speedex',
    });
  });

  it('accepts the unsuppressed verdict shape and rejects a half-populated one', () => {
    expect(competitorSelfReferenceVerdictSchema.parse({ suppressed: false })).toEqual({
      suppressed: false,
    });
    expect(
      competitorSelfReferenceVerdictSchema.safeParse({ suppressed: true, reason: 'betco_brand' })
        .success,
    ).toBe(false);
  });

  it('exposes the closed sets the JSON schema and the enrichment are built from', () => {
    expect(ANSWER_SHAPES).toEqual([
      'single_value',
      'enumeration',
      'procedure',
      'comparison',
    ]);
    expect(COMPETITOR_SELF_REFERENCE_REASONS).toContain('conversion_list_ask');
    expect(PRODUCT_ENTITY_RESOLUTION_SOURCES).toContain('alias_exact_freeform');
    expect(SIGNALS_CONTRACT_VERSION).toBeTruthy();
  });
});
