import type { CaseConcepts, ConceptKindCoverage } from './schemas';
import { DEFAULT_SCORING_RULES, type ScoringRules } from './scoring-config';

export type { CaseConcepts, ConceptKindCoverage };

/**
 * B0-809 — concept blocks come only from the golden concept columns.
 *
 * The grader judges each phrase of `test_items.minimum_concepts` (mandatory) and
 * `test_items.expected_concepts` (expected) semantically on every pass and authors the
 * `CaseConcepts` block persisted on its `CaseScore` (`./schemas`). Nothing in this module reads a
 * response or infers a verdict: it holds the deterministic text handling around those columns —
 * how two spellings of one phrase are recognised as the same phrase when passes vote — and the
 * marks the report prints. The former fallback that derived a block from the harness's
 * `criteriaGrading` is gone by decision (Tom Bird, 2026-09-03): an item without concept columns has
 * no concept data, and the report says so rather than inventing any.
 *
 * B0-933 — both columns are `text[]` in the database now, one phrase per element, so the report
 * reads them straight through. `splitConcepts` below is **no longer part of the DB read path**.
 *
 * Regulated-data rule: concept phrases are regulated free text. Every phrase is copied by
 * reference and re-emitted verbatim — never parsed for numbers, rounded, unit-converted, re-cased
 * or truncated. `normConcept` produces an *identity key* for set math only; the key is never shown.
 */

/** Cells that mean "no concepts of this kind were specified" — the reference splitter's set. */
const EMPTY_CELL_MARKERS = new Set(['n/a', 'na', 'none', '-', '—']);

/**
 * A leading list marker: `-`, `*`, `•`, `‣`, `▪`, `·`, a lone `o`, `1.` / `1)` / `(1)`, or `a.` /
 * `a)`. Ported from the reference `concept_rules.py` `_BULLET` pattern, including its
 * case-insensitivity.
 */
const BULLET = /^\s*(?:[-*•‣▪·o]|\(?\d+[.)]|[a-z][.)])\s+/i;

/**
 * **The CSV-cell splitter — not the database reader (B0-933).**
 *
 * `test_items.minimum_concepts` / `expected_concepts` are `text[]` columns, already one phrase per
 * element, and the report path reads them straight through. This function exists for the one place
 * a concept list still arrives as a single free-text cell: an imported CSV (or the equivalent
 * manual-entry field), where the author types every phrase into one cell. Call it on a *cell*;
 * never on a value that came out of the database.
 *
 * A line-for-line port of the reference skill's `split_concepts`, so an imported cell yields the
 * exact phrases the reference grader would see. Deterministic text structure only. **Pipe is the
 * primary delimiter**, per line; newlines split; list markers are stripped; a **semicolon splits
 * only when nothing else delimited the cell**; commas never split (a phrase routinely contains
 * one: "dilute 2 oz/gal, then dwell"). An empty cell, or one holding only an empty-cell marker,
 * yields `[]` — no concepts of that kind, which is not a failure.
 */
export function splitConcepts(cell: string | null | undefined): string[] {
  if (cell == null) return [];
  const text = String(cell).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text || EMPTY_CELL_MARKERS.has(text.toLowerCase())) return [];

  let parts: string[] = [];
  for (const line of text.split('\n')) {
    parts.push(...(line.includes('|') ? line.split('|') : [line]));
  }
  // Semicolons only when nothing else delimited the cell. This does split a lone phrase that
  // happens to contain a semicolon — accepted, as in the reference, because pipes and newlines take
  // precedence and the split is checked before grading.
  if (parts.length === 1 && text.includes(';')) {
    parts = text.split(';');
  }

  const out: string[] = [];
  for (const raw of parts) {
    const phrase = raw.replace(BULLET, '').trim().replace(/^;+|;+$/g, '').trim();
    if (phrase) out.push(phrase);
  }
  return out;
}

/**
 * Identity key for a concept phrase — for set math and cross-pass voting only, never displayed.
 * Port of the reference `norm_concept`: NFKD, combining marks stripped, lower-cased, every
 * non-alphanumeric run collapsed to one space.
 */
