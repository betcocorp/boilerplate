import type { CriteriaGradingOutcome } from '~/lib/tests/criteria-schemas';

/**
 * B0-711 — the report's per-case concept judgment, sourced from grading the harness already did.
 *
 * The manual "agent-evaluation" skill grades each case against two concept sets
 * (`Minimal_Expected_Concepts` and `Expected_Key_Concepts`) and lets that coverage move the
 * case's Result. Our report never saw a per-concept verdict, so the gate could not be applied.
 * It does not need a new grader call: `~/lib/tests/runner.ts` already persists
 * `response_payload.criteriaGrading` for every item that carries `expected_criteria`.
 *
 * **The mapping (decided on B0-711, not inferred here):**
 *
 * - **mandatory** (`Minimal_Expected_Concepts`) = criteria with `tier === 1`. Tier 1 already
 *   means "must have — any tier-1 miss fails the item" (`~/lib/tests/criteria-schemas.ts`), so the
 *   gate inherits an existing, tested semantic instead of inventing a second one.
 * - **expected** (`Expected_Key_Concepts`) = the full criteria set (tiers 1, 2 and 3).
 * - **`materialIssue`** = any criterion with `match === 'exact'` whose verdict is `met === false`.
 *   `exact` is the opt-in deterministic substring check reserved for regulated values (dilution
 *   ratios, oz/gal, mL/L, ppm, contact times, CAS/EPA numbers) and is evaluated in code, never by
 *   a model — so a failed one is a *factual* miss on a regulated value, which is precisely the
 *   signal that must withhold an automatic Pass. It is never asked of the grader model.
 *
 * Because mandatory ⊆ expected by construction, "every expected concept satisfied" and "a
 * mandatory concept missing" cannot both be true for the same case. B0-714 asserts that as a
 * structural invariant rather than trusting it.
 *
 * Regulated-data rule: concept phrases are regulated free text. Every string below is copied by
 * reference from the persisted verdict — never parsed for numbers, rounded, unit-converted,
 * re-cased, truncated or re-punctuated.
 */

/** Required = satisfied ∪ missing, always. B0-714 asserts this per kind, per case. */
export type ConceptKindCoverage = {
  required: string[];
  satisfied: string[];
  missing: string[];
};

export type CaseConcepts = {
  /** Tier-1 criteria — the "must have" set the rating gate reads. */
  mandatory: ConceptKindCoverage;
  /** The full criteria set — full coverage is what can raise a Result to Pass. */
  expected: ConceptKindCoverage;
  /** A failed deterministic (`match: 'exact'`) check on a regulated value. Derived in code. */
  materialIssue: boolean;
  /** Names the failed concept(s) verbatim. Null exactly when `materialIssue` is false. */
  materialIssueNote: string | null;
};

/**
 * Splits a free-text concept column (`test_items.minimum_concepts` / `expected_concepts`) into
 * individual phrases.
 *
 * Separators are pipe, newline, bullet (`-`/`*`/`•`), numbered list (`1.` / `1)`) and semicolon —
 * **never the comma**, because concept phrases routinely contain one ("dilute at 2 oz/gal, then
 * dwell for 10 minutes"). Splitting on commas would shred a regulated phrase into fragments that
 * no longer say what the label says.
 *
 * Each phrase is returned verbatim apart from the separator itself and surrounding whitespace.
 */
export function splitConceptPhrases(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    // `m` so a bullet or numbered marker is recognised at the start of every line, not just the
    // start of the column.
    .split(/\r?\n|\||;|(?:^|\s)[-*•]\s+|(?:^|\s)\d+[.)]\s+/gm)
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);
}

function coverage(
  verdicts: ReadonlyArray<{ concept: string; met: boolean }>,
): ConceptKindCoverage {
  return {
    required: verdicts.map((v) => v.concept),
    satisfied: verdicts.filter((v) => v.met).map((v) => v.concept),
    missing: verdicts.filter((v) => !v.met).map((v) => v.concept),
  };
}

export type DeriveCaseConceptsParams = {
  /** `response_payload.criteriaGrading` for this item's latest attempt, already validated. */
  criteriaGrading: CriteriaGradingOutcome | null;
  /** `test_items.minimum_concepts` — the free-text fallback for the mandatory set. */
  minimumConcepts: string | null;
  /** `test_items.expected_concepts` — the free-text fallback for the expected set. */
  expectedConcepts: string | null;
};

/**
 * Builds the concept block for one case, or `undefined` when the case has none.
 *
 * `undefined` (rather than an empty block) is deliberate: a case with no concepts must leave every
 * concept rule a no-op and every downstream number bit-identical to the pre-B0-711 report. A blank
 * concept cell is missing data, not a failed case.
 */
export function deriveCaseConcepts(
  params: DeriveCaseConceptsParams,
): CaseConcepts | undefined {
  const verdicts = params.criteriaGrading?.verdicts ?? [];
  if (verdicts.length === 0) {
    /**
     * Fallback path: the item has no `expected_criteria`, so nothing graded it per concept. The
     * free-text columns can be split into required phrases (`splitConceptPhrases`) but there are
     * no verdicts to say which of them the answer satisfied, and satisfaction cannot be inferred
     * from a rubric sub-score without fabricating a per-concept judgment. `required` on its own is
     * not a usable concept block — it would make every coverage read "0 of N satisfied" and gate
     * every legacy case — so the case gets no block at all.
     */
    return undefined;
  }

  const exactMisses = verdicts.filter((v) => v.match === 'exact' && !v.met);

  return {
    mandatory: coverage(verdicts.filter((v) => v.tier === 1)),
    expected: coverage(verdicts),
    materialIssue: exactMisses.length > 0,
    materialIssueNote:
      exactMisses.length > 0
        ? `Exact-match check failed on ${exactMisses.length === 1 ? 'a regulated value' : 'regulated values'}: ${exactMisses
            .map((v) => `"${v.concept}"`)
            .join(', ')}.`
        : null,
  };
}

/**
 * B0-713 — the two marks the "Results at a glance" table and the ledger rows carry, defined once
 * so the Markdown document and the React ledger cannot label the same case differently.
 */
export const CONCEPT_MARKERS = {
  /** The concept gate constrained this case's Result. */
  ratingConstrained: '†',
  /** Full expected coverage raised this case's Result to Pass. */
  autoPass: '‡',
} as const;

export const CONCEPT_MARKER_LEGEND = {
  ratingConstrained: `${CONCEPT_MARKERS.ratingConstrained} Rating constrained by a missing mandatory concept.`,
  autoPass: `${CONCEPT_MARKERS.autoPass} Automatic Pass on full expected-concept coverage.`,
} as const;

/** The marks for one rated case, in a stable order. Empty string when neither rule applied. */
export function conceptMarkers(flags: {
  ratingConstrained: boolean;
  autoPassTriggered: boolean;
}): string {
  return (
    (flags.ratingConstrained ? CONCEPT_MARKERS.ratingConstrained : '') +
    (flags.autoPassTriggered ? CONCEPT_MARKERS.autoPass : '')
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
