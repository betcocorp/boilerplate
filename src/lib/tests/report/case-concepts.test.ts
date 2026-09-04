import { describe, expect, it } from 'vitest';

import {
  CONCEPT_MARKER_LEGEND,
  CONCEPT_MARKERS,
  mandatoryMissingLegend,
} from './case-concepts';
import { DEFAULT_SCORING_RULES, type ScoringRules } from './scoring-config';

/**
 * B0-835 — the † legend is written from the rules a report was actually scored under, so the
 * Markdown document, the React ledger and the executive summary can never claim a cap that did
 * not happen. Three variants, one per rule state that changes the sentence.
 */
describe('mandatoryMissingLegend', () => {
  it('states the cap at the configured ceiling when the gate and the ceiling are on', () => {
    expect(mandatoryMissingLegend(DEFAULT_SCORING_RULES)).toBe(
      `${CONCEPT_MARKERS.mandatoryMissing} Missing a must-have (mandatory) concept — the score is capped at 59 (grade F, Fail); the case shows its Pre-Gate Content Score.`,
    );
    const lower: ScoringRules = {
      ...DEFAULT_SCORING_RULES,
      minimalCeiling: { enabled: true, score: 49 },
    };
    expect(mandatoryMissingLegend(lower)).toContain('capped at 49 (grade F, Fail)');
  });

  it('never claims a cap when the ceiling is off', () => {
    const rules: ScoringRules = {
      ...DEFAULT_SCORING_RULES,
      minimalCeiling: { enabled: false, score: 59 },
    };
    expect(mandatoryMissingLegend(rules)).toBe(
      `${CONCEPT_MARKERS.mandatoryMissing} Missing a must-have (mandatory) concept — rated Fail by the mandatory gate whatever its score.`,
    );
  });

  it('says reported only when the gate is off, whatever the ceiling setting', () => {
    const rules: ScoringRules = { ...DEFAULT_SCORING_RULES, minimalGate: { enabled: false } };
    expect(mandatoryMissingLegend(rules)).toBe(
      `${CONCEPT_MARKERS.mandatoryMissing} Missing a must-have (mandatory) concept — reported only; the mandatory gate is off for this report.`,
    );
  });

  it('keeps the default legend equal to the legend at the shipped defaults', () => {
    expect(CONCEPT_MARKER_LEGEND.mandatoryMissing).toBe(
      mandatoryMissingLegend(DEFAULT_SCORING_RULES),
    );
  });
});
