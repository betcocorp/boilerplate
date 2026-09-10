import { describe, expect, it } from 'vitest';

import {
  CONCEPT_CHECK_MARKS,
  CONCEPT_MARKER_LEGEND,
  CONCEPT_MARKERS,
  conceptChecklist,
  formatConceptChecklistLine,
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

/**
 * B0-938 — the per-case concept checklist the ledger and the Markdown report both render. Both
 * surfaces call `conceptChecklist`, so these cases pin what a reader sees in either one.
 */
describe('conceptChecklist (B0-938)', () => {
  /** Regulated phrases — asserted back verbatim, never re-punctuated, re-cased or split. */
  const DILUTION = 'Dilute 1:64 (2 oz/gal), then dwell';
  const CONTACT = 'Keep the surface visibly wet for 10 minutes';
  const EPA = 'EPA Reg. No. 1839-95';

  it('returns every required concept in authored order, marked satisfied or missed', () => {
    expect(
      conceptChecklist({
        required: [DILUTION, CONTACT, EPA],
        satisfied: [CONTACT],
        missing: [DILUTION, EPA],
      }),
    ).toEqual([
      { phrase: DILUTION, met: false },
      { phrase: CONTACT, met: true },
      { phrase: EPA, met: false },
    ]);
  });

  it('emits phrases verbatim — regulated values survive byte-for-byte', () => {
    const entries = conceptChecklist({
      required: [DILUTION, EPA],
      satisfied: [DILUTION, EPA],
      missing: [],
    });
    expect(entries.map((entry) => entry.phrase)).toEqual([DILUTION, EPA]);
  });

  it('matches on identity key, so a re-cased or re-punctuated vote still counts as satisfied', () => {
    expect(
      conceptChecklist({
        required: [CONTACT],
        satisfied: ['keep the surface visibly wet for 10 minutes.'],
        missing: [],
      }),
    ).toEqual([{ phrase: CONTACT, met: true }]);
  });

  it('marks a phrase that reached neither bucket as missed rather than dropping it', () => {
    expect(conceptChecklist({ required: [DILUTION], satisfied: [], missing: [] })).toEqual([
      { phrase: DILUTION, met: false },
    ]);
  });

  it('is empty when the case specified no concepts of that kind', () => {
    expect(conceptChecklist({ required: [], satisfied: [], missing: [] })).toEqual([]);
  });

  it('renders a Markdown line per entry, quoting the phrase verbatim', () => {
    expect(formatConceptChecklistLine({ phrase: DILUTION, met: true })).toBe(
      `- ${CONCEPT_CHECK_MARKS.met} "${DILUTION}"`,
    );
    expect(formatConceptChecklistLine({ phrase: EPA, met: false })).toBe(
      `- ${CONCEPT_CHECK_MARKS.missed} "${EPA}"`,
    );
  });
});
