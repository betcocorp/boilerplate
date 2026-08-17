import { describe, expect, it } from 'vitest';

import {
  applyConfidenceCap,
  confidenceProvenanceFields,
  isJudgmentProvenance,
  resolveConfidenceProvenance,
  type ConfidenceProvenanceState,
} from '~/lib/workflows/product-support/confidence-provenance';

function state(provenance: ConfidenceProvenanceState['provenance']): ConfidenceProvenanceState {
  return { provenance, preCapValue: null, preCapProvenance: null };
}

describe('applyConfidenceCap (B0-492)', () => {
  it('is a no-op when the gate ran but did not actually lower the value', () => {
    const s = state('validator_judged');
    const result = applyConfidenceCap(s, 0.8, 0.8);
    expect(result).toBe(s); // same reference — genuinely unchanged
  });

  it('is a no-op when the "new" value is higher than the old one', () => {
    const s = state('validator_bypassed_heuristic');
    expect(applyConfidenceCap(s, 0.6, 0.9)).toBe(s);
  });

  it('records the pre-cap value and provenance on the first cap', () => {
    const s = state('validator_judged');
    const result = applyConfidenceCap(s, 0.85, 0.55);
    expect(result).toEqual({
      provenance: 'gate_capped',
      preCapValue: 0.85,
      preCapProvenance: 'validator_judged',
    });
  });

  it('chains a second cap without overwriting the original pre-cap value/provenance', () => {
    const first = applyConfidenceCap(state('validator_bypassed_heuristic'), 0.9, 0.55);
    const second = applyConfidenceCap(first, 0.55, 0.4);

    expect(second).toEqual({
      provenance: 'gate_capped',
      // Still the ORIGINAL judgment, not the intermediate 0.55.
      preCapValue: 0.9,
      preCapProvenance: 'validator_bypassed_heuristic',
    });
  });

  it('preserves agent_self_scored as the recoverable pre-cap provenance', () => {
    const result = applyConfidenceCap(state('agent_self_scored'), 0.62, 0.2);
    expect(result).toEqual({
      provenance: 'gate_capped',
      preCapValue: 0.62,
      preCapProvenance: 'agent_self_scored',
    });
  });
});

describe('confidenceProvenanceFields / resolveConfidenceProvenance (B0-492)', () => {
  it('shapes the persistence fragment from a state', () => {
    const capped = applyConfidenceCap(state('validator_judged'), 0.9, 0.4);
    expect(confidenceProvenanceFields(capped)).toEqual({
      confidenceProvenance: 'gate_capped',
      confidencePreCapValue: 0.9,
      confidencePreCapProvenance: 'validator_judged',
    });
  });

  it('shapes an uncapped state with null pre-cap fields', () => {
    expect(confidenceProvenanceFields(state('decline_gate_constant'))).toEqual({
      confidenceProvenance: 'decline_gate_constant',
      confidencePreCapValue: null,
      confidencePreCapProvenance: null,
    });
  });

  it('resolves a missing provenance to "unknown", never a judgment class', () => {
    expect(resolveConfidenceProvenance(undefined)).toBe('unknown');
    expect(resolveConfidenceProvenance(null)).toBe('unknown');
    expect(resolveConfidenceProvenance('validator_judged')).toBe('validator_judged');
  });
});

describe('isJudgmentProvenance (B0-492)', () => {
  it('is true only for validator_judged', () => {
    expect(isJudgmentProvenance('validator_judged')).toBe(true);
    expect(isJudgmentProvenance('validator_bypassed_heuristic')).toBe(false);
    expect(isJudgmentProvenance('decline_gate_constant')).toBe(false);
    expect(isJudgmentProvenance('agent_self_scored')).toBe(false);
    expect(isJudgmentProvenance('gate_capped')).toBe(false);
    expect(isJudgmentProvenance('unknown')).toBe(false);
    expect(isJudgmentProvenance(null)).toBe(false);
    expect(isJudgmentProvenance(undefined)).toBe(false);
  });
});
