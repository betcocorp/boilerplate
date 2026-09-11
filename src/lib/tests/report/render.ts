import type { TestRecord, TestResultRecord } from '~/lib/tests/types';

import {
  caseMarkers,
  conceptChecklist,
  formatConceptChecklistLine,
  formatConceptCoverage,
  formatConceptList,
  MANDATORY_CONCEPTS_LABEL,
  mandatoryMissingLegend,
  NO_MANDATORY_CONCEPTS_NOTE,
  REVIEW_MARKER_LEGEND,
} from './case-concepts';
import {
  CONCEPT_DISAGREEMENT_LABELS,
  VARIANCE_CAUSE_LABELS,
  type CaseGradingVariance,
  type ConceptDisagreement,
  type VarianceCause,
} from './consolidate';
import { formatExpectedSourceRefs, type ExpectedSourceRef } from './expected-sources';
import { normalizeAgentMarkdownLists } from './markdown-normalize';
import type {
  CaseSpeed,
  ConsistencyRollup,
  EvaluatedCase,
  RateBlock,
  ReportMetrics,
  SpeedMetricAggregate,
} from './metrics';
import type { CaseScore, ReportGradingConfig, ReportSynthesis } from './schemas';
import { DEFAULT_SCORING_RULES, type ScoringRules } from './scoring-config';
import {
  P90_MIN_N,
  P90_UNAVAILABLE_LABEL,
  SPEED_METRIC_LABELS,
  SPEED_METRICS,
} from './speed-rules';

/**
 * Renders the "agent-evaluation" methodology's two Word documents (executive summary + detailed
 * page-by-page report) as a single combined Markdown document (B0-453) — exec scorecard/tables/
 * Top-3/assessment first, full case-by-case detail below. Every number here comes from
 * `ReportMetrics` (never re-derived), so the summary and the detail can never disagree.
 */

export type CaseHarnessAside = {
  passed: boolean | null;
  status: string | null;
  similarity: number | null;
  /**
   * B0-863 — `test_result_items.answer_provenance` (generated from
   * `response_payload.answerProvenance`): which stage produced the final answer text (e.g.
   * `model_generated`, `validator_fallback`, `regulated_claim_partial_redaction`). Reported for
   * reference beside the harness signal, never part of the grade.
   */
  answerProvenance: string | null;
  /** B0-863 — `test_result_items.routing_decision`. */
  routingDecision: string | null;
  /**
   * B0-863 — gates that actually acted this turn (`state: 'ran'` with a `verdict` other than
   * `'passed'`), e.g. `{ name: 'regulatedClaimGuardrail', verdict: 'rejected' }`. Empty when none
   * fired or the run predates gate activation instrumentation.
   */
  gates: { name: string; verdict: string }[];
  /**
   * B0-863 — true when `response_payload.draftAnswer` is present and differs from the final
   * response text, i.e. the validator/revision pass rewrote or discarded the model's first draft.
   */
  draftDiscarded: boolean;
  /** B0-863 — retrieved chunks this turn, before document-level de-duplication. */
  chunkCount: number;
};

export type CaseRenderDetail = {
  id: string;
  question: string;
  tier: string;
  priorityRaw: number | null;
  category: string;
  idealResponse: string | null;
  /** B0-933 — `test_items.expected_concepts`, one phrase per element. Printed verbatim. */
  expectedConcepts: readonly string[];
  /** B0-933 — `test_items.minimum_concepts`: the must-haves, and the run-time pass/fail axis. */
  minimumConcepts: readonly string[];
  /** B0-933 — `test_items.expected_sources` resolved to `rag.document` titles. */
  expectedSources: readonly ExpectedSourceRef[];
  actual: string;
  score: CaseScore;
  /** B0-717 — null when this case recorded no timing at all. Read, never re-derived. */
  speed: CaseSpeed | null;
  /** B0-720 — null for a single-pass case, which is every case of a single-pass run. */
  variance: CaseGradingVariance | null;
  harness: CaseHarnessAside | null;
};

/**
 * The DOM anchor id a case's "Detailed results — case by case" heading blockquote is given (see
 * `RunReportView`'s `blockquote` override, which assigns this same id to any case heading whose
 * text contains a case id). Shared here so server-rendered links and the client-side anchor can
 * never drift apart.
 */
export function caseAnchorId(caseId: string): string {
  return `case-${caseId.trim().toLowerCase()}`;
}

