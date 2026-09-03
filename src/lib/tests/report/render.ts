import type { TestRecord, TestResultRecord } from '~/lib/tests/types';

import {
  CONCEPT_MARKER_LEGEND,
  caseMarkers,
  formatConceptCoverage,
  formatConceptList,
  hasMandatoryMiss,
  REVIEW_MARKER_LEGEND,
} from './case-concepts';
import {
  CONCEPT_DISAGREEMENT_LABELS,
  VARIANCE_CAUSE_LABELS,
  type CaseGradingVariance,
  type ConceptDisagreement,
  type VarianceCause,
} from './consolidate';
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
};

export type CaseRenderDetail = {
  id: string;
  question: string;
  tier: string;
  priorityRaw: number | null;
  category: string;
  idealResponse: string | null;
  expectedConcepts: string | null;
  minimumConcepts: string | null;
  expectedSources: string | null;
  expectedShouldAnswer: boolean | null;
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

function formatExpected(c: CaseRenderDetail): string {
  const parts: string[] = [];
  if (c.idealResponse) parts.push(normalizeAgentMarkdownLists(c.idealResponse.trim()));
  if (c.expectedConcepts) parts.push(`**Expected concepts:** ${c.expectedConcepts.trim()}`);
  if (c.minimumConcepts) parts.push(`**Minimum concepts:** ${c.minimumConcepts.trim()}`);
  if (c.expectedSources) parts.push(`**Expected sources:** ${c.expectedSources.trim()}`);
  if (c.expectedShouldAnswer != null) {
    parts.push(`**Should answer:** ${c.expectedShouldAnswer ? 'Yes' : 'No'}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : '_(no expected answer recorded)_';
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

/** B0-825 — the one-line statement of what a report was graded with. */
export function gradingConfigLine(config: ReportGradingConfig, strictPassMark: number): string {
  const parts = [
    `Graded by ${config.model}`,
    `${config.passes} independent pass${config.passes === 1 ? '' : 'es'}`,
    config.spreadThreshold != null ? `spread threshold ${config.spreadThreshold}` : null,
    config.passMark != null ? `pass mark ${config.passMark} (strict ${strictPassMark})` : null,
    config.judgedThresholds
      ? `judged thresholds sim ≥ ${config.judgedThresholds.simHigh} high / < ${config.judgedThresholds.simLow} low · review ≤ ${config.judgedThresholds.lowConfidence} confidence`
      : null,
    config.gradingPromptHash ? `grading prompt ${config.gradingPromptHash.slice(0, 12)}` : null,
  ].filter((part): part is string => part !== null);
  return `_${parts.join(' · ')}._`;
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
    `Cases were matched to this run's own test items by ID, not row position. Each response was scored on a weighted 0–100 scale: Accuracy 40%, Completeness 30%, Relevance 20%, Clarity 10%. Accuracy, Relevance and Clarity are the grader's judgments; **Completeness is computed** as the share of the case's expected concepts the response communicated (100 × satisfied ÷ required), from the grader's per-concept verdicts. The overall is that weighted sum and nothing else — never raised, never capped. Grades: A 90–100, B 80–89, C 70–79, D 60–69, F below 60. Result: Pass at ${m.passMark} or above, Fail below; nothing else changes a Result. The golden dataset (ideal response, expected and mandatory concepts, expected sources) is the source of truth; responses were judged on substantive correctness, not wording. Cases that could not be judged — including any without expected concepts, which have no data for Completeness — are marked "Unable to Evaluate" and excluded from every average, grade, count, and rate.`,
  );
  blank();
  push(
    'A missing mandatory (must-have) concept is reported on the case and lowers Completeness through coverage like any other expected concept; it does not by itself change the Result. A material factual issue the grader flagged on a regulated value is likewise reported on the case, not scored.',
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
    push(
      `- Missing a mandatory concept: **${con.missingMandatory.length}** — reported on each case; the miss lowered Completeness through coverage and did not by itself change any Result.`,
    );
    push(`- Material factual issue flagged by the grader: **${con.materialIssues.length}** — reported, not scored.`);
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
        anyMandatoryMissing ? CONCEPT_MARKER_LEGEND.mandatoryMissing : null,
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
      push(
        `| ${evaluated.accuracy} | ${evaluated.completeness} | ${evaluated.relevance} | ${evaluated.clarity} | ${evaluated.overall}/100 | ${evaluated.grade} | ${evaluated.status} |`,
      );
      blank();

      // B0-813 — where the Completeness came from, the coverage readout, what is missing by name,
      // and the reported (never scored) facts: a must-have miss, a material issue. Methodology §9
      // is explicit that this is as much as a reader needs here.
      const con = evaluated.concepts;
      push(
        `**Completeness:** ${evaluated.completeness} — ${evaluated.coverage.satisfied} of ${evaluated.coverage.required} expected concept${evaluated.coverage.required === 1 ? '' : 's'} communicated.`,
      );
      push(`**Concept coverage:** ${formatConceptCoverage(con)}`);
      if (hasMandatoryMiss(con)) {
        push(
          `**Missing mandatory concepts (reported — not enforced):** ${formatConceptList(con.mandatory.missing)}`,
        );
      }
      if (con.expected.missing.length > 0) {
        push(`**Missing expected concepts:** ${formatConceptList(con.expected.missing)}`);
      }
      if (con.materialIssue) {
        push(
          `**Material factual issue (reported — not scored):** ${con.materialIssueNote ?? 'a material factual issue was recorded on this case.'}`,
        );
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
