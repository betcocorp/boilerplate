import type { z } from 'zod';

import {
  reportDataReadySchema,
  type ReportDataReady,
  type ReportGateFloor,
  type ReportGradingConfigData,
  type ReportMetricsData,
  type ReportSpeedRating,
} from './data-schemas';
import { GRADE_BANDS, type Grade } from './metrics';
import { formatScoringRules } from './render';
import { DEFAULT_SCORING_RULES, type ScoringRules } from './scoring-config';

/**
 * B0-834 — the executive one-pager's data contract and its pure helpers.
 *
 * The page at `/admin/tests/[testId]/runs/[runId]/exec` renders the same `ReportDataReady` the
 * detailed report is built from, minus `cases`: that array carries every ideal response and every
 * agent answer, and the one-pager never shows either, so it must not be serialized into the RSC
 * payload. Everything else passes through untouched.
 *
 * The two rules of `./data-schemas` apply unchanged: regulated values are printed verbatim, and
 * nothing here recomputes a grade, average or rate. The helpers below *count* rows and *tokenize*
 * prose — they never derive a number the metrics did not already state.
 */

export const reportExecSummarySchema = reportDataReadySchema.omit({ cases: true });
export type ReportExecSummaryData = z.infer<typeof reportExecSummarySchema>;

/** Drops `cases` and nothing else — a structural projection, not a re-parse. */
export function toExecSummaryData(ready: ReportDataReady): ReportExecSummaryData {
  const { cases, ...summary } = ready;
  // Read once so the lint rule sees the intent: `cases` is excluded on purpose, not forgotten.
  void cases;
  return summary;
}

/**
 * How many evaluated cases in each category missed a mandatory concept — the `†n` marker beside
 * the category name. A count of already-reported per-case facts (`mandatoryMissing`), keyed by the
 * category exactly as the ledger names it. Categories with no miss are absent, not zero.
 */
export function mandatoryMissingCountByCategory(
  metrics: Pick<ReportMetricsData, 'perCase'>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of metrics.perCase) {
    if (!row.mandatoryMissing) continue;
    counts[row.category] = (counts[row.category] ?? 0) + 1;
  }
  return counts;
}

/**
 * A case id as it appears in synthesis prose: a full UUID, or the 8-hex first segment the
 * synthesis model routinely shortens ids to (the same shorthand `render.ts` linkifies).
 */
const CASE_ID_MENTION_PATTERN =
  /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi;

export type ProseSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'case';
      /** The case id to link to — the known id when the mention resolved, else the mention itself. */
      id: string;
      /** The mention exactly as written in the prose. Never reformatted. */
      display: string;
    };

/**
 * Splits prose into text and case-id segments so a renderer can link each citation to its ledger
 * entry while leaving the surrounding text byte-for-byte as written.
 *
 * - A full UUID is always a citation (linked whether or not it is a known id — a UTE case has a
 *   ledger entry but is absent from `perCase`).
 * - An 8-hex token is a citation only when it is the prefix of exactly one known id. Ordinary
 *   8-digit numbers are valid hex, and an ambiguous prefix is not worth guessing at — both stay
 *   plain text.
 */
export function resolveCaseIdMentions(
  text: string,
  perCaseIds: readonly string[],
): ProseSegment[] {
  if (!text) return [];

  const byId = new Map<string, string>();
  const byPrefix = new Map<string, string[]>();
  for (const raw of perCaseIds) {
    const id = raw.trim();
    const lower = id.toLowerCase();
    if (!byId.has(lower)) byId.set(lower, id);
    const prefix = lower.slice(0, 8);
    const holders = byPrefix.get(prefix) ?? [];
    if (!holders.includes(id)) holders.push(id);
    byPrefix.set(prefix, holders);
  }

  const segments: ProseSegment[] = [];
  let cursor = 0;
  const pushText = (chunk: string) => {
    if (!chunk) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === 'text') last.text += chunk;
    else segments.push({ kind: 'text', text: chunk });
  };

  for (const match of text.matchAll(CASE_ID_MENTION_PATTERN)) {
    const mention = match[0];
    const start = match.index ?? 0;
    const lower = mention.toLowerCase();
    const isFullId = lower.includes('-');

    let resolved: string | null = null;
    if (isFullId) {
      resolved = byId.get(lower) ?? mention;
    } else {
      const holders = byPrefix.get(lower);
      if (holders && holders.length === 1) resolved = holders[0];
    }

    if (resolved == null) continue;

    pushText(text.slice(cursor, start));
    segments.push({ kind: 'case', id: resolved, display: mention });
    cursor = start + mention.length;
  }
  pushText(text.slice(cursor));

  return segments;
}

/**
 * B0-825 / B0-835 — the grading configuration as one plain-text line for the one-pager's header.
 * Mirrors the parts and order of `gradingConfigLine` (`./render`) without its Markdown italics, and
 * drops the spread threshold and judged thresholds — the one-pager states those beside the numbers
 * they govern. `passMark` mirrors the Markdown: omitted when the persisted state predates the
 * field. The concept rules are always stated: a report persisted before B0-835 was produced under
 * the shipped defaults, and says so rather than leaving the reader to assume it.
 */