/** A case id rendered as a Markdown link back to its "Detailed results" entry. */
function idLink(caseId: string): string {
  return `[${caseId}](#${caseAnchorId(caseId)})`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The synthesis LLM is instructed to "cite case IDs" in its free-text findings, and routinely
 * shortens a cited id to just its first 8 hex characters (the UUID's first segment) rather than
 * the full id. This turns every such mention — full or shortened — into a Markdown link back to
 * that case's entry in "Detailed results — case by case", so a reader can jump straight there.
 */
function linkifyCaseIds(text: string, caseIds: string[]): string {
  if (!text) return text;

  const candidates = new Map<string, string>();
  for (const id of caseIds) {
    candidates.set(id.toLowerCase(), id);
    candidates.set(id.slice(0, 8).toLowerCase(), id);
  }
  if (candidates.size === 0) return text;

  // Longest literal first so a full UUID is matched whole rather than only its 8-char prefix.
  const literals = [...candidates.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`\\b(${literals.map(escapeRegExp).join('|')})\\b`, 'gi');

  return text.replace(pattern, (match) => {
    const id = candidates.get(match.toLowerCase());
    return id ? `[${match}](#${caseAnchorId(id)})` : match;
  });
}

function mdCell(value: string | null | undefined): string {
  if (!value) return '—';
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || '—';
}

function mdBlock(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : '_(none noted)_';
}

/**
 * True when the case records any expectation at all. Shared with the React ledger (B0-590 keeps the
 * two renderings identical), which is why it is exported rather than inlined.
 */
export function hasExpectation(c: {
  idealResponse: string | null;
  expectedConcepts: readonly string[];
  minimumConcepts: readonly string[];
  expectedSources: readonly { id: string }[];
}): boolean {
  return Boolean(
    c.idealResponse ||
      c.expectedConcepts.length > 0 ||
      c.minimumConcepts.length > 0 ||
      c.expectedSources.length > 0,
  );
}

/**
 * B0-933 — the expectation block. `expectedShouldAnswer` is gone: the run-time pass/fail axis is
 * mandatory concept coverage (B0-932), so the must-have list *is* the behavioural expectation and
 * is labelled as such. A case that records some expectation but no must-haves says so explicitly
 * rather than leaving the reader to guess whether the axis is absent or merely unprinted.
 *
 * Phrases and document titles are emitted verbatim — they carry dilution ratios, contact times and
 * EPA registration numbers.
 */
function formatExpected(c: CaseRenderDetail): string {
  if (!hasExpectation(c)) return '_(no expected answer recorded)_';

  const parts: string[] = [];
  if (c.idealResponse) parts.push(normalizeAgentMarkdownLists(c.idealResponse.trim()));
  if (c.expectedConcepts.length > 0) {
    parts.push(`**Expected concepts:** ${formatConceptList(c.expectedConcepts)}`);
  }
  parts.push(
    `**${MANDATORY_CONCEPTS_LABEL}:** ${
      c.minimumConcepts.length > 0
        ? formatConceptList(c.minimumConcepts)
        : NO_MANDATORY_CONCEPTS_NOTE
    }`,
  );
  if (c.expectedSources.length > 0) {
    parts.push(`**Expected sources:** ${formatExpectedSourceRefs(c.expectedSources)}`);
  }
  return parts.join('\n\n');
}

/**
 * B0-718 — the one line of speed a case gets, and the reason it is a *sentence* rather than a
 * column: it sits below the score table, never inside it, so nothing here can be read as part of
 * the content grade. Rating words are printed verbatim (never mapped onto A–F), and every number
 * comes off `metrics.speed`, which is where it was rounded.
 */
function caseSpeedLine(speed: CaseSpeed): string {
  const parts = SPEED_METRICS.map((metric) => {
    const m = metric === 'ttft' ? speed.ttft : speed.total;
    if (!m) return null;
    return `${SPEED_METRIC_LABELS[metric]} ${m.seconds} s — ${m.score}/100 (${m.band})`;
  }).filter((part): part is string => part !== null);

  parts.push(`Speed Performance Score ${speed.score}/100 (${speed.rating})`);
  if (speed.basis !== 'combined') {
    const measured = speed.basis === 'ttft_only' ? 'ttft' : 'total';
    const absent = speed.basis === 'ttft_only' ? 'total' : 'ttft';
    parts.push(
      `scored from ${SPEED_METRIC_LABELS[measured]} alone — no ${SPEED_METRIC_LABELS[absent]} was recorded`,
    );
  }

  return `**Speed (reported separately; not part of the content grade):** ${parts.join(' · ')}`;
}

/** One row of the per-metric speed table. `p90Label` already carries the `n/a` sentinel. */
function speedMetricRow(aggregate: SpeedMetricAggregate, unit: string): string {
  return `| ${aggregate.label} | ${aggregate.n} | ${aggregate.avgSeconds} ${unit} | ${aggregate.medianSeconds} ${unit} | ${aggregate.p90Label} | ${aggregate.minSeconds}–${aggregate.maxSeconds} ${unit} | ${aggregate.avgScore} | ${aggregate.bands.good} / ${aggregate.bands.acceptable} / ${aggregate.bands.slow} |`;
}

/**
 * B0-721 — one split concept judgment, named the way both renderers name it. Phrases are quoted
 * verbatim: they are regulated free text and carry dilution ratios, contact times and EPA numbers.
 */
function conceptDisagreementText(d: ConceptDisagreement): string {
  const label = CONCEPT_DISAGREEMENT_LABELS[d.kind];
  const subject = d.concept ? `${label} ${formatConceptList([d.concept])}` : label;
  return `${subject} (${d.votesFor} of ${d.voters} passes)`;
}

/** The causes of one flag, in the fixed `VARIANCE_CAUSES` order, with the concept detail spelled out. */
function varianceCauseText(
  causes: readonly VarianceCause[],
  disagreements: readonly ConceptDisagreement[],
): string {
  return causes
    .map((cause) =>
      cause === 'concept' && disagreements.length > 0
        ? `${VARIANCE_CAUSE_LABELS.concept}: ${disagreements.map(conceptDisagreementText).join('; ')}`
        : VARIANCE_CAUSE_LABELS[cause],
    )
    .join(' · ');
}

/**
 * `58 / 62 / 60`, with a pass that could not evaluate shown as `n/a` rather than as a zero.
 * Slash-separated rather than `·`, because the sentence around it already separates its clauses
 * with `·` and a reader must be able to see where the list of passes ends.
 */
function passOverallsText(overalls: ReadonlyArray<number | null>): string {
  return overalls.map((overall) => (overall == null ? 'n/a' : String(overall))).join(' / ');
}

/**
 * The per-case spread readout, in the detailed ledger only (B0-721): the reviewer looking at a
 * flagged case needs to see the passes that produced the flag, not just that there was one.
 */
function caseVarianceLine(variance: CaseGradingVariance): string {
  const parts = [
    `${variance.passes} independent passes`,
    `overalls ${passOverallsText(variance.passOveralls)}`,
    variance.range == null ? null : `range ${variance.range}`,
  ].filter((part): part is string => part !== null);

  // B0-835 — a floor that bound on a pass is a review signal in its own right, whether or not the
  // spread flagged the case: full must-have coverage weighting below a C means that pass's
  // sub-scores and its concept verdicts disagree.
  if (variance.floorApplied.length > 0) {
    parts.push(
      `the mandatory floor raised the score of ${variance.floorApplied
        .map((entry) => `pass ${entry.pass} (${entry.weighted} → ${entry.floor})`)
        .join(', ')}`,
    );
  }

  if (variance.flagged) {
    parts.push(
      `flagged for human review — ${varianceCauseText(variance.causes, variance.conceptDisagreements)}`,
    );
  }

  return `**Grading consistency:** ${parts.join(' · ')}`;
}

/** One row of the human-review queue. Every value is read off `metrics.consistency`. */
function consistencyQueueRow(entry: ConsistencyRollup['queue'][number]): string {
  return `| ${idLink(entry.id)} | ${mdCell(entry.question)} | ${passOverallsText(entry.passOveralls)} | ${entry.range ?? '—'} | ${mdCell(varianceCauseText(entry.causes, entry.conceptDisagreements))} |`;
}

function rateRow(name: string, block: RateBlock): string {
  return `| ${mdCell(name)} | ${block.n} | ${block.avg ?? '—'} | ${block.grade} | ${block.passPct}% | ${block.failPct}% |`;
}

function bulletList(items: string[]): string {
  if (items.length === 0) return '- _(none noted)_';
  return items.map((item) => `- ${item}`).join('\n');
}

function tierRank(label: string): number {
  const match = /tier\s*(\d+)/i.exec(label);
  return match ? Number(match[1]) : 99;
}

/** Tier 1 first, then 2+, "Unspecified" last; stable by original order within a tier. */
export function orderCasesByTier<T extends { tier: string }>(cases: T[]): T[] {
  return cases
    .map((c, index) => [c, index] as const)
    .sort((a, b) => tierRank(a[0].tier) - tierRank(b[0].tier) || a[1] - b[1])
    .map(([c]) => c);
}

/**
 * B0-835 — the four concept rules in force, in one phrase, shared by the Markdown grading-config
 * line and the React "Graded with" block so the two can never state different rules.
 *
 * A rule that is off says `off` rather than being omitted: a reader comparing two reports has to be
 * able to see whether a number moved because the agent changed or because a rule was switched.
 */
export function formatScoringRules(rules: ScoringRules): string {
  return [
    rules.minimalCeiling.enabled ? `ceiling ${rules.minimalCeiling.score}` : 'ceiling off',
    rules.minimalFloor.enabled
      ? `floor ${rules.minimalFloor.score}${rules.minimalFloor.respectMaterialIssue ? ' (withheld on material issue)' : ''}`
      : 'floor off',
    rules.expectedCoverage.enabled ? 'coverage cap on' : 'coverage cap off',
    rules.minimalGate.enabled ? 'gate on' : 'gate off',
  ].join(' · ');
}

/** B0-825 / B0-835 — the one-line statement of what a report was graded with. */
export function gradingConfigLine(config: ReportGradingConfig, strictPassMark: number): string {
  const parts = [
    `Graded by ${config.model}${config.effort ? ` at ${config.effort} effort` : ''}`,
    `${config.passes} independent pass${config.passes === 1 ? '' : 'es'}`,
    config.spreadThreshold != null ? `spread threshold ${config.spreadThreshold}` : null,
    config.passMark != null ? `pass mark ${config.passMark} (strict ${strictPassMark})` : null,
    // A report generated before B0-835 persisted no rules; it was produced under the shipped
    // defaults, and says so rather than leaving the reader to assume it.
    config.scoringRules
      ? formatScoringRules(config.scoringRules)
      : `${formatScoringRules(DEFAULT_SCORING_RULES)} (default)`,
    config.judgedThresholds
      ? `judged thresholds sim ≥ ${config.judgedThresholds.simHigh} high / < ${config.judgedThresholds.simLow} low · review ≤ ${config.judgedThresholds.lowConfidence} confidence`
      : null,
    config.gradingPromptHash ? `grading prompt ${config.gradingPromptHash.slice(0, 12)}` : null,
  ].filter((part): part is string => part !== null);
  return `_${parts.join(' · ')}._`;
}

/**
 * B0-835 — the concept rules as the "Methodology & scoring" section states them, written from the
 * rules actually in force so a report generated with one switched off says so rather than
 * describing behaviour it never applied.
 *
 * The order is the one `deriveCaseScoreline` runs (methodology §2b Rule 4 step 7); the ceiling is
 * last because it outranks the floor and the automatic Pass both.
 */
function conceptRuleLines(rules: ScoringRules): string[] {
  return [
    rules.expectedCoverage.enabled
      ? '- **Completeness is capped at expected-concept coverage** — `min(judged, 100 × satisfied ÷ required)`. Missing expected content lowers the grade proportionally rather than sitting beside it as a note, and where the cap binds the case shows both numbers ("40 (judged 66)").'
      : "- **The expected-coverage cap on Completeness is off for this report** — Completeness is the grader's holistic judgment alone.",
    '- **The four sub-scores are then weighted** 40 / 30 / 20 / 10.',
    rules.minimalFloor.enabled
      ? `- **Satisfying every mandatory concept floors the score at ${rules.minimalFloor.score}** — a C, because the must-have content was delivered${rules.minimalFloor.respectMaterialIssue ? ', unless the grader flagged a material factual issue, which withholds the floor' : ''}. It only ever raises a score, and in a healthy run it binds nothing.`
      : '- **The mandatory floor is off for this report** — full mandatory coverage earns no minimum score.',
    '- **Full expected coverage with no material factual issue is an automatic Pass**, even where the wording diverges from the Ideal Response: substance outranks similarity.',
    !rules.minimalGate.enabled
      ? '- **The mandatory gate is off for this report** — a missing must-have concept is reported on the case and changes neither its score nor its Result.'
      : rules.minimalCeiling.enabled
        ? `- **Missing any mandatory concept caps the score at ${rules.minimalCeiling.score}** — grade F, Result Fail. The uncapped arithmetic survives on the case as the **Pre-Gate Content Score**, a diagnostic that never enters an average or a rollup.`
        : '- **Missing any mandatory concept rates the case Fail** whatever its score — the score cap is off for this report, so the case keeps its own arithmetic.',
  ];
}

/** B0-811 — the one line of judged metrics a case gets, beneath the speed line and labelled like it. */
function caseJudgedLine(evaluated: EvaluatedCase): string | null {
  const parts: string[] = [];
  if (evaluated.similarity != null) {
    parts.push(
      `similarity to the Ideal Response ${evaluated.similarity}${evaluated.similarityNote ? ` — ${evaluated.similarityNote}` : ''}`,
    );
  }
  if (evaluated.evalConfidence != null) {
    parts.push(
      `evaluator confidence ${evaluated.evalConfidence}/100${evaluated.confidenceNote ? ` — ${evaluated.confidenceNote}` : ''}`,
    );
  }
  if (parts.length === 0) return null;
  return `**Judged (reported separately; not part of the content grade):** ${parts.join(' · ')}`;
}

export function renderReportMarkdown(params: {
  test: TestRecord;
  run: TestResultRecord;
  metrics: ReportMetrics;
  cases: CaseRenderDetail[];
  synthesis: ReportSynthesis;
  generatedAt: string;
  /** B0-825 — omitted only for a report whose persisted state predates the field. */
  config?: ReportGradingConfig | null;
}): string {
  const { test, run, metrics: m, synthesis, generatedAt, config } = params;
  const orderedCases = orderCasesByTier(params.cases);
  const byId = new Map(m.perCase.map((c) => [c.id, c]));
  const caseIds = orderedCases.map((c) => c.id);
  const link = (text: string) => linkifyCaseIds(text, caseIds);
  const lines: string[] = [];

  const push = (s: string) => lines.push(s);
  const blank = () => lines.push('');

  // --- Header ---
  push(`# ${test.name} — Agent Evaluation Report`);
  const subtitleParts = [
    test.intended_agent ? `${test.intended_agent} workflow` : null,
    `${m.evaluated} question${m.evaluated === 1 ? '' : 's'} evaluated` +
      (m.uteCount ? ` (+${m.uteCount} unable to evaluate)` : ''),
    `Run ${run.id}`,
    `Generated ${new Date(generatedAt).toLocaleString()}`,
  ].filter(Boolean);
  push(subtitleParts.join('  •  '));
  blank();
  // B0-825 — a reader comparing two reports needs to know whether the agent changed or the rules did.
  if (config) {
    push(gradingConfigLine(config, m.strictPassMark));
    blank();
  }

  // --- Executive assessment ---
  push('## Executive assessment');
  blank();
  push(`**Overall grade:** ${m.overall.grade} (${m.overall.avg ?? '—'}/100). Reflects calculated performance; not adjusted.`);
  push(
    `**Strongest areas:** ${link((synthesis.exec.strongestAreas.length ? synthesis.exec.strongestAreas : synthesis.strengths).slice(0, 3).join('  •  ')) || '—'}`,
  );
  push(
    `**Areas needing improvement:** ${link((synthesis.exec.improvementAreas.length ? synthesis.exec.improvementAreas : synthesis.weaknesses).slice(0, 3).join('  •  ')) || '—'}`,
  );
  push(
    `**Most significant failure pattern:** ${link(synthesis.exec.mostSignificantFailure || synthesis.failurePatterns[0] || '—')}`,
  );
  if (synthesis.exec.majorRisk) push(`**Major risk:** ${link(synthesis.exec.majorRisk)}`);
  if (synthesis.exec.readiness) push(`**Readiness for broader testing:** ${link(synthesis.exec.readiness)}`);
  blank();

  // --- Executive scorecard ---
  push('## Executive scorecard');
  blank();
  push('| Overall score | Overall grade | Pass rate | Questions evaluated |');
  push('|---|---|---|---|');
  push(
    `| ${m.overall.avg ?? '—'} / 100 | ${m.overall.grade} | ${m.overall.passPct}% (${m.overall.pass} of ${m.evaluated}) | ${m.evaluated}${m.uteCount ? ` (+${m.uteCount} N/A)` : ''} |`,
  );
  blank();
  // The line a pass rate means nothing without (methodology §2): the mark it was measured against,
  // and the population that flips the day the mark moves.
  push(
    `_Pass mark ${m.passMark}: Pass at ${m.passMark} or above, Fail below.${
      m.passOnlyUnderCurrentMark.length > 0
        ? ` ${m.passOnlyUnderCurrentMark.length} case${m.passOnlyUnderCurrentMark.length === 1 ? ' passes' : 's pass'} only under this mark and would Fail at ${m.strictPassMark}: ${m.passOnlyUnderCurrentMark.map(idLink).join(', ')}.`
        : ` No case passes only under this mark — every Pass would still Pass at ${m.strictPassMark}.`
    }_`,
  );
  blank();

  // --- Tier performance ---
  push('## Performance by tier');
  blank();
  push('| Tier | N | Avg | Grade | Pass | Fail |');
  push('|---|---|---|---|---|---|');
  for (const [tier, block] of m.tiers) push(rateRow(tier, block));
  blank();

  // --- Category performance ---
  push('## Performance by category');
  blank();
  push('| Category | N | Avg | Grade | Pass | Fail |');
  push('|---|---|---|---|---|---|');
  for (const [category, block] of m.categories) push(rateRow(category, block));
  blank();
  push(
    `_Strongest: ${m.strongestCategory ?? '—'} · Weakest: ${m.weakestCategory ?? '—'}_`,
  );
  blank();

  // --- Responsiveness (B0-718) ---
  // Kept below the grade tables and titled so it can never be mistaken for one of them. The
  // heading's parenthetical is load-bearing: as this section grew from one number to two metrics
  // and a score, "not part of the grade" is the sentence that stops a reader adding them up.
  push('## Responsiveness (reported separately — not part of the grade)');
  blank();
  if (!m.speed) {
    push(
      'Timing data was unavailable for this run — no case recorded a time to first token or a total response time, so no speed figures are reported.',
    );
    blank();
  } else {
    const sp = m.speed;
    const unit = sp.unit;

    push(
      `**Speed Performance Score: ${sp.avgScore}/100 (${sp.rating})** — median ${sp.medianScore}/100 across ${sp.n} timed case${sp.n === 1 ? '' : 's'}. This is a responsiveness score on its own 0–100 scale, rated in words; it is never converted to a letter grade and never enters the content score.`,
    );
    blank();

    push(`| Metric | n | Average | Median | P90 | Range | Avg score | Good / acceptable / slow |`);
    push('|---|---|---|---|---|---|---|---|');
    for (const metric of SPEED_METRICS) {
      const aggregate = metric === 'ttft' ? sp.metrics.ttft : sp.metrics.total;
      if (aggregate) push(speedMetricRow(aggregate, unit));
    }
    blank();

    push(
      `Ratings: ${sp.ratingDistribution.map((r) => `${r.count} ${r.rating}`).join(' · ')}.`,
    );

    for (const metric of SPEED_METRICS) {
      const aggregate = metric === 'ttft' ? sp.metrics.ttft : sp.metrics.total;
      if (!aggregate) continue;
      push(
        `${aggregate.label} — fastest: ${aggregate.fastest.map((s) => `${idLink(s.id)} (${s.seconds} ${unit})`).join(', ')} · slowest: ${aggregate.slowest.map((s) => `${idLink(s.id)} (${s.seconds} ${unit})`).join(', ')}.`,
      );
    }

    // Named explicitly rather than left to inference: a one-metric score and a two-metric score
    // are different measurements, and a reader comparing cases has to be able to tell.
    if (sp.basisCounts.ttftOnly > 0 || sp.basisCounts.totalOnly > 0) {
      push(
        `Partial timings: ${sp.basisCounts.combined} case${sp.basisCounts.combined === 1 ? '' : 's'} scored from both timings, ${sp.basisCounts.ttftOnly} from ${SPEED_METRIC_LABELS.ttft} alone and ${sp.basisCounts.totalOnly} from ${SPEED_METRIC_LABELS.total} alone (the remaining weight is renormalized, never imputed).`,
      );
    }
    blank();

    // The thresholds actually in force, printed from the constants rather than restated as prose.
    push(
      `_Weighting: ${SPEED_METRIC_LABELS.ttft} ${sp.weights.ttft} · ${SPEED_METRIC_LABELS.total} ${sp.weights.total}. Bands in force — ${SPEED_METRICS.map(
        (metric) => {
          const aggregate = metric === 'ttft' ? sp.metrics.ttft : sp.metrics.total;
          const thresholds = aggregate?.thresholds;
          return thresholds
            ? `${SPEED_METRIC_LABELS[metric]}: good ≤ ${thresholds.good} ${unit}, acceptable ≤ ${thresholds.acceptable} ${unit}, slow > ${thresholds.acceptable} ${unit}`
            : null;
        },
      )
        .filter(Boolean)
        .join(' · ')}. P90 is reported as ${P90_UNAVAILABLE_LABEL} below ${P90_MIN_N} samples._`,
    );
    blank();
  }

  // --- Top 3 recommendations ---
  push('## Top 3 recommended agent improvements');
  blank();
  push(
    '_Ranked by frequency, severity, business impact, effect on Tier 1 and weak categories, and whether the issue is systemic._',
  );
  blank();
  for (const rec of synthesis.top3) {
    push(`### Priority #${rec.priority}: ${rec.what}`);
    blank();
    if (rec.whyFirst) push(`**Why first:** ${link(rec.whyFirst)}`);
    if (rec.evidence) push(`**Evidence:** ${link(rec.evidence)}`);
    if (rec.affected) push(`**Affected:** ${link(rec.affected)}`);
    if (rec.change) push(`**Recommended change:** ${link(rec.change)}`);
    blank();
    if (rec.impact) push(`**Expected impact:** ${link(rec.impact)}`);
    blank();
  }

  // --- Methodology note ---
  push('## Methodology & scoring');
  blank();
  push(
    `Cases were matched to this run's own test items by ID, not row position. Each response was scored on a weighted 0–100 scale: Accuracy 40%, Completeness 30%, Relevance 20%, Clarity 10%. **All four are the grader's holistic judgments**, made against the Ideal Response, the expected concepts and the mandatory concepts together. Grades: A 90–100, B 80–89, C 70–79, D 60–69, F below 60. Result: Pass at ${m.passMark} or above, Fail below. The golden dataset (ideal response, expected and mandatory concepts, expected sources) is the source of truth; responses were judged on substantive correctness, not wording. Cases that could not be judged — including any without expected concepts, which have no concept data to be judged against — are marked "Unable to Evaluate" and excluded from every average, grade, count, and rate.`,
  );
  blank();
  // B0-835 — the four rules the reference agent-evaluation skill applies, stated from the rules
  // this report was actually scored under (`metrics.scoringRules`), never from the defaults.
  push(
    'Deterministic concept rules then act on those judgments, in this fixed order (methodology §2b):',
  );
  blank();
  for (const line of conceptRuleLines(m.scoringRules)) push(line);
  blank();
  push(
    `${
      m.scoringRules.minimalGate.enabled && m.scoringRules.minimalCeiling.enabled
        ? 'The ceiling runs last and outranks both the floor and the automatic Pass, so the score, the grade and the Result agree by construction — no case reads "B / Fail". '
        : ''
    }The one sanctioned exception is an automatic Pass that lands below the pass mark; every such case is named in the data-quality notes rather than left to be noticed.`,
  );
  blank();
  push(
    `A material factual issue the grader flagged on a regulated value is not a fifth sub-score${
      m.scoringRules.minimalFloor.enabled && m.scoringRules.minimalFloor.respectMaterialIssue
        ? ', but it withholds the mandatory floor'
        : ''
    } and it blocks the automatic Pass. It must also be reflected in Accuracy, which is where a confidently wrong answer is actually paid for.`,
  );
  blank();

  // --- Concept coverage (B0-713) ---
  // Omitted entirely — heading and all — when no case in the run carried concept data, so a
  // legacy run's document is byte-identical to the one it produced before the concept rules.
  if (m.concepts) {
    const con = m.concepts;
    push('## Concept coverage');
    blank();
    push(
      `- Satisfied every mandatory concept: **${con.mandatory.casesSatisfyingAll} of ${con.mandatory.casesSpecifying}** (${con.mandatory.pct}%) — of the cases that specify one.`,
    );
    push(
      `- Satisfied every expected concept: **${con.expected.casesSatisfyingAll} of ${con.expected.casesSpecifying}** (${con.expected.pct}%) — of the cases that specify one.`,
    );
    // B0-835 — what each rule actually did to this run, rule by rule. A rule that was off says so
    // instead of reporting a zero that would read as "nothing to see here".
    const gf = m.gateFloor;
    if (gf.gateEnabled) {
      push(
        `- Gated (missing a mandatory concept, rated Fail): **${con.gatedIds.length}** — of which the gate actually removed a Pass (Pre-Gate Content Score at or above the pass mark): **${con.preventedIds.length}**.`,
      );
    } else {
      push(
        `- Missing a mandatory concept: **${con.missingMandatory.length}** — the mandatory gate is off for this report, so no Result was changed by it.`,
      );
    }
    push(
      `- Automatic Pass (full expected coverage, no material factual issue): **${con.autoPassIds.length}** — changed a rating: **${con.autoPassChangedIds.length}** · withheld over a material factual issue: **${con.autoPassBlockedIds.length}**.`,
    );
    if (gf.floorEnabled) {
      push(
        `- Mandatory floor raised a score: **${gf.flooredIds.length}**${
          gf.flooredIds.length > 0
            ? ` (${gf.flooredIds.map(idLink).join(', ')}) — the sub-scores and the concept judgments disagree on these cases; re-check them rather than treating the floor as a routine adjustment.`
            : ' — as expected in a healthy run.'
        }`,
      );
    } else {
      push('- Mandatory floor: **off** for this report — full mandatory coverage earned no minimum score.');
    }
    if (gf.ceilingEnabled && gf.gateEnabled) {
      push(
        `- Mandatory ceiling capped a score: **${gf.cappedIds.length}**${
          gf.cappedIds.length > 0 ? ` (${gf.cappedIds.map(idLink).join(', ')})` : ''
        } — each of those cases shows its Pre-Gate Content Score.`,
      );
    } else {
      push('- Mandatory ceiling: **off** for this report — no score was capped for a missing must-have.');
    }
    if (gf.coverageEnabled) {
      push(
        `- Expected-coverage cap bound on Completeness: **${gf.coverageCappedIds.length}**${
          gf.coverageCappedIds.length > 0
            ? ` (${gf.coverageCappedIds.map(idLink).join(', ')}) — each shows the judged value beside the capped one.`
            : ' — no judged Completeness sat above its coverage share.'
        }`,
      );
    } else {
      push(
        '- Expected-coverage cap on Completeness: **off** for this report — Completeness is the judged value alone.',
      );
    }
    push(
      `- Material factual issue flagged by the grader: **${con.materialIssues.length}** — not a sub-score of its own${
        gf.floorEnabled && gf.floorRespectsMaterialIssue ? '; it withholds the mandatory floor and' : '; it'
      } blocks the automatic Pass.`,
    );
    blank();

    if (con.missingMandatory.length > 0) {
      push('### Cases missing a mandatory concept');
      blank();
      for (const entry of con.missingMandatory) {
        // Concept phrases verbatim — they carry dilution ratios, contact times, ppm and EPA numbers.
        push(`- ${idLink(entry.id)} — ${formatConceptList(entry.missing)}`);
      }
      blank();
    }

    if (con.materialIssues.length > 0) {
      push('### Material factual issues');
      blank();
      for (const entry of con.materialIssues) {
        push(`- ${idLink(entry.id)} — ${entry.note ?? 'material factual issue recorded'}`);
      }
      blank();
    }

    if (con.recurringMissing.length > 0) {
      push('### Recurring missing concepts');
      blank();
      for (const entry of con.recurringMissing) {
        push(
          `- ${formatConceptList([entry.concept])} — missing in ${entry.count} cases: ${entry.caseIds.map(idLink).join(', ')}`,
        );
      }
      blank();
    }
  }

  // --- Judged metrics (B0-811) ---
  // Omitted entirely when no case carries either metric. Two distributions, two exception cells and
  // a review queue — no average presented as a verdict, and nothing here touches a grade (§7c).
  if (m.judged) {
    const j = m.judged;
    const t = j.thresholds;
    push('## Judged metrics (reported separately — not part of the grade)');
    blank();
    push(
      'Two judgments the grader made while reading each case, reported beside the grade and never folded into it: how much of what the Ideal Response says the answer also says, and how sure the grader was of the grade it gave. The gap between them and the grade is the point.',
    );
    blank();
    if (j.similarity) {
      push(
        `- Similarity to the Ideal Response: average **${j.similarity.avg}**, median ${j.similarity.median}, range ${j.similarity.min}–${j.similarity.max} (n=${j.similarity.n}) — high (≥ ${t.simHigh}) ${j.similarityBands.high} · mid ${j.similarityBands.mid} · low (< ${t.simLow}) ${j.similarityBands.low}.`,
      );
      push(
        `- Similarity vs content score: ${j.similarityScoreCorrelation != null ? `r = ${j.similarityScoreCorrelation}` : `not reported (fewer than ${t.corrMinN} cases, or no variance)`}.`,
      );
    }
    if (j.evalConfidence) {
      push(
        `- Evaluator confidence: average **${j.evalConfidence.avg}**, median ${j.evalConfidence.median}, range ${j.evalConfidence.min}–${j.evalConfidence.max} (n=${j.evalConfidence.n}).`,
      );
    }
    push(
      `- Close to the ideal (≥ ${t.highSimFail}) and still failed — shape right, substance wrong: **${j.highSimilarityFailures.length}**${
        j.highSimilarityFailures.length > 0
          ? ` — ${j.highSimilarityFailures.map((c) => `${idLink(c.id)} (similarity ${c.similarity}, scored ${c.overall})`).join(', ')}`
          : ''
      }.`,
    );
    push(
      `- Passed while diverging from the ideal (< ${t.lowSimPass}) — right by a different route: **${j.lowSimilarityPasses.length}**${
        j.lowSimilarityPasses.length > 0
          ? ` — ${j.lowSimilarityPasses.map((c) => `${idLink(c.id)} (similarity ${c.similarity}, scored ${c.overall})`).join(', ')}`
          : ''
      }.`,
    );
    blank();
    if (j.reviewQueue.length > 0) {
      push(`### SME review queue — grades held at ${t.lowConfidence} confidence or below`);
      blank();
      push('| ID | Question | Confidence | Result |');
      push('|---|---|---|---|');
      for (const entry of j.reviewQueue) {
        push(`| ${idLink(entry.id)} | ${mdCell(entry.question)} | ${entry.evalConfidence} | ${entry.status} |`);
      }
      blank();
    } else {
      push(`_No case is held at ${t.lowConfidence} confidence or below — the review queue is empty._`);
      blank();
    }
  }

  // --- Grading consistency (B0-721) ---
  // Omitted entirely — heading and all — for a single-pass run: `metrics.consistency` is null when
  // no case was graded more than once, and "0 flags out of 0 comparisons" would read as a clean
  // bill of health for a measurement that was never taken.
  if (m.consistency) {
    const con = m.consistency;
    push('## Grading consistency');
    blank();
    push(
      `Every case was graded **${con.passes} times, independently** — no pass saw another pass's scores or narrative. The sub-scores above are the median of those passes; this section is how much they disagreed. Flagged cases need a human to settle the grade; they are not failures.`,
    );
    blank();
    push(
      `- Cases graded more than once: **${con.casesConsolidated}**`,
    );
    push(`- **Flagged for human review: ${con.flagged} of ${con.casesConsolidated}**`);
    push(`- ${VARIANCE_CAUSE_LABELS.band_split}: **${con.byCause.band_split}**`);
    push(
      `- ${VARIANCE_CAUSE_LABELS.score_range} (≥ ${con.spreadThreshold} points): **${con.byCause.score_range}**`,
    );
    push(`- ${VARIANCE_CAUSE_LABELS.evaluability}: **${con.byCause.evaluability}**`);
    // Called out separately from the other three causes: a split on a concept is a split on a
    // regulated must-have, not on a number.
    push(
      `- **${VARIANCE_CAUSE_LABELS.concept}: ${con.conceptDisagreementCases}** ${con.conceptDisagreementCases === 1 ? 'case' : 'cases'}, across ${con.conceptDisagreements} individual concept ${con.conceptDisagreements === 1 ? 'judgment' : 'judgments'}`,
    );
    push(`- Widest score range on any case: **${con.maxRange ?? '—'}**`);
    blank();

    if (con.queue.length > 0) {
      push('### Cases flagged for human review');
      blank();
      push('| ID | Question | Pass overalls | Range | Why |');
      push('|---|---|---|---|---|');
      for (const entry of con.queue) push(consistencyQueueRow(entry));
      blank();
    }

    // A timing the passes recorded differently is a data-entry problem at the source, not a shaky
    // grade — stated here, out of the flag counts, and never smoothed into an average.
    if (con.timingDisagreementCases > 0) {
      push(
        `_Data quality (not a grading flag): ${con.timingDisagreementCases} ${con.timingDisagreementCases === 1 ? 'case' : 'cases'} recorded different timings across passes. A timing is a measurement, not a judgment, so it is reported exactly as recorded and never averaged. The affected cases are named in the data-quality notes._`,
      );
      blank();
    }
  }

  // --- Results at a glance ---
  push('## Results at a glance');
  blank();
  push('| ID | Question | Tier | Score | Grade | Result |');
  push('|---|---|---|---|---|---|');
  let anyMandatoryMissing = false;
  let anyReviewFlagged = false;
  for (const c of orderedCases) {
    // B0-721 — the review mark rides alongside the concept mark rather than replacing it, and an
    // Unable-to-Evaluate row can carry it too: passes that disagreed about whether a case could be
    // judged at all is exactly the kind of grade a human has to settle.
    const reviewFlagged = c.variance?.flagged ?? false;
    anyReviewFlagged ||= reviewFlagged;
    if (c.score.unableToEvaluate) {
      push(
        `| ${idLink(c.id)} | ${mdCell(c.question)} | ${mdCell(c.tier)} | — | — | Unable to Evaluate${caseMarkers({ mandatoryMissing: false, reviewFlagged })} |`,
      );
      continue;
    }
    const evaluated = byId.get(c.id) as EvaluatedCase | undefined;
    if (!evaluated) continue;
    anyMandatoryMissing ||= evaluated.mandatoryMissing;
    push(
      `| ${idLink(c.id)} | ${mdCell(c.question)} | ${mdCell(c.tier)} | ${evaluated.overall} | ${evaluated.grade} | ${evaluated.status}${caseMarkers({ mandatoryMissing: evaluated.mandatoryMissing, reviewFlagged })} |`,
    );
  }
  blank();
  // Legend only for marks actually used — no orphan footnote.
  if (anyMandatoryMissing || anyReviewFlagged) {
    push(
      `_${[
        anyMandatoryMissing ? mandatoryMissingLegend(m.scoringRules) : null,
        anyReviewFlagged ? REVIEW_MARKER_LEGEND : null,
      ]
        .filter(Boolean)
        .join('  ')}_`,
    );
    blank();
  }

  // --- Detailed case-by-case ---
  push('## Detailed results — case by case');
  blank();
  push(
    '_Speed and harness signal (below, where present) are reported for reference only and are not part of the grade._',
  );
  blank();
  for (const c of orderedCases) {
    push(`> **${c.question.replace(/\r?\n/g, ' ')}**`);
    push('>');
    push(`> \`${c.id}\``);
    blank();
    push(`**Tier / Priority:** ${c.tier}${c.priorityRaw != null ? ` (${c.priorityRaw})` : ''}`);
    push(`**Category:** ${c.category}`);
    blank();

    if (c.score.unableToEvaluate) {
      push('**Status:** Unable to Evaluate _(excluded from all scores and rates)_');
      push(`**Reason:** ${c.score.uteReason ?? 'unspecified'}`);
      blank();
      if (c.variance) {
        push(caseVarianceLine(c.variance));
        blank();
      }
      // Unable to Evaluate and timed are independent: the case still got an answer, and how long
      // that took is a real measurement that counts in the run's speed aggregates.
      if (c.speed) {
        push(caseSpeedLine(c.speed));
        blank();
      }
      push(`**Expected answer / behavior:**\n\n${formatExpected(c)}`);
      blank();
      push(`**Agent's actual response:**\n\n${mdBlock(normalizeAgentMarkdownLists(c.actual))}`);
      blank();
      continue;
    }

    const evaluated = byId.get(c.id) as EvaluatedCase | undefined;
    if (evaluated) {
      push('| Accuracy | Completeness | Relevance | Clarity | Overall | Grade | Result |');
      push('|---|---|---|---|---|---|---|');
      // B0-835 — where the cap bound, the cell carries both numbers so the arithmetic reconciles
      // without a second headline score (methodology §2b Rule 3).
      const completenessCell = evaluated.coverageApplied
        ? `${evaluated.completeness} (judged ${evaluated.completenessJudged})`
        : String(evaluated.completeness);
      push(
        `| ${evaluated.accuracy} | ${completenessCell} | ${evaluated.relevance} | ${evaluated.clarity} | ${evaluated.overall}/100 | ${evaluated.grade} | ${evaluated.status} |`,
      );
      blank();

      // B0-813 / B0-835 — where the Completeness came from, the coverage readout, what each concept
      // rule did to this case, and what is missing by name. Methodology §9 is explicit that this is
      // as much as a reader needs here: the numbers on labelled lines, the reasoning in one
      // sentence, and no fact stated twice.
      const con = evaluated.concepts;
      const coverageCounts = `${evaluated.coverage.satisfied} of ${evaluated.coverage.required} expected concept${evaluated.coverage.required === 1 ? '' : 's'} communicated`;
      if (evaluated.coverageApplied) {
        push(
          `**Completeness:** judged ${evaluated.completenessJudged}, capped at coverage ${evaluated.completeness} (${coverageCounts}).`,
        );
      } else {
        push(
          `**Completeness:** ${evaluated.completeness} — ${coverageCounts}.${
            evaluated.completenessJudged === null
              ? ' (no judged value on this pass; coverage used)'
              : ''
          }`,
        );
      }
      push(`**Concept coverage:** ${formatConceptCoverage(con)}`);
      if (evaluated.ceilingApplied) {
        push(
          `**Pre-Gate Content Score:** ${evaluated.preGateScore}/100 (${evaluated.preGateGrade}) — the rubric arithmetic before the mandatory cap; diagnostic only.`,
        );
      }
      if (evaluated.floorApplied) {
        push(
          `**Mandatory floor:** raised from ${evaluated.weighted} to ${evaluated.floor} — every mandatory concept satisfied. NOTE: the sub-scores placed this below a C despite full mandatory coverage — re-check.`,
        );
      }
      if (evaluated.statusSource === 'auto_pass') {
        push('**Automatic Pass:** all expected concepts communicated, no material issue.');
      }
      if (evaluated.autoPassBlocked) {
        push(
          `**Automatic Pass withheld:** ${con.materialIssueNote ?? 'a material factual issue was recorded on this case.'}`,
        );
      }
      // B0-938 — the whole golden list, ticked or crossed, rather than only what was missed. Same
      // entries and same order as the React ledger's checklist: both call `conceptChecklist`.
      for (const [label, coverage] of [
        ['Must-have concepts', con.mandatory],
        ['Expected concepts', con.expected],
      ] as const) {
        const entries = conceptChecklist(coverage);
        if (entries.length === 0) continue;
        const satisfied = entries.filter((entry) => entry.met).length;
        push(`**${label}** (${satisfied}/${entries.length}):`);
        for (const entry of entries) push(formatConceptChecklistLine(entry));
      }
      if (con.materialIssue) {
        push(
          `**Material factual issue:** ${con.materialIssueNote ?? 'a material factual issue was recorded on this case.'}`,
        );
      }
      // The skill's own sentence, printed once. The floor, automatic-Pass and withheld-Pass lines
      // above already state it word for word for those three outcomes, so it would be a duplicate
      // there; for a gated or coverage-capped case it carries reasoning the numbers do not.
      if (
        evaluated.conceptNote &&
        !evaluated.floorApplied &&
        evaluated.statusSource !== 'auto_pass' &&
        !evaluated.autoPassBlocked
      ) {
        push(`**Concept rules:** ${evaluated.conceptNote}`);
      }
      if (evaluated.passesOnlyUnderCurrentMark) {
        push(
          `**Pass mark:** passes at ${m.passMark}; would Fail at ${m.strictPassMark}.`,
        );
      }
      blank();
    }

    // B0-721 — the spread that produced (or did not produce) this case's review flag. Detailed
    // ledger only: the glance table carries the mark, the detail carries the evidence.
    if (c.variance) {
      push(caseVarianceLine(c.variance));
      blank();
    }

    // Placed after the score table, never inside it (B0-718).
    if (c.speed) {
      push(caseSpeedLine(c.speed));
      blank();
    }

    // B0-811 — directly beneath the speed line, labelled the same way (§9).
    const judgedLine = evaluated ? caseJudgedLine(evaluated) : null;
    if (judgedLine) {
      push(judgedLine);
      blank();
    }

    if (c.harness) {
      const bits = [
        c.harness.passed != null ? `harness result: ${c.harness.passed ? 'passed' : 'failed'}` : null,
        c.harness.similarity != null ? `similarity ${c.harness.similarity.toFixed(2)}` : null,
        c.harness.answerProvenance ? `answer provenance: ${c.harness.answerProvenance}` : null,
        c.harness.routingDecision ? `routing: ${c.harness.routingDecision}` : null,
        c.harness.gates.length > 0
          ? `gates fired: ${c.harness.gates.map((g) => `${g.name}: ${g.verdict}`).join(', ')}`
          : null,
        c.harness.draftDiscarded ? 'draft discarded' : null,
        c.harness.chunkCount > 0 ? `retrieved chunks: ${c.harness.chunkCount}` : null,
      ].filter(Boolean);
      if (bits.length > 0) {
        push(`**Harness signal:** ${bits.join(' · ')}`);
        blank();
      }
    }

    push(`**Expected answer / behavior:**\n\n${formatExpected(c)}`);
    blank();
    push(`**Agent's actual response:**\n\n${mdBlock(normalizeAgentMarkdownLists(c.actual))}`);
    blank();
    push(`**Explanation of the grade:** ${mdBlock(link(c.score.explanation))}`);
    push(`**Important information missed:** ${mdBlock(link(c.score.missed))}`);
    push(`**Incorrect, misleading, or unsupported information:** ${mdBlock(link(c.score.incorrect))}`);
    push(`**Recommended improvement:** ${mdBlock(link(c.score.improvement))}`);
    blank();
  }

  // --- Aggregate findings ---
  push('## Aggregate findings');
  blank();
  push(
    `- Total questions evaluated: ${m.evaluated}${m.uteCount ? ` (plus ${m.uteCount} unable to evaluate; ${m.totalCases} total)` : ''}`,
  );
  push(`- Average score: ${m.overall.avg ?? '—'} / 100`);
  push(`- Overall letter grade: ${m.overall.grade}`);
  push(`- Pass: ${m.overall.pass} of ${m.evaluated} (${m.overall.passPct}%) at pass mark ${m.passMark}`);
  push(`- Fail: ${m.overall.fail} of ${m.evaluated} (${m.overall.failPct}%)`);
  push(
    `- Pass only under the current mark (would Fail at ${m.strictPassMark}): ${m.passOnlyUnderCurrentMark.length > 0 ? m.passOnlyUnderCurrentMark.map(idLink).join(', ') : 'none'}`,
  );
  push(`- Highest scoring: ${m.highest.map((h) => `${idLink(h.id)} (${h.overall})`).join(', ') || '—'}`);
  push(`- Lowest scoring: ${m.lowest.map((h) => `${idLink(h.id)} (${h.overall})`).join(', ') || '—'}`);
  blank();

  push('### Most common failure patterns');
  blank();
  push(bulletList(synthesis.failurePatterns.map(link)));
  blank();
  push('### Key strengths');
  blank();
  push(bulletList(synthesis.strengths.map(link)));
  blank();
  push('### Recurring weaknesses');
  blank();
  push(bulletList(synthesis.weaknesses.map(link)));
  blank();

  return lines.join('\n');
}
