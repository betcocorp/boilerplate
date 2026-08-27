import type { TestRecord, TestResultRecord } from '~/lib/tests/types';

import {
  CONCEPT_MARKER_LEGEND,
  conceptMarkers,
  formatConceptCoverage,
  formatConceptList,
} from './case-concepts';
import { normalizeAgentMarkdownLists } from './markdown-normalize';
import type { EvaluatedCase, RateBlock, ReportMetrics } from './metrics';
import type { CaseScore, ReportSynthesis } from './schemas';

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
  latencySeconds: number | null;
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

export type LatencyBand = 'good' | 'acceptable' | 'slow';

/** Which responsiveness band a case's latency falls in. Exported so the B0-586 data contract can
 * surface the same band the Markdown prints, rather than re-deriving it from the thresholds. */
export function latencyBandLabel(
  seconds: number,
  thresholds: { good: number; slow: number },
): LatencyBand {
  if (seconds <= thresholds.good) return 'good';
  if (seconds > thresholds.slow) return 'slow';
  return 'acceptable';
}

function rateRow(name: string, block: RateBlock): string {
  return `| ${mdCell(name)} | ${block.n} | ${block.avg ?? '—'} | ${block.grade} | ${block.passPct}% | ${block.partialPct}% | ${block.failPct}% |`;
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

export function renderReportMarkdown(params: {
  test: TestRecord;
  run: TestResultRecord;
  metrics: ReportMetrics;
  cases: CaseRenderDetail[];
  synthesis: ReportSynthesis;
  generatedAt: string;
}): string {
  const { test, run, metrics: m, synthesis, generatedAt } = params;
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

  // --- Tier performance ---
  push('## Performance by tier');
  blank();
  push('| Tier | N | Avg | Grade | Pass | Partial | Fail |');
  push('|---|---|---|---|---|---|---|');
  for (const [tier, block] of m.tiers) push(rateRow(tier, block));
  blank();

  // --- Category performance ---
  push('## Performance by category');
  blank();
  push('| Category | N | Avg | Grade | Pass | Partial | Fail |');
  push('|---|---|---|---|---|---|---|');
  for (const [category, block] of m.categories) push(rateRow(category, block));
  blank();
  push(
    `_Strongest: ${m.strongestCategory ?? '—'} · Weakest: ${m.weakestCategory ?? '—'}_`,
  );
  blank();

  // --- Responsiveness ---
  if (m.latency) {
    const lat = m.latency;
    push('## Responsiveness (reported separately — not part of the grade)');
    blank();
    push(
      `Average response time: **${lat.avg} s** (range ${lat.min}–${lat.max} s, median ${lat.median} s, n=${lat.n}).`,
    );
    push(
      `Bands (good ≤ ${lat.thresholds.good} s · acceptable ≤ ${lat.thresholds.slow} s · slow > ${lat.thresholds.slow} s): **${lat.bands.good} good, ${lat.bands.acceptable} acceptable, ${lat.bands.slow} slow**.`,
    );
    push(`Slowest: ${lat.slowest.map((s) => `${idLink(s.id)} (${s.seconds} s)`).join(', ')}.`);
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
    'Cases were matched to this run\'s own test items by ID, not row position. Each response was scored on a weighted 0–100 scale: Accuracy 40%, Completeness 30%, Relevance 20%, Clarity 10%. Grades: A 90–100, B 80–89, C 70–79, D 60–69, F below 60. Result: Pass ≥ 80, Partial Pass 60–79, Fail below 60. The golden dataset (ideal response, expected concepts/sources) is the source of truth; responses were judged on substantive correctness, not wording. Cases that could not be judged are marked "Unable to Evaluate" and excluded from every average, grade, count, and rate.',
  );
  blank();
  // Stated only when the run actually has concept data, so a legacy run's methodology is unchanged.
  if (m.concepts) {
    push(
      'Where a case carries expected criteria, the Grade above stays pure arithmetic and only the Result can move: satisfying every expected concept raises a below-Pass Result to Pass, and missing a mandatory (must-have) concept caps the Result below Pass. The cap is applied last, so it always wins over the automatic Pass, and the automatic Pass is withheld entirely when a deterministic check on a regulated value failed.',
    );
    blank();
  }

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
      `- Missing a mandatory concept: **${con.missingMandatory.length}**, of which **${con.gateBlockedPasses}** lost a Pass to the gate.`,
    );
    push(`- Qualified for an automatic Pass: **${con.autoPassed.length}**.`);
    push(
      `- Automatic Pass withheld over a material factual issue: **${con.autoPassBlocked.length}**.`,
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

    if (con.autoPassBlocked.length > 0) {
      push('### Automatic Passes withheld');
      blank();
      for (const entry of con.autoPassBlocked) {
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

  // --- Results at a glance ---
  push('## Results at a glance');
  blank();
  push('| ID | Question | Tier | Score | Grade | Result |');
  push('|---|---|---|---|---|---|');
  let anyRatingConstrained = false;
  let anyAutoPass = false;
  for (const c of orderedCases) {
    if (c.score.unableToEvaluate) {
      push(`| ${idLink(c.id)} | ${mdCell(c.question)} | ${mdCell(c.tier)} | — | — | Unable to Evaluate |`);
      continue;
    }
    const evaluated = byId.get(c.id) as EvaluatedCase | undefined;
    if (!evaluated) continue;
    anyRatingConstrained ||= evaluated.ratingConstrained;
    anyAutoPass ||= evaluated.autoPassTriggered;
    push(
      `| ${idLink(c.id)} | ${mdCell(c.question)} | ${mdCell(c.tier)} | ${evaluated.overall} | ${evaluated.grade} | ${evaluated.status}${conceptMarkers(evaluated)} |`,
    );
  }
  blank();
  // Legend only for marks actually used — no orphan footnote on a run with no concept data.
  if (anyRatingConstrained || anyAutoPass) {
    push(
      `_${[
        anyRatingConstrained ? CONCEPT_MARKER_LEGEND.ratingConstrained : null,
        anyAutoPass ? CONCEPT_MARKER_LEGEND.autoPass : null,
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
    '_Response time and harness signal (below, where present) are reported for reference only and are not part of the grade._',
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

      // B0-713 — a few lines, only when this case has concept data: the coverage, what is missing
      // by name, and one sentence for whichever rule moved (or was withheld from) the Result.
      // Methodology §9 is explicit that this is as much as a reader needs here.
      if (evaluated.concepts) {
        const con = evaluated.concepts;
        push(`**Concept coverage:** ${formatConceptCoverage(con)}`);
        if (con.mandatory.missing.length > 0) {
          push(`**Missing mandatory concepts:** ${formatConceptList(con.mandatory.missing)}`);
        }
        if (con.expected.missing.length > 0) {
          push(`**Missing expected concepts:** ${formatConceptList(con.expected.missing)}`);
        }
        if (evaluated.ratingConstrained) {
          push(
            `**Rating constrained:** mandatory concept(s) missing — ${formatConceptList(con.mandatory.missing)}${
              evaluated.gateBlockedAPass
                ? ` (scored ${evaluated.overall}/100, so the gate removed a Pass)`
                : ''
            }`,
          );
        }
        if (evaluated.autoPassTriggered) {
          push(
            `**Automatic Pass:** every expected concept satisfied, so the ${evaluated.rubricStatus} the rubric scored was raised to Pass.`,
          );
        }
        if (evaluated.autoPassBlocked) {
          push(
            `**Automatic Pass blocked:** ${con.materialIssueNote ?? 'a material factual issue was recorded on this case.'}`,
          );
        }
        blank();
      }
    }

    if (c.latencySeconds != null && m.latency) {
      const band = latencyBandLabel(c.latencySeconds, m.latency.thresholds);
      push(`**Response time:** ${c.latencySeconds} s (${band})`);
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
  push(`- Pass: ${m.overall.pass} of ${m.evaluated} (${m.overall.passPct}%)`);
  push(`- Partial Pass: ${m.overall.partial} of ${m.evaluated} (${m.overall.partialPct}%)`);
  push(`- Fail: ${m.overall.fail} of ${m.evaluated} (${m.overall.failPct}%)`);
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
