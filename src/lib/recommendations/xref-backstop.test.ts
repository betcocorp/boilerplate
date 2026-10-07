import { describe, expect, it } from 'vitest';

import type { XrefLatencyPolicy } from '~/lib/recommendations/recommend-cross-reference';
import {
  decideXrefBackstop,
  resolveXrefBackstopPolicy,
  XREF_BACKSTOP_MIN_BUDGET_MS,
} from '~/lib/recommendations/xref-backstop';

const POLICY: XrefLatencyPolicy = {
  totalBudgetMs: 25_000,
  webSearchBudgetMs: 12_000,
  enrichBudgetMs: 8_000,
  retrieveBudgetMs: 8_000,
  validateBudgetMs: 8_000,
};

describe('decideXrefBackstop (B0-355)', () => {
  it('does not fire when the model already called recommend_cross_reference', () => {
    expect(
      decideXrefBackstop({
        crossReferencePostProcessing: true,
        legacyMatch: null,
        modelCalledEngine: true,
      }),
    ).toEqual({ fired: false, reason: 'model_called_engine' });
  });

  it('fires when the legacy lookup produced nothing and the model skipped the engine', () => {
    expect(
      decideXrefBackstop({
        crossReferencePostProcessing: true,
        legacyMatch: null,
        modelCalledEngine: false,
      }),
    ).toEqual({ fired: true, reason: 'legacy_missing_model_skipped' });
  });

  it('fires when legacy matched but recommended a fallback (the B0-355 regression case)', () => {
    expect(
      decideXrefBackstop({
        crossReferencePostProcessing: true,
        legacyMatch: { fallbackRecommended: true },
        modelCalledEngine: false,
      }),
    ).toEqual({ fired: true, reason: 'legacy_fallback_recommended_model_skipped' });
  });

  it('does NOT fire on a confident legacy match — that path stays zero-web-spend', () => {
    expect(
      decideXrefBackstop({
        crossReferencePostProcessing: true,
        legacyMatch: { fallbackRecommended: false },
        modelCalledEngine: false,
      }),
    ).toEqual({ fired: false, reason: 'confident_legacy_match' });
  });

  it('does not fire on a turn that never touched cross-reference post-processing', () => {
    expect(
      decideXrefBackstop({
        crossReferencePostProcessing: false,
        legacyMatch: null,
        modelCalledEngine: false,
      }),
    ).toEqual({ fired: false, reason: 'not_cross_reference_turn' });
  });

  it('checks "model already called it" before the confident-legacy short circuit', () => {
    // Both conditions hold; the model's own call is the more specific fact and must win, so the
    // audit row never claims the backstop was skipped for a reason that did not apply.
    expect(
      decideXrefBackstop({
        crossReferencePostProcessing: true,
        legacyMatch: { fallbackRecommended: false },
        modelCalledEngine: true,
      }).reason,
    ).toBe('model_called_engine');
  });
});

describe('resolveXrefBackstopPolicy (B0-355 / B0-329)', () => {
  it('hands the backstop the REMAINING turn budget, not a fresh full one', () => {
    expect(resolveXrefBackstopPolicy(POLICY, 9_000).totalBudgetMs).toBe(16_000);
  });

  it('floors a nearly-exhausted budget instead of guaranteeing an instant timeout', () => {
    expect(resolveXrefBackstopPolicy(POLICY, 24_500).totalBudgetMs).toBe(
      XREF_BACKSTOP_MIN_BUDGET_MS,
    );
    expect(resolveXrefBackstopPolicy(POLICY, 90_000).totalBudgetMs).toBe(
      XREF_BACKSTOP_MIN_BUDGET_MS,
    );
  });

  it('never grants MORE than a model-initiated call would get', () => {
    expect(resolveXrefBackstopPolicy(POLICY, 0).totalBudgetMs).toBe(POLICY.totalBudgetMs);
    expect(resolveXrefBackstopPolicy(POLICY, -5_000).totalBudgetMs).toBe(POLICY.totalBudgetMs);
  });

  it('leaves the per-step ceilings alone (createStepGuard already clamps them)', () => {
    const resolved = resolveXrefBackstopPolicy(POLICY, 9_000);
    expect(resolved.webSearchBudgetMs).toBe(POLICY.webSearchBudgetMs);
    expect(resolved.enrichBudgetMs).toBe(POLICY.enrichBudgetMs);
    expect(resolved.retrieveBudgetMs).toBe(POLICY.retrieveBudgetMs);
    expect(resolved.validateBudgetMs).toBe(POLICY.validateBudgetMs);
  });
});
