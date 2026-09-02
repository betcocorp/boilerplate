import { describe, expect, it } from 'vitest';

import { buildSignalQueryRewrite } from '~/lib/orchestrator/signals/signal-query-rewrite';
import type { TurnSignals } from '~/lib/orchestrator/signals/signals-schemas';

/** Full `TurnSignals` fixture with every rewrite-relevant field null; tests override what they need. */
const BASE: TurnSignals = {
  intent: 'floor',
  confidence: 0.9,
  betcoProduct: null,
  competitorBrand: null,
  competitorProduct: null,
  otherCompetitorProduct: null,
  surfaceType: null,
  taskDescription: null,
  brandFamily: null,
  setting: null,
  productCategory: null,
  carriedProduct: null,
  suggestedTool: null,
  crossReferenceIntent: false,
  competitorIsGenericChemistry: false,
  isConversionListAsk: false,
  answerShape: 'single_value',
  declineClass: null,
  regulatedSectionIntent: false,
  source: 'llm',
  fallbackReason: null,
  usage: null,
  model: null,
  resolvedProductLineKey: null,
  resolutionSource: null,
  selfReferenceVerdict: null,
};

describe('buildSignalQueryRewrite', () => {
  it('returns null when every rewrite field is null', () => {
    expect(buildSignalQueryRewrite(BASE)).toBeNull();
  });

  it('returns a single field verbatim', () => {
    expect(buildSignalQueryRewrite({ ...BASE, surfaceType: 'wood floor' })).toBe('wood floor');
  });

  it('joins multiple fields in carriedProduct, productCategory, surfaceType, taskDescription order', () => {
    const out = buildSignalQueryRewrite({
      ...BASE,
      carriedProduct: 'Speedex',
      productCategory: 'floor stripper',
      surfaceType: 'VCT floor',
      taskDescription: 'strip and recoat',
    });
    expect(out).toBe('Speedex floor stripper VCT floor strip and recoat');
  });

  it('treats whitespace-only and empty-string fields as null', () => {
    const out = buildSignalQueryRewrite({
      ...BASE,
      carriedProduct: '   ',
      productCategory: '',
      surfaceType: 'wood floor',
    });
    expect(out).toBe('wood floor');
  });

  it('dedupes case-insensitively when two fields carry the identical value', () => {
    const out = buildSignalQueryRewrite({
      ...BASE,
      carriedProduct: 'VCT Floor Finish',
      productCategory: 'vct floor finish',
      surfaceType: 'VCT floor',
    });
    expect(out).toBe('VCT Floor Finish VCT floor');
  });

  it('trims surrounding whitespace on kept fields', () => {
    expect(buildSignalQueryRewrite({ ...BASE, taskDescription: '  strip and recoat  ' })).toBe(
      'strip and recoat',
    );
  });
});