export function formatGradingConfig(
  config: ReportGradingConfigData,
  strictPassMark: number,
): string {
  const parts = [
    `Graded by ${config.model}${config.effort ? ` at ${config.effort} effort` : ''}`,
    `${config.passes} independent pass${config.passes === 1 ? '' : 'es'}`,
    config.passMark != null ? `pass mark ${config.passMark} (strict ${strictPassMark})` : null,
    config.scoringRules
      ? formatScoringRules(config.scoringRules)
      : `${formatScoringRules(DEFAULT_SCORING_RULES)} (default)`,
    config.gradingPromptHash ? `grading prompt ${config.gradingPromptHash.slice(0, 12)}` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(' · ');
}

/**
 * B0-835 — the sentence under the category table's `†n` markers, minus the marker itself (the
 * renderer paints that in red). Written from the rules in force, so a report scored with the gate
 * or the ceiling off never claims a cap that did not happen — the same three states
 * `mandatoryMissingLegend` (`./case-concepts`) distinguishes, phrased for a per-category count.
 */
export function categoryMarkerLegend(rules: ScoringRules): string {
  if (!rules.minimalGate.enabled) {
    return 'the number of cases in that category that missed a mandatory concept — reported only; the mandatory gate is off for this report.';
  }
  if (!rules.minimalCeiling.enabled) {
    return 'the number of cases in that category rated Fail by the mandatory gate for missing a mandatory concept, whatever their score.';
  }
  return `the number of cases in that category capped at ${rules.minimalCeiling.score} (F, Fail) for missing a mandatory concept — each case's Pre-Gate Content Score is shown in the detailed report.`;
}

/**
 * B0-835 — the "Scoring rules:" clause of the one-pager's concept-coverage block (the skill's
 * `build_summary.js` line, rule for rule): which rules were in force and how many cases each one
 * actually moved, so a reader comparing two summaries can tell a change in the agent from a change
 * in the rules. Counts are read off `gateFloor`, never re-derived.
 */
export function scoringRulesSentence(rules: ScoringRules, gateFloor: ReportGateFloor): string {
  const gate = !rules.minimalGate.enabled
    ? 'mandatory gate OFF'
    : rules.minimalCeiling.enabled
      ? `a missing mandatory concept caps the score at ${rules.minimalCeiling.score} (F, Fail)`
      : 'a missing mandatory concept rates the case Fail (score cap off)';
  const floored = gateFloor.flooredIds.length;
  const floor = rules.minimalFloor.enabled
    ? `full mandatory coverage floors the score at ${rules.minimalFloor.score}${
        floored > 0 ? ` (raised ${floored} ${plural(floored, 'case')})` : ''
      }`
    : 'mandatory floor OFF';
  const lowered = gateFloor.coverageCappedIds.length;
  const coverage = rules.expectedCoverage.enabled
    ? `Completeness is capped at expected-concept coverage${
        lowered > 0 ? ` (lowered ${lowered} ${plural(lowered, 'case')})` : ''
      }`
    : 'expected-coverage cap OFF';
  // The agreement claim holds by construction only while the ceiling expresses the gate's verdict
  // in the score; without it a gated case can read "B / Fail" and the sentence would be false.
  const agree =
    rules.minimalGate.enabled && rules.minimalCeiling.enabled
      ? ' Score, grade and Result always agree.'
      : '';
  return `Scoring rules: ${gate}; ${floor}; ${coverage}.${agree}`;
}

/**
 * A 0–1 weight as a percentage string with binary-float noise removed (`0.3 * 100` is
 * `30.000000000000004` in JS). Weights are configuration, not regulated data; this prints the
 * configured value, it does not round it — `0.625` prints as `62.5`.
 */
export function weightPercent(weight: number): string {
  return String(Number((weight * 100).toPrecision(12)));
}

/** `6 excellent, 13 good, 1 slow` — every non-zero rating, in band order, lower-cased. */
export function formatRatingDistribution(
  distribution: ReadonlyArray<{ rating: ReportSpeedRating; count: number }>,
): string {
  return distribution
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.rating.toLowerCase()}`)
    .join(', ');
}

/**
 * Which letter grades pass and which fail at `passMark`, read off `GRADE_BANDS` — so the
 * "(A/B/C/D pass · F fail)" parenthetical is derived from the mark in force rather than assumed.
 * Returns null when the mark falls *inside* a band (e.g. 65 splits D), because then no letter
 * cleanly passes or fails and the parenthetical would be wrong either way.
 */
export function gradeBandsAtPassMark(passMark: number): { pass: Grade[]; fail: Grade[] } | null {
  const pass: Grade[] = [];
  const fail: Grade[] = [];
  for (let index = 0; index < GRADE_BANDS.length; index += 1) {
    const band = GRADE_BANDS[index];
    // A band spans [min, next-higher min); the top band is unbounded above.
    const upperExclusive = index === 0 ? Number.POSITIVE_INFINITY : GRADE_BANDS[index - 1].min;
    if (band.min >= passMark) pass.push(band.grade);
    else if (upperExclusive <= passMark) fail.push(band.grade);
    else return null;
  }
  return { pass, fail };
}

/** `case` / `cases`, `pass` / `passes` — the one-pager's only pluralization. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}
