/**
 * B0-492 — the single `confidence` field on a product-support run is written by up to six
 * different mechanisms with nothing recording which one produced it:
 *   - `validator_judged` — the model-scored validator pass (`runValidatorPass`, `useValidator: true`).
 *   - `validator_bypassed_heuristic` — the regex-shaped constant `sources.length > 0 ? 0.9 : 0.6`
 *     (`useValidator` defaults `false` everywhere, including prod chat).
 *   - `decline_gate_constant` — the hardcoded `0.92`, `classifyEarlyDecline` path; terminates before
 *     any model call.
 *   - `agent_self_scored` — the answering agent's OWN self-reported confidence (B0-491), used as the
 *     recommendation gate's `baseConfidence` in place of the validator/heuristic value.
 *   - `gate_capped` — any of the usage/safety coverage cap, the regulated-claim guardrail cap, or the
 *     recommendation-gate's internal caps (low-similarity/missing-brand/category-mismatch) actually
 *     lowered the number. Always paired with `preCapValue`/`preCapProvenance` — the value and
 *     provenance the number HAD before that cap, so `gate_capped` never hides what was capped.
 *   - `unknown` — read-time-only label for a historical row that predates this field; the workflow
 *     itself never writes it.
 *
 * These roll into `test_results.avg_confidence`, which gates CI (`scripts/run-eval-gate.ts`) —
 * averaging a regex constant with a model judgment. This module is the single place that decides
 * provenance so every write site in `run-product-support-workflow.ts` uses the same rules.
 */

export const CONFIDENCE_PROVENANCES = [
  'validator_judged',
  'validator_bypassed_heuristic',
  'decline_gate_constant',
  'agent_self_scored',
  'gate_capped',
  'unknown',
] as const;

export type ConfidenceProvenance = (typeof CONFIDENCE_PROVENANCES)[number];

/**
 * B0-492 AC — "exclude non-judgment provenances from `avg_confidence`, or compute it per
 * provenance class". This module picks the first: only these two provenances reflect an actual
 * judgment (a model, human-calibrated pass scoring the specific answer) rather than a fixed
 * constant or a derived/capped number. `gate_capped` and `agent_self_scored` are deliberately
 * excluded — a capped value is definitionally not the judgment's own number, and the agent's
 * self-score, while model-produced, is an uncalibrated self-assessment the way the validator pass
 * is a calibrated third-party check (kept separate rather than conflated).
 */
export const JUDGMENT_CONFIDENCE_PROVENANCES: readonly ConfidenceProvenance[] = ['validator_judged'];

export function isJudgmentProvenance(provenance: ConfidenceProvenance | null | undefined): boolean {
  return provenance != null && JUDGMENT_CONFIDENCE_PROVENANCES.includes(provenance);
}

/** A confidence value together with the provenance mechanism that produced it. */
export type ConfidenceProvenanceState = {
  provenance: ConfidenceProvenance;
  /** The value BEFORE the most-recent cap, when `provenance === 'gate_capped'`; otherwise null. */
  preCapValue: number | null;
  /** The provenance BEFORE the most-recent cap, when `provenance === 'gate_capped'`; otherwise null. */
  preCapProvenance: ConfidenceProvenance | null;
};

/**
 * Applies one gate's cap to the running provenance state. A no-op (returns `state` unchanged) when
 * `newConfidence` did not actually go below `oldConfidence` — a gate that RAN but changed nothing is
 * not a capping event. When it did cap, only the FIRST cap in a chain records `preCapValue`/
 * `preCapProvenance` — later caps in the same run keep chaining `gate_capped` forward without
 * overwriting the original (pre-any-cap) judgment, so it stays recoverable no matter how many gates
 * touched the number afterward.
 */
export function applyConfidenceCap(
  state: ConfidenceProvenanceState,
  oldConfidence: number,
  newConfidence: number,
): ConfidenceProvenanceState {
  if (newConfidence >= oldConfidence) {
    return state;
  }
  return {
    provenance: 'gate_capped',
    preCapValue: state.preCapValue ?? oldConfidence,
    preCapProvenance: state.preCapProvenance ?? state.provenance,
  };
}

/** The `{ confidenceProvenance, confidencePreCapValue, confidencePreCapProvenance }` fragment for persistence. */
export function confidenceProvenanceFields(state: ConfidenceProvenanceState): {
  confidenceProvenance: ConfidenceProvenance;
  confidencePreCapValue: number | null;
  confidencePreCapProvenance: ConfidenceProvenance | null;
} {
  return {
    confidenceProvenance: state.provenance,
    confidencePreCapValue: state.preCapValue,
    confidencePreCapProvenance: state.preCapProvenance,
  };
}

/** `'unknown'` for a historical payload that predates this field — never defaulted to a judgment class. */
export function resolveConfidenceProvenance(
  provenance: ConfidenceProvenance | null | undefined,
): ConfidenceProvenance {
  return provenance ?? 'unknown';
}