export function normConcept(phrase: string | null | undefined): string {
  if (phrase == null) return '';
  return String(phrase)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when the case lists at least one must-have concept the answer did not communicate. */
export function hasMandatoryMiss(concepts: CaseConcepts | null | undefined): boolean {
  return (concepts?.mandatory.missing.length ?? 0) > 0;
}

/**
 * B0-813 / B0-835 — the marks the "Results at a glance" table and the ledger rows carry, defined
 * once so the Markdown document and the React ledger cannot label the same case differently.
 *
 * † says the answer missed a must-have concept. Under B0-835 that is no longer a merely reported
 * fact: the mandatory gate rates the case Fail and the mandatory ceiling caps its score, so the
 * mark now says "the score you are reading is a capped one" (methodology §9).
 */
export const CONCEPT_MARKERS = {
  mandatoryMissing: '†',
} as const;

/**
 * B0-835 — the † legend, written from the rules the report was actually scored under, so a report
 * generated with the gate or the ceiling off never claims a cap that did not happen.
 */
export function mandatoryMissingLegend(rules: ScoringRules): string {
  const marker = CONCEPT_MARKERS.mandatoryMissing;
  const subject = `${marker} Missing a must-have (mandatory) concept`;
  if (!rules.minimalGate.enabled) {
    return `${subject} — reported only; the mandatory gate is off for this report.`;
  }
  if (!rules.minimalCeiling.enabled) {
    return `${subject} — rated Fail by the mandatory gate whatever its score.`;
  }
  return `${subject} — the score is capped at ${rules.minimalCeiling.score} (grade F, Fail); the case shows its Pre-Gate Content Score.`;
}

/**
 * The legend at the shipped defaults. Kept for callers with no `ScoringRules` to hand; anything
 * rendering a specific report should call `mandatoryMissingLegend(metrics.scoringRules)` instead.
 */
export const CONCEPT_MARKER_LEGEND = {
  mandatoryMissing: mandatoryMissingLegend(DEFAULT_SCORING_RULES),
} as const;

/**
 * B0-932/B0-933 — how the must-have list is labelled wherever a report states a case's expectation
 * of behaviour. It replaces the retired `expected_should_answer` line: the run-time pass/fail axis
 * is mandatory concept coverage, so the must-have phrases *are* the behavioural expectation.
 * Defined once so the Markdown document and the React ledger cannot word it differently.
 */
export const MANDATORY_CONCEPTS_LABEL = 'Must-have concepts (the pass/fail axis)';

/** What that line says when the case lists no must-haves — stated, never left blank. */
export const NO_MANDATORY_CONCEPTS_NOTE = 'none recorded — no must-have concept gates this case.';

/**
 * B0-721 — this case's independent grading passes disagreed and a human should look at the grade.
 * Distinct from † on purpose, and appended after it so a case can honestly carry both.
 */
export const REVIEW_MARKER = '⚑';

export const REVIEW_MARKER_LEGEND = `${REVIEW_MARKER} Flagged for human review — the independent grading passes disagreed.`;

/** Every mark one case carries, concept mark first. Empty string when nothing applies. */
export function caseMarkers(flags: { mandatoryMissing: boolean; reviewFlagged?: boolean }): string {
  return (
    (flags.mandatoryMissing ? CONCEPT_MARKERS.mandatoryMissing : '') +
    (flags.reviewFlagged ? REVIEW_MARKER : '')
  );
}

/** The one-line coverage readout, e.g. `Mandatory 2/3 · Expected 4/6`. */
export function formatConceptCoverage(concepts: CaseConcepts): string {
  const mandatory = concepts.mandatory;
  const expected = concepts.expected;
  return `Mandatory ${mandatory.satisfied.length}/${mandatory.required.length} · Expected ${expected.satisfied.length}/${expected.required.length}`;
}

/** Concept phrases joined for display, each quoted, always verbatim. */
export function formatConceptList(concepts: readonly string[]): string {
  return concepts.map((concept) => `"${concept}"`).join(', ');
}
