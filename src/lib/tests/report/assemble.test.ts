import { describe, expect, it } from 'vitest';

import type {
  TestItemRecord,
  TestRecord,
  TestResultItemRecord,
  TestResultRecord,
} from '~/lib/tests/types';

import {
  assembleReportCases,
  assembleReportData,
  toNotGeneratedPayload,
  toReportDataPayload,
} from './assemble';
import {
  formatConceptList,
  MANDATORY_CONCEPTS_LABEL,
  NO_MANDATORY_CONCEPTS_NOTE,
  splitConcepts,
} from './case-concepts';
import { reportDataResponseSchema, type ReportDataReady } from './data-schemas';
import { formatExpectedSourceRef } from './expected-sources';
import { NO_EXPECTED_CONCEPTS_UTE_REASON } from './metrics';
import { caseAnchorId, gradingConfigLine, renderReportMarkdown } from './render';
import type { CaseConcepts, CaseScore, ReportSynthesis } from './schemas';
import { DEFAULT_SCORING_RULES } from './scoring-config';

/**
 * B0-586 — the guard that keeps the Markdown report and the structured `/report/data` contract in
 * lockstep. Every value `renderReportMarkdown` prints is *sourced from the data payload* here and
 * then asserted present in the rendered Markdown, so a field the contract cannot express fails
 * this test rather than silently going missing from the new UI.
 *
 * The fixture deliberately carries regulated values (dilution ratios, oz/gal, ppm, contact times,
 * EPA reg numbers) so any rounding, unit conversion or numeric coercion in assembly shows up as a
 * failed verbatim assertion.
 */

const RUN_ID = 'a1b2c3d4-1111-4111-8111-111111111111';
const TEST_ID = 'b2c3d4e5-2222-4222-8222-222222222222';
const CASE_A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CASE_B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CASE_C = '33333333-cccc-4ccc-8ccc-cccccccccccc';
const CASE_D = '44444444-dddd-4ddd-8ddd-dddddddddddd';
/** B0-933 — `test_items.expected_sources` is a `uuid[]` of `rag.document.id`. */
const LABEL_DOC_ID = '55555555-1111-4111-8111-aaaaaaaaaaaa';
const PURGED_DOC_ID = '66666666-2222-4222-8222-bbbbbbbbbbbb';

/** Regulated strings that must survive assembly and serialization byte-for-byte. */
const REGULATED = {
  dilution: 'Dilute 1:64 (2 oz/gal) for routine cleaning; 1:32 (4 oz/gal) for heavy soil.',
  contactTime: 'Contact time: 10 minutes at 600 ppm active quat.',
  epa: 'EPA Reg. No. 6836-140-4170',
  concentration: 'Active: n-Alkyl dimethyl benzyl ammonium chloride 5.25%',
  metric: 'Metric equivalent as printed: 15.6 mL/L',
} as const;

/**
 * B0-933 — the batched `rag.document` lookup the async callers do, as data. `LABEL_DOC_ID`
 * resolves; `PURGED_DOC_ID` deliberately does not, so the "unresolved, still listed" contract is
 * exercised on the same fixture as the happy path. The title carries an EPA registration number so
 * a re-cased or reformatted title fails here.
 */
const EXPECTED_SOURCE_INDEX = new Map([
  [
    LABEL_DOC_ID,
    { title: `pH7Q Dual product label — ${REGULATED.epa}`, documentKind: 'label' },
  ],
]);

function score(partial: Partial<CaseScore>): CaseScore {
  return {
    unableToEvaluate: false,
    uteReason: null,
    accuracy: null,
    completeness: null,
    relevance: null,
    clarity: null,
    explanation: '',
    missed: '',
    incorrect: '',
    improvement: '',
    ...partial,
  };
}

function item(partial: Partial<TestItemRecord> & Pick<TestItemRecord, 'id' | 'prompt'>) {
  return {
    test_id: TEST_ID,
    row_index: 0,
    expected_canonical_products: [],
    expected_reason_code: null,
    input_payload: {},
    metadata: {},
    created_at: '2026-08-01T00:00:00.000Z',
    prompt_category: null,
    priority: null,
    ideal_response: null,
    // B0-933 — every one of these is a NOT NULL array column now, defaulting to '{}'.
    expected_concepts: [],
    minimum_concepts: [],
    expected_sources: [],
    should_cite: null,
    source: null,
    intended_agent_item: null,
    expected_tool: null,
    ...partial,
  } as unknown as TestItemRecord;
}

function resultItem(
  partial: Partial<TestResultItemRecord> & Pick<TestResultItemRecord, 'test_item_id'>,
) {
  return {
    id: `result-${partial.test_item_id}`,
    test_result_id: RUN_ID,
    row_index: 0,
    status: 'ok',
    passed: true,
    elapsed_ms: 3200,
    ttft_ms: null,
    error_message: null,
    response_text: null,
    response_payload: null,
    created_at: '2026-08-02T00:00:00.000Z',
    workflow_run_id: null,
    ...partial,
  } as unknown as TestResultItemRecord;
}

const TEST_RECORD = {
  id: TEST_ID,
  name: 'Disinfectant Golden Set',
  intended_agent: 'product',
} as unknown as TestRecord;

const RUN_RECORD = {
  id: RUN_ID,
  test_id: TEST_ID,
  status: 'completed',
  report_generated_at: '2026-08-03T12:00:00.000Z',
} as unknown as TestResultRecord;

const ITEMS: TestItemRecord[] = [
  item({
    id: CASE_A,
    row_index: 0,
    prompt: 'What is the dilution ratio for pH7Q Dual on sealed concrete?',
    prompt_category: 'Dilution',
    priority: 1,
    ideal_response: REGULATED.dilution,
    expected_concepts: [REGULATED.metric],
    minimum_concepts: ['States the 1:64 ratio.'],
    // B0-933 — one live `rag.document` id and one that no longer resolves.
    expected_sources: [LABEL_DOC_ID, PURGED_DOC_ID],
  }),
  item({
    id: CASE_B,
    row_index: 1,
    prompt: 'How long must the surface stay wet to disinfect?',
    prompt_category: 'Dilution',
    priority: 1,
    ideal_response: REGULATED.contactTime,
    expected_concepts: ['Dwell time is 10 minutes.'],
    minimum_concepts: [],
    expected_sources: [],
  }),
  item({
    id: CASE_C,
    row_index: 2,
    prompt: 'Which active ingredient does this product use?',
    prompt_category: 'Disinfection',
    priority: 2,
    ideal_response: REGULATED.concentration,
    expected_concepts: [],
    minimum_concepts: [],
    expected_sources: [],
  }),
  item({
    id: CASE_D,
    row_index: 3,
    prompt: 'Is this product registered in Quebec?',
    prompt_category: 'Disinfection',
    priority: null,
  }),
];

const RESULT_ITEMS: TestResultItemRecord[] = [
  resultItem({
    test_item_id: CASE_A,
    elapsed_ms: 3200,
    ttft_ms: 1200,
    passed: true,
    status: 'ok',
    response_text: `  ${REGULATED.dilution} ${REGULATED.metric}  `,
    // B0-863 — plain generated columns on `test_result_items`, exercised alongside the
    // `response_payload` fields the harness aside now also reads (activeGates, draftAnswer).
    answer_provenance: 'model_generated',
    routing_decision: 'llm',
    response_payload: {
      sources: [
        { documentId: 'doc-label-1', chunkId: 'chunk-1', similarity: 0.83 },
        { documentId: 'doc-label-1', chunkId: 'chunk-2', similarity: 0.71 },
        { documentId: 'doc-sds-9', chunkId: 'chunk-3', similarity: 0.64 },
      ],
      activeGates: {
        validator: { state: 'skipped', reason: 'disabled_by_flag' },
        earlyDeclineGate: { state: 'not_applicable' },
        usageSafetyCoverage: { state: 'not_applicable' },
        regulatedClaimGuardrail: { state: 'ran', verdict: 'rejected' },
        recommendationConfidence: { state: 'not_applicable' },
      },
      // Differs from `response_text` above — exercises `draftDiscarded`.
      draftAnswer: `Draft: ${REGULATED.dilution} plus an unverified off-label claim.`,
    },
    workflow_run_id: 'wf-aaa',
  }),
  // CASE_B keeps the default `ttft_ms: null` — an older attempt that predates the streaming
  // instrumentation, so its speed is scored from the total alone rather than a zero-filled TTFT.
  resultItem({
    test_item_id: CASE_B,
    elapsed_ms: 7500,
    passed: false,
    status: 'failed',
    response_text: REGULATED.contactTime,
  }),
  resultItem({
    test_item_id: CASE_C,
    elapsed_ms: 12000,
    ttft_ms: 4000,
    passed: false,
    status: 'failed',
    response_text: REGULATED.concentration,
  }),
  // CASE_D has no result row at all — the Unable-to-Evaluate path.
];

/**
 * B0-809 — the grader's per-concept verdicts, persisted on each score. Completeness is computed
 * from `expected` coverage (B0-813): A 2/2 → 100, B 1/2 → 50, C 0/2 → 0. Mandatory ⊆ expected.
 */
const CONCEPTS_A: CaseConcepts = {
  mandatory: { required: ['States the 1:64 ratio.'], satisfied: ['States the 1:64 ratio.'], missing: [] },
  expected: {
    required: ['States the 1:64 ratio.', REGULATED.metric],
    satisfied: ['States the 1:64 ratio.', REGULATED.metric],
    missing: [],
  },
  materialIssue: false,
  materialIssueNote: null,
};
/**
 * The 600 ppm qualifier is a must-have here, and it was missed — so under B0-835 this case is
 * gated: the ceiling would cap it at 59, which its own arithmetic already reaches, and the Result
 * is Fail. It is the "close to the ideal and still failing" cell in the judged-metrics rollup.
 */
const CONCEPTS_B: CaseConcepts = {
  mandatory: {
    required: ['Dwell time is 10 minutes.', 'The 600 ppm qualifier.'],
    satisfied: ['Dwell time is 10 minutes.'],
    missing: ['The 600 ppm qualifier.'],
  },
  expected: {
    required: ['Dwell time is 10 minutes.', 'The 600 ppm qualifier.'],
    satisfied: ['Dwell time is 10 minutes.'],
    missing: ['The 600 ppm qualifier.'],
  },
  materialIssue: false,
  materialIssueNote: null,
};
const CONCEPTS_C: CaseConcepts = {
  mandatory: {
    required: ['Names the active ingredient family.'],
    satisfied: [],
    missing: ['Names the active ingredient family.'],
  },
  expected: {
    required: ['Names the active ingredient family.', 'States the 5.25% concentration.'],
    satisfied: [],
    missing: ['Names the active ingredient family.', 'States the 5.25% concentration.'],
  },
  materialIssue: true,
  materialIssueNote: 'Called the active a phenolic; the label lists a quaternary ammonium at 5.25%.',
};

const CASE_SCORES: Record<string, CaseScore> = {
  // 0.4·92 + 0.3·100 + 0.2·95 + 0.1·90 = 94.8 → 95, A, Pass.
  [CASE_A]: score({
    accuracy: 92,
    relevance: 95,
    clarity: 90,
    explanation: 'Quoted the ratio exactly as printed on the label.',
    missed: 'Did not restate the metric equivalent.',
    incorrect: 'Nothing incorrect.',
    improvement: 'Cite the label section number.',
    concepts: CONCEPTS_A,
    similarity: 0.92,
    similarityNote: 'Everything the ideal says, plus the metric equivalent.',
    evalConfidence: 94,
    confidenceNote: 'Concrete golden; values match the label.',
  }),
  // 0.4·55 + 0.3·50 + 0.2·70 + 0.1·80 = 59; the must-have miss gates it — F, Fail (the 59 ceiling
  // is not reached from below, so the arithmetic stands and the gate takes no Pass away).
  [CASE_B]: score({
    accuracy: 55,
    relevance: 70,
    clarity: 80,
    explanation: 'Gave the dwell time but omitted the concentration it applies at.',
    missed: 'The 600 ppm qualifier.',
    incorrect: 'Implied the time applies at any dilution.',
    improvement: 'Always pair contact time with concentration.',
    concepts: CONCEPTS_B,
    // Close to the ideal and still failing — the "shape right, substance wrong" cell.
    similarity: 0.7,
    similarityNote: 'Has the dwell; missing the concentration it applies at.',
    evalConfidence: 62,
    confidenceNote: 'The golden implies the 600 ppm qualifier rather than stating it.',
  }),
  // 0.4·30 + 0.3·0 + 0.2·50 + 0.1·60 = 28, F, Fail — gated on a must-have miss, with a material
  // issue that would have withheld the floor anyway. Already below the ceiling, so it stands at 28.
  [CASE_C]: score({
    accuracy: 30,
    relevance: 50,
    clarity: 60,
    explanation: 'Named the wrong active ingredient family.',
    missed: 'The 5.25% concentration.',
    incorrect: 'Called it a phenolic.',
    improvement: 'Read actives off the label, not the SDS summary.',
    concepts: CONCEPTS_C,
  }),
  [CASE_D]: score({
    unableToEvaluate: true,
    uteReason: 'No result recorded for this item in this run.',
  }),
};

const SYNTHESIS: ReportSynthesis = {
  failurePatterns: ['Drops the concentration qualifier', 'Confuses actives across product lines'],
  strengths: ['Transcribes ratios verbatim', 'Stays inside label scope'],
  weaknesses: ['Weak on actives', 'Inconsistent unit reporting'],
  top3: [
    {
      priority: 1,
      what: 'Pair every contact time with its concentration',
      whyFirst: 'Highest regulatory exposure of the three.',
      evidence: 'Two Tier 1 cases dropped the qualifier.',
      affected: 'All disinfection prompts.',
      change: 'Add a grounding rule to the product prompt.',
      impact: 'Expected to lift Tier 1 accuracy materially.',
    },
    {
      priority: 2,
      what: 'Read actives off the label',
      whyFirst: 'Second most frequent failure.',
      evidence: 'One Tier 2 case named the wrong family.',
      affected: 'Actives and hazard questions.',
      change: 'Prefer label actives over SDS summaries.',
      impact: 'Removes a class of wrong-family answers.',
    },
    {
      priority: 3,
      what: 'Report metric equivalents when printed',
      whyFirst: 'Cheapest of the three to fix.',
      evidence: 'Metric equivalent omitted on the strongest case.',
      affected: 'Canadian-scope prompts.',
      change: 'Echo both imperial and metric when both appear.',
      impact: 'Improves completeness without risk.',
    },
  ],
  exec: {
    strongestAreas: ['Verbatim ratio transcription'],
    improvementAreas: ['Actives identification'],
    mostSignificantFailure: 'Contact time reported without its concentration.',
    majorRisk: 'A user could under-dose a disinfectant.',
    readiness: 'Not ready for broader testing without the Priority 1 fix.',
  },
};

/** B0-825 — what the fixture report was "graded with", as `gradingConfigFromState` would read it. */
const CONFIG = {
  model: 'gpt-5.6',
  effort: null as string | null,
  passes: 1,
  spreadThreshold: 10,
  passMark: 60,
  scoringRules: DEFAULT_SCORING_RULES,
  gradingPromptHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  judgedThresholds: {
    simHigh: 0.75,
    simLow: 0.4,
    lowConfidence: 70,
    highSimFail: 0.6,
    lowSimPass: 0.5,
    corrMinN: 5,
  },
};

function buildFixture() {
  const assembled = assembleReportData({
    test: TEST_RECORD,
    run: RUN_RECORD,
    items: ITEMS,
    resultItems: RESULT_ITEMS,
    caseScores: CASE_SCORES,
    expectedSourceIndex: EXPECTED_SOURCE_INDEX,
    synthesis: SYNTHESIS,
    generatedAt: RUN_RECORD.report_generated_at!,
    config: CONFIG,
  });

  const markdown = renderReportMarkdown({
    test: assembled.test,
    run: assembled.run,
    metrics: assembled.metrics,
    cases: assembled.cases,
    synthesis: assembled.synthesis,
    generatedAt: assembled.generatedAt,
    config: assembled.config,
  });

  const parsed = reportDataResponseSchema.parse(toReportDataPayload(assembled));
  if (parsed.status !== 'ready') throw new Error('fixture should assemble a ready report');

  return { assembled, markdown, payload: parsed satisfies ReportDataReady };
}

describe('assembleReportData → report data contract', () => {
  it('produces a payload that satisfies the wire schema', () => {
    const { payload } = buildFixture();
    expect(payload.status).toBe('ready');
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.testId).toBe(TEST_ID);
    expect(payload.stale).toBe(false);
  });

  it('names the grading effort only when the grading model honoured one (B0-806)', () => {
    expect(gradingConfigLine(CONFIG, 70)).toContain('_Graded by gpt-5.6 · 1 independent pass');
    expect(gradingConfigLine({ ...CONFIG, model: 'claude-opus-5', effort: 'high' }, 70)).toContain(
      '_Graded by claude-opus-5 at high effort · 1 independent pass',
    );
    const { payload } = buildFixture();
    expect(payload.config!.effort).toBeNull();
  });

  it('walks every field renderReportMarkdown prints and finds it in the data contract', () => {
    const { markdown, payload } = buildFixture();
    const m = payload.metrics;
    const s = payload.synthesis;

    /** Reads a value out of the *payload* and proves the Markdown printed it. */
    const reachable: Array<[string, string]> = [];
    const check = (field: string, rendered: string | number) =>
      reachable.push([field, String(rendered)]);

    // --- Header ---
    check('testName', payload.testName);
    check('intendedAgent', `${payload.intendedAgent} workflow`);
    check('metrics.evaluated', `${m.evaluated} questions evaluated`);
    check('metrics.uteCount', `(+${m.uteCount} unable to evaluate)`);
    check('runId', `Run ${payload.runId}`);
    check('generatedAt', `Generated ${new Date(payload.generatedAt).toLocaleString()}`);

    // --- Grading configuration (B0-825) ---
    const cfg = payload.config!;
    check('config.model', `Graded by ${cfg.model}`);
    check('config.passes', `${cfg.passes} independent pass`);
    check('config.spreadThreshold', `spread threshold ${cfg.spreadThreshold}`);
    check('config.passMark', `pass mark ${cfg.passMark} (strict ${m.strictPassMark})`);
    check('config.judgedThresholds', `sim ≥ ${cfg.judgedThresholds!.simHigh} high / < ${cfg.judgedThresholds!.simLow} low · review ≤ ${cfg.judgedThresholds!.lowConfidence} confidence`);
    check('config.gradingPromptHash', `grading prompt ${cfg.gradingPromptHash!.slice(0, 12)}`);

    // --- Judged metrics rollup (B0-811) ---
    const j = m.judged!;
    check(
      'metrics.judged.similarity',
      `- Similarity to the Ideal Response: average **${j.similarity!.avg}**, median ${j.similarity!.median}, range ${j.similarity!.min}–${j.similarity!.max} (n=${j.similarity!.n}) — high (≥ ${j.thresholds.simHigh}) ${j.similarityBands.high} · mid ${j.similarityBands.mid} · low (< ${j.thresholds.simLow}) ${j.similarityBands.low}.`,
    );
    check(
      'metrics.judged.evalConfidence',
      `- Evaluator confidence: average **${j.evalConfidence!.avg}**, median ${j.evalConfidence!.median}, range ${j.evalConfidence!.min}–${j.evalConfidence!.max} (n=${j.evalConfidence!.n}).`,
    );
    for (const entry of j.highSimilarityFailures) {
      check('metrics.judged.highSimilarityFailures', `[${entry.id}](#${caseAnchorId(entry.id)}) (similarity ${entry.similarity}, scored ${entry.overall})`);
    }
    for (const entry of j.reviewQueue) {
      check('metrics.judged.reviewQueue', `| [${entry.id}](#${caseAnchorId(entry.id)}) | ${entry.question} | ${entry.evalConfidence} | ${entry.status} |`);
    }

    // --- Executive assessment ---
    check('metrics.overall.grade', `**Overall grade:** ${m.overall.grade}`);
    check('metrics.overall.avg', `(${m.overall.avg}/100)`);
    check('synthesis.exec.strongestAreas', s.exec.strongestAreas[0]);
    check('synthesis.exec.improvementAreas', s.exec.improvementAreas[0]);
    check('synthesis.exec.mostSignificantFailure', s.exec.mostSignificantFailure);
    check('synthesis.exec.majorRisk', `**Major risk:** ${s.exec.majorRisk}`);
    check('synthesis.exec.readiness', `**Readiness for broader testing:** ${s.exec.readiness}`);

    // --- Executive scorecard ---
    check(
      'metrics.overall (scorecard row)',
      `| ${m.overall.avg} / 100 | ${m.overall.grade} | ${m.overall.passPct}% (${m.overall.pass} of ${m.evaluated}) | ${m.evaluated} (+${m.uteCount} N/A) |`,
    );

    // --- Pass mark (B0-812) ---
    check('metrics.passMark', `_Pass mark ${m.passMark}: Pass at ${m.passMark} or above, Fail below.`);
    check(
      'metrics.strictPassMark / passOnlyUnderCurrentMark',
      m.passOnlyUnderCurrentMark.length > 0
        ? `would Fail at ${m.strictPassMark}: ${m.passOnlyUnderCurrentMark.map((id) => `[${id}](#${caseAnchorId(id)})`).join(', ')}`
        : `every Pass would still Pass at ${m.strictPassMark}`,
    );

    // --- Tier + category tables (whole row, so every RateBlock field is covered) ---
    for (const { name, block } of [...m.tiers, ...m.categories]) {
      check(
        `rate row: ${name}`,
        `| ${name} | ${block.n} | ${block.avg} | ${block.grade} | ${block.passPct}% | ${block.failPct}% |`,
      );
    }
    check(
      'metrics.strongest/weakestCategory',
      `_Strongest: ${m.strongestCategory} · Weakest: ${m.weakestCategory}_`,
    );

    // --- Responsiveness (B0-717/B0-718) ---
    const sp = m.speed!;
    check(
      'metrics.speed (headline)',
      `**Speed Performance Score: ${sp.avgScore}/100 (${sp.rating})** — median ${sp.medianScore}/100 across ${sp.n} timed cases.`,
    );
    for (const aggregate of [sp.metrics.ttft!, sp.metrics.total!]) {
      check(
        `metrics.speed.metrics.${aggregate.metric} (table row)`,
        `| ${aggregate.label} | ${aggregate.n} | ${aggregate.avgSeconds} ${sp.unit} | ${aggregate.medianSeconds} ${sp.unit} | ${aggregate.p90Label} | ${aggregate.minSeconds}–${aggregate.maxSeconds} ${sp.unit} | ${aggregate.avgScore} | ${aggregate.bands.good} / ${aggregate.bands.acceptable} / ${aggregate.bands.slow} |`,
      );
      check(
        `metrics.speed.metrics.${aggregate.metric} (extremes)`,
        `${aggregate.label} — fastest: ${aggregate.fastest.map((e) => `[${e.id}](#${caseAnchorId(e.id)}) (${e.seconds} ${sp.unit})`).join(', ')} · slowest: ${aggregate.slowest.map((e) => `[${e.id}](#${caseAnchorId(e.id)}) (${e.seconds} ${sp.unit})`).join(', ')}.`,
      );
      check(
        `metrics.speed.metrics.${aggregate.metric}.thresholds`,
        `${aggregate.label}: good ≤ ${aggregate.thresholds.good} ${sp.unit}, acceptable ≤ ${aggregate.thresholds.acceptable} ${sp.unit}, slow > ${aggregate.thresholds.acceptable} ${sp.unit}`,
      );
    }
    check(
      'metrics.speed.ratingDistribution',
      `Ratings: ${sp.ratingDistribution.map((r) => `${r.count} ${r.rating}`).join(' · ')}.`,
    );
    check(
      'metrics.speed.basisCounts',
      `Partial timings: ${sp.basisCounts.combined} cases scored from both timings, ${sp.basisCounts.ttftOnly} from TTFT alone and ${sp.basisCounts.totalOnly} from Total response time alone`,
    );
    check(
      'metrics.speed.weights',
      `_Weighting: TTFT ${sp.weights.ttft} · Total response time ${sp.weights.total}.`,
    );

    // --- Top 3 ---
    for (const rec of s.top3) {
      check(`top3[${rec.priority}].what`, `### Priority #${rec.priority}: ${rec.what}`);
      check(`top3[${rec.priority}].whyFirst`, `**Why first:** ${rec.whyFirst}`);
      check(`top3[${rec.priority}].evidence`, `**Evidence:** ${rec.evidence}`);
      check(`top3[${rec.priority}].affected`, `**Affected:** ${rec.affected}`);
      check(`top3[${rec.priority}].change`, `**Recommended change:** ${rec.change}`);
      check(`top3[${rec.priority}].impact`, `**Expected impact:** ${rec.impact}`);
    }

    // --- Per-case: glance row + full detail block ---
    for (const c of payload.cases) {
      check(`case[${c.id}].anchorId`, `[${c.id}](#${c.anchorId})`);
      check(`case[${c.id}].question`, `> **${c.question}**`);
      check(
        `case[${c.id}].tier/priorityRaw`,
        `**Tier / Priority:** ${c.tier}${c.priorityRaw != null ? ` (${c.priorityRaw})` : ''}`,
      );
      check(`case[${c.id}].category`, `**Category:** ${c.category}`);
      check(`case[${c.id}].actual`, c.actual);

      if (c.idealResponse) check(`case[${c.id}].idealResponse`, c.idealResponse);
      // B0-933 — the concept columns are arrays; the document prints each phrase quoted, verbatim.
      if (c.expectedConcepts.length > 0) {
        check(
          `case[${c.id}].expectedConcepts`,
          `**Expected concepts:** ${formatConceptList(c.expectedConcepts)}`,
        );
      }
      // B0-933 — the must-have line replaces `expectedShouldAnswer` and is ALWAYS printed once the
      // case records any expectation, so the reader is never left without the pass/fail axis.
      if (
        c.idealResponse ||
        c.expectedConcepts.length > 0 ||
        c.minimumConcepts.length > 0 ||
        c.expectedSources.length > 0
      ) {
        check(
          `case[${c.id}].minimumConcepts`,
          `**${MANDATORY_CONCEPTS_LABEL}:** ${
            c.minimumConcepts.length > 0
              ? formatConceptList(c.minimumConcepts)
              : NO_MANDATORY_CONCEPTS_NOTE
          }`,
        );
      }
      if (c.expectedSources.length > 0) {
        check(
          `case[${c.id}].expectedSources`,
          `**Expected sources:** ${c.expectedSources.map(formatExpectedSourceRef).join('; ')}`,
        );
      }

      if (c.unableToEvaluate) {
        check(`case[${c.id}].score.uteReason`, `**Reason:** ${c.score.uteReason}`);
        check(`case[${c.id}] glance row (UTE)`, `| ${c.tier} | — | — | Unable to Evaluate |`);
        expect(c.evaluated, `${c.id} must have no scoreline`).toBeNull();
        continue;
      }

      const e = c.evaluated!;
      // B0-835 — where the coverage cap bound, the Completeness cell carries both numbers.
      const completenessCell = e.coverageApplied
        ? `${e.completeness} (judged ${e.completenessJudged})`
        : String(e.completeness);
      check(
        `case[${c.id}].evaluated (sub-score row)`,
        `| ${e.accuracy} | ${completenessCell} | ${e.relevance} | ${e.clarity} | ${e.overall}/100 | ${e.grade} | ${e.status} |`,
      );
      check(
        `case[${c.id}] glance row`,
        `| ${c.tier} | ${e.overall} | ${e.grade} | ${e.status}${e.mandatoryMissing ? '†' : ''} |`,
      );
      // B0-835 — the Completeness line says where the number came from: the coverage share, or the
      // judged value capped at it.
      const coverageCounts = `${e.coverage.satisfied} of ${e.coverage.required} expected concept${e.coverage.required === 1 ? '' : 's'} communicated`;
      check(
        `case[${c.id}].evaluated.coverage`,
        e.coverageApplied
          ? `**Completeness:** judged ${e.completenessJudged}, capped at coverage ${e.completeness} (${coverageCounts}).`
          : `**Completeness:** ${e.completeness} — ${coverageCounts}.`,
      );
      // B0-835 — the diagnostic a gated case keeps: the arithmetic before the ceiling.
      if (e.ceilingApplied) {
        check(
          `case[${c.id}].evaluated.preGateScore`,
          `**Pre-Gate Content Score:** ${e.preGateScore}/100 (${e.preGateGrade})`,
        );
      }
      if (e.floorApplied) {
        check(
          `case[${c.id}].evaluated.floor`,
          `**Mandatory floor:** raised from ${e.weighted} to ${e.floor}`,
        );
      }
      // B0-938 — the whole golden list is now rendered as a ticked/crossed checklist, so every
      // required phrase must be reachable, not just the missed ones.
      if (e.mandatoryMissing) {
        for (const phrase of e.concepts.mandatory.missing) {
          check(`case[${c.id}].concepts.mandatory.missing`, `- ✗ "${phrase}"`);
        }
      }
      for (const phrase of e.concepts.mandatory.satisfied) {
        check(`case[${c.id}].concepts.mandatory.satisfied`, `- ✓ "${phrase}"`);
      }
      for (const phrase of e.concepts.expected.satisfied) {
        check(`case[${c.id}].concepts.expected.satisfied`, `- ✓ "${phrase}"`);
      }
      for (const phrase of e.concepts.expected.missing) {
        check(`case[${c.id}].concepts.expected.missing`, `- ✗ "${phrase}"`);
      }
      if (e.materialIssue) {
        check(
          `case[${c.id}].concepts.materialIssueNote`,
          `**Material factual issue:** ${e.concepts.materialIssueNote}`,
        );
      }
      // B0-835 — the skill's one-sentence explanation, printed where the labelled lines above have
      // not already said it (the same de-duplication rule `renderReportMarkdown` applies).
      if (
        e.conceptNote &&
        !e.floorApplied &&
        e.statusSource !== 'auto_pass' &&
        !e.autoPassBlocked
      ) {
        check(`case[${c.id}].evaluated.conceptNote`, `**Concept rules:** ${e.conceptNote}`);
      }
      // B0-811 — the judged line, where the grader authored the metrics.
      if (e.similarity != null) {
        check(
          `case[${c.id}].evaluated.similarity`,
          `similarity to the Ideal Response ${e.similarity} — ${e.similarityNote}`,
        );
        check(
          `case[${c.id}].evaluated.evalConfidence`,
          `evaluator confidence ${e.evalConfidence}/100 — ${e.confidenceNote}`,
        );
      }
      const speed = c.speed!;
      check(
        `case[${c.id}].speed`,
        `**Speed (reported separately; not part of the content grade):** ${[
          speed.ttft ? `TTFT ${speed.ttft.seconds} s — ${speed.ttft.score}/100 (${speed.ttft.band})` : null,
          speed.total
            ? `Total response time ${speed.total.seconds} s — ${speed.total.score}/100 (${speed.total.band})`
            : null,
          `Speed Performance Score ${speed.score}/100 (${speed.rating})`,
          speed.basis === 'total_only'
            ? 'scored from Total response time alone — no TTFT was recorded'
            : null,
        ]
          .filter(Boolean)
          .join(' · ')}`,
      );
      if (c.harness) {
        const h = c.harness;
        const bits = [
          `harness result: ${h.passed ? 'passed' : 'failed'}`,
          h.similarity != null ? `similarity ${h.similarity.toFixed(2)}` : null,
          h.answerProvenance ? `answer provenance: ${h.answerProvenance}` : null,
          h.routingDecision ? `routing: ${h.routingDecision}` : null,
          h.gates.length > 0
            ? `gates fired: ${h.gates.map((g) => `${g.name}: ${g.verdict}`).join(', ')}`
            : null,
          h.draftDiscarded ? 'draft discarded' : null,
          h.chunkCount > 0 ? `retrieved chunks: ${h.chunkCount}` : null,
        ].filter(Boolean);
        check(`case[${c.id}].harness`, `**Harness signal:** ${bits.join(' · ')}`);
      }
      check(`case[${c.id}].score.explanation`, `**Explanation of the grade:** ${c.score.explanation}`);
      check(`case[${c.id}].score.missed`, `**Important information missed:** ${c.score.missed}`);
      check(
        `case[${c.id}].score.incorrect`,
        `**Incorrect, misleading, or unsupported information:** ${c.score.incorrect}`,
      );
      check(`case[${c.id}].score.improvement`, `**Recommended improvement:** ${c.score.improvement}`);
    }

    // --- Aggregate findings ---
    check(
      'metrics.totalCases',
      `- Total questions evaluated: ${m.evaluated} (plus ${m.uteCount} unable to evaluate; ${m.totalCases} total)`,
    );
    check('metrics.overall.avg (aggregate)', `- Average score: ${m.overall.avg} / 100`);
    check('metrics.overall.grade (aggregate)', `- Overall letter grade: ${m.overall.grade}`);
    check(
      'metrics.overall.pass',
      `- Pass: ${m.overall.pass} of ${m.evaluated} (${m.overall.passPct}%) at pass mark ${m.passMark}`,
    );
    check(
      'metrics.overall.fail',
      `- Fail: ${m.overall.fail} of ${m.evaluated} (${m.overall.failPct}%)`,
    );
    check(
      'metrics.highest',
      `- Highest scoring: ${m.highest.map((h) => `[${h.id}](#${caseAnchorId(h.id)}) (${h.overall})`).join(', ')}`,
    );
    check(
      'metrics.lowest',
      `- Lowest scoring: ${m.lowest.map((h) => `[${h.id}](#${caseAnchorId(h.id)}) (${h.overall})`).join(', ')}`,
    );
    for (const pattern of s.failurePatterns) check('synthesis.failurePatterns', `- ${pattern}`);
    for (const strength of s.strengths) check('synthesis.strengths', `- ${strength}`);
    for (const weakness of s.weaknesses) check('synthesis.weaknesses', `- ${weakness}`);

    // `metrics.perCase` backs every glance/sub-score row above; assert the join is complete too.
    expect(m.perCase.map((c) => c.id).sort()).toEqual(
      payload.cases.filter((c) => !c.unableToEvaluate).map((c) => c.id).sort(),
    );
    // `metrics.ute` mirrors the UTE cases.
    expect(m.ute.map((u) => u.id)).toEqual(
      payload.cases.filter((c) => c.unableToEvaluate).map((c) => c.id),
    );

    const missing = reachable.filter(([, rendered]) => !markdown.includes(rendered));
    expect(missing, `not reachable from the data contract:\n${JSON.stringify(missing, null, 2)}`)
      .toEqual([]);
    // Guard against the walk itself being accidentally emptied.
    expect(reachable.length).toBeGreaterThan(60);
  });

  it('orders cases exactly as the Markdown does and exposes matching anchors', () => {
    const { markdown, payload } = buildFixture();

    expect(payload.cases.map((c) => c.tier)).toEqual([
      'Tier 1',
      'Tier 1',
      'Tier 2',
      'Unspecified',
    ]);
    expect(payload.cases.map((c) => c.anchorId)).toEqual(
      payload.cases.map((c) => caseAnchorId(c.id)),
    );

    const positions = payload.cases.map((c) => markdown.indexOf(`> \`${c.id}\``));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('flags UTE cases and excludes them from every average exactly as computeReportMetrics does', () => {
    const { payload } = buildFixture();
    const m = payload.metrics;

    const ute = payload.cases.find((c) => c.id === CASE_D)!;
    expect(ute.unableToEvaluate).toBe(true);
    expect(ute.evaluated).toBeNull();
    expect(ute.score.uteReason).toBe('No result recorded for this item in this run.');
    expect(ute.responseRecorded).toBe(false);
    expect(ute.actual).toBe('(no response recorded)');

    expect(m.totalCases).toBe(4);
    expect(m.uteCount).toBe(1);
    expect(m.evaluated).toBe(3);
    expect(m.ute.map((u) => u.id)).toEqual([CASE_D]);
    expect(m.overall.n).toBe(3);
    expect(m.overall.pass + m.overall.fail).toBe(3);
    // The UTE case's tier is "Unspecified" and must not appear as a tier group at all.
    expect(m.tiers.map((t) => t.name)).toEqual(['Tier 1', 'Tier 2']);
    expect(m.tiers.reduce((sum, t) => sum + t.block.n, 0)).toBe(m.evaluated);
    expect(m.categories.reduce((sum, c) => sum + c.block.n, 0)).toBe(m.evaluated);
    expect(m.warnings).toEqual([]);
  });

  it('carries regulated values through verbatim — no rounding, coercion or unit conversion', () => {
    const { payload } = buildFixture();
    const byId = new Map(payload.cases.map((c) => [c.id, c]));

    const a = byId.get(CASE_A)!;
    expect(a.idealResponse).toBe(REGULATED.dilution);
    expect(a.expectedConcepts).toEqual([REGULATED.metric]);
    expect(a.minimumConcepts).toEqual(['States the 1:64 ratio.']);
    // B0-933 — uuids resolved to titles; the EPA number in the title survives byte-for-byte, and
    // the purged id is still listed rather than dropped.
    expect(a.expectedSources).toEqual([
      {
        id: LABEL_DOC_ID,
        title: `pH7Q Dual product label — ${REGULATED.epa}`,
        documentKind: 'label',
        resolved: true,
      },
      { id: PURGED_DOC_ID, title: null, documentKind: null, resolved: false },
    ]);
    // response_text was stored with surrounding whitespace; only that is stripped.
    expect(a.actual).toBe(`${REGULATED.dilution} ${REGULATED.metric}`);
    expect(a.actual).toContain('1:64');
    expect(a.actual).toContain('2 oz/gal');
    expect(a.actual).toContain('15.6 mL/L');

    const b = byId.get(CASE_B)!;
    expect(b.idealResponse).toBe(REGULATED.contactTime);
    expect(b.actual).toContain('10 minutes');
    expect(b.actual).toContain('600 ppm');

    const c = byId.get(CASE_C)!;
    expect(c.idealResponse).toBe(REGULATED.concentration);
    expect(c.actual).toContain('5.25%');

    // Sub-scores and latency at source precision; Completeness computed from 2/2 coverage.
    expect(a.score.accuracy).toBe(92);
    expect(a.evaluated!.completeness).toBe(100);
    expect(a.evaluated!.overall).toBe(95);
    expect(a.latencyMs).toBe(3200);
    expect(a.latencySeconds).toBe(3.2);
    // B0-715 — ms → s exactly once, at the assembly boundary.
    expect(a.ttftMs).toBe(1200);
    expect(a.ttftSeconds).toBe(1.2);
    expect(a.harness).toEqual({
      passed: true,
      status: 'ok',
      similarity: 0.83,
      answerProvenance: 'model_generated',
      routingDecision: 'llm',
      gates: [{ name: 'regulatedClaimGuardrail', verdict: 'rejected' }],
      draftDiscarded: true,
      chunkCount: 3,
    });
    // B0-863 — top-level mirrors, so a report-export consumer need not dig into `harness`.
    expect(a.answerProvenance).toBe('model_generated');
    expect(a.routingDecision).toBe('llm');
    expect(a.retrievedDocumentIds).toEqual(['doc-label-1', 'doc-sds-9']);
    expect(a.workflowRunId).toBe('wf-aaa');
    expect(a.speed!.total!.band).toBe('good');
    expect(a.speed!.ttft!.band).toBe('good');
    expect(a.speed!.basis).toBe('combined');
    // CASE_B recorded no first token: total only, and no zero stood in for the missing metric.
    const bSpeed = byId.get(CASE_B)!;
    expect(bSpeed.ttftMs).toBeNull();
    expect(bSpeed.ttftSeconds).toBeNull();
    expect(bSpeed.speed!.basis).toBe('total_only');
    expect(bSpeed.speed!.ttft).toBeNull();
    expect(bSpeed.speed!.total!.band).toBe('acceptable');
    expect(byId.get(CASE_C)!.speed!.total!.band).toBe('slow');
    // CASE_D has no result row at all, so it has no speed entry — not a zero-scored one.
    expect(byId.get(CASE_D)!.speed).toBeNull();
  });

  it('B0-863 — harness provenance defaults cleanly when a run predates or never triggered it', () => {
    const { payload } = buildFixture();
    const byId = new Map(payload.cases.map((c) => [c.id, c]));

    // CASE_B/CASE_C have a result row but no `answer_provenance`/`routing_decision` columns and no
    // `activeGates`/`draftAnswer` in `response_payload` — every new field defaults rather than
    // throwing or inventing a value.
    const b = byId.get(CASE_B)!;
    expect(b.harness).toEqual({
      passed: false,
      status: 'failed',
      similarity: null,
      answerProvenance: null,
      routingDecision: null,
      gates: [],
      draftDiscarded: false,
      chunkCount: 0,
    });
    expect(b.answerProvenance).toBeNull();
    expect(b.routingDecision).toBeNull();

    // CASE_D has no result row at all: harness (and its top-level mirrors) stay null, not a
    // zero-valued/empty harness object standing in for "no data".
    const d = byId.get(CASE_D)!;
    expect(d.harness).toBeNull();
    expect(d.answerProvenance).toBeNull();
    expect(d.routingDecision).toBeNull();
  });

  it('marks a report stale when the dataset gained items after generation', () => {
    const assembled = assembleReportCases({
      test: TEST_RECORD,
      run: RUN_RECORD,
      items: [...ITEMS, item({ id: 'ffffffff-eeee-4eee-8eee-eeeeeeeeeeee', prompt: 'Added later' })],
      resultItems: RESULT_ITEMS,
      caseScores: CASE_SCORES,
    });

    expect(assembled.stale).toBe(true);
    const added = assembled.cases.find((c) => c.question === 'Added later')!;
    expect(added.unableToEvaluate).toBe(true);
    expect(added.evaluated).toBeNull();
    // Still excluded from every average, so the numbers stay internally consistent.
    expect(assembled.metrics.evaluated).toBe(3);
    expect(assembled.metrics.uteCount).toBe(2);
  });

  it('returns an explicit not-generated state rather than an empty object', () => {
    const never = reportDataResponseSchema.parse(toNotGeneratedPayload(RUN_ID, null));
    expect(never).toEqual({
      ok: true,
      status: 'not_generated',
      runId: RUN_ID,
      reportStatus: null,
      totalCases: 0,
      completedCases: 0,
      error: null,
    });

    const inProgress = reportDataResponseSchema.parse(
      toNotGeneratedPayload(RUN_ID, {
        status: 'scoring',
        model: 'gpt-4.1',
        totalCases: 40,
        completedCases: 15,
        startedAt: '2026-08-03T11:00:00.000Z',
        updatedAt: '2026-08-03T11:05:00.000Z',
        caseScores: {},
        synthesis: null,
        error: null,
        overall: null,
      }),
    );
    expect(inProgress.status).toBe('not_generated');
    if (inProgress.status === 'not_generated') {
      expect(inProgress.reportStatus).toBe('scoring');
      expect(inProgress.completedCases).toBe(15);
      expect(inProgress.totalCases).toBe(40);
    }
  });
});

/**
 * B0-809 / B0-813 — the concept block is the grader's, persisted on the case's score; nothing is
 * read from the harness's `criteriaGrading` any more. A case whose grader saw no concept columns
 * has no block and is Unable to Evaluate. These cases use their own fixture so the contract walk
 * above stays focused on the wire shape.
 */
describe('assembleReportCases → per-concept verdicts (B0-809)', () => {
  const CASE_CRITERIA = '55555555-eeee-4eee-8eee-eeeeeeeeeeee';
  const CASE_NO_CRITERIA = '66666666-ffff-4fff-8fff-ffffffffffff';
  const CASE_EXACT_MISS = '77777777-9999-4999-8999-999999999999';

  const CONCEPT_ITEMS: TestItemRecord[] = [
    item({
      id: CASE_CRITERIA,
      row_index: 0,
      prompt: 'What is the dilution ratio and dwell time?',
      prompt_category: 'Dilution',
      priority: 1,
      minimum_concepts: ['Dilute 1:64 (2 oz/gal)', REGULATED.contactTime],
      expected_concepts: ['Dilute 1:64 (2 oz/gal)', REGULATED.contactTime, REGULATED.metric],
    }),
    item({
      id: CASE_NO_CRITERIA,
      row_index: 1,
      prompt: 'Is this product registered in Canada?',
      prompt_category: 'Registration',
      priority: 1,
    }),
    item({
      id: CASE_EXACT_MISS,
      row_index: 2,
      prompt: 'Quote the EPA registration number.',
      prompt_category: 'Registration',
      priority: 2,
      minimum_concepts: ['Names the product'],
      expected_concepts: ['Names the product', REGULATED.epa],
    }),
  ];

  const CONCEPT_RESULT_ITEMS: TestResultItemRecord[] = [
    resultItem({ test_item_id: CASE_CRITERIA, response_text: REGULATED.dilution }),
    resultItem({ test_item_id: CASE_NO_CRITERIA, response_text: 'Registered in Canada.' }),
    resultItem({ test_item_id: CASE_EXACT_MISS, response_text: 'EPA Reg. No. 6836-140-4171' }),
  ];

  /**
   * Even judged sub-scores and no judged Completeness — these stand in for passes graded in the
   * B0-813 window, where the coverage share is the only Completeness there is.
   */
  const CONCEPT_SCORES: Record<string, CaseScore> = {
    // 2 of 3 expected → 67: 0.4·84 + 0.3·67 + 0.2·84 + 0.1·84 = 78.9 → 79 pre-gate; the must-have
    // miss then caps it at 59 — F, Fail (B0-835).
    [CASE_CRITERIA]: score({
      accuracy: 84,
      relevance: 84,
      clarity: 84,
      concepts: {
        mandatory: {
          required: ['Dilute 1:64 (2 oz/gal)', REGULATED.contactTime],
          satisfied: ['Dilute 1:64 (2 oz/gal)'],
          missing: [REGULATED.contactTime],
        },
        expected: {
          required: ['Dilute 1:64 (2 oz/gal)', REGULATED.contactTime, REGULATED.metric],
          satisfied: ['Dilute 1:64 (2 oz/gal)', REGULATED.metric],
          missing: [REGULATED.contactTime],
        },
        materialIssue: false,
        materialIssueNote: null,
      },
    }),
    // The grader saw no concept columns → no block → Unable to Evaluate, whatever it judged.
    [CASE_NO_CRITERIA]: score({ accuracy: 84, relevance: 84, clarity: 84 }),
    // 1 of 2 expected → 50: 0.4·74 + 0.3·50 + 0.2·74 + 0.1·74 = 66.8 → 67, D, Pass; material issue.
    [CASE_EXACT_MISS]: score({
      accuracy: 74,
      relevance: 74,
      clarity: 74,
      concepts: {
        mandatory: { required: ['Names the product'], satisfied: ['Names the product'], missing: [] },
        expected: {
          required: ['Names the product', REGULATED.epa],
          satisfied: ['Names the product'],
          missing: [REGULATED.epa],
        },
        materialIssue: true,
        materialIssueNote: `Quoted EPA Reg. No. 6836-140-4171; the label reads "${REGULATED.epa}".`,
      },
    }),
  };

  function buildConceptFixture() {
    return assembleReportCases({
      test: TEST_RECORD,
      run: RUN_RECORD,
      items: CONCEPT_ITEMS,
      resultItems: CONCEPT_RESULT_ITEMS,
      caseScores: CONCEPT_SCORES,
    });
  }

  it('reads the concept block off the persisted score and computes Completeness from its coverage', () => {
    const assembled = buildConceptFixture();
    const c = assembled.cases.find((entry) => entry.id === CASE_CRITERIA)!;

    expect(c.concepts).not.toBeNull();
    expect(c.concepts!.mandatory.required).toEqual([
      'Dilute 1:64 (2 oz/gal)',
      REGULATED.contactTime,
    ]);
    expect(c.concepts!.mandatory.satisfied).toEqual(['Dilute 1:64 (2 oz/gal)']);
    expect(c.concepts!.mandatory.missing).toEqual([REGULATED.contactTime]);
    expect(c.concepts!.expected.required).toEqual([
      'Dilute 1:64 (2 oz/gal)',
      REGULATED.contactTime,
      REGULATED.metric,
    ]);

    // The block is the same object the metrics rated the case with.
    expect(c.evaluated!.concepts).toEqual(c.concepts);
    expect(c.evaluated!.completenessJudged).toBeNull();
    expect(c.evaluated!.coveragePct).toBe(67);
    expect(c.evaluated!.completeness).toBe(67);
    expect(c.evaluated!.coverage).toEqual({ satisfied: 2, required: 3 });
    // The arithmetic is kept as the Pre-Gate Content Score; the ceiling decides the score.
    expect(c.evaluated!.weighted).toBe(79);
    expect(c.evaluated!.preGateScore).toBe(79);
    expect(c.evaluated!.preGateGrade).toBe('C');
    expect(c.evaluated!.ceilingApplied).toBe(true);
    expect(c.evaluated!.overall).toBe(59);
    expect(c.evaluated!.grade).toBe('F');
    expect(c.evaluated!.status).toBe('Fail');
    expect(c.evaluated!.statusSource).toBe('minimal_gate');
    expect(c.evaluated!.mandatoryMissing).toBe(true);
    expect(c.evaluated!.gateBlockedAPass).toBe(true);
  });

  it('marks a case whose grader saw no concept columns Unable to Evaluate, never scoring it', () => {
    const assembled = buildConceptFixture();
    const c = assembled.cases.find((entry) => entry.id === CASE_NO_CRITERIA)!;

    expect(c.concepts).toBeNull();
    expect(c.unableToEvaluate).toBe(true);
    expect(c.evaluated).toBeNull();
    // The rendered record says what the metrics decided, with the reason — even though the stored
    // score itself was not marked UTE by the grader.
    expect(c.score.unableToEvaluate).toBe(true);
    expect(c.score.uteReason).toBe(NO_EXPECTED_CONCEPTS_UTE_REASON);
    expect(assembled.metrics.ute.map((u) => u.id)).toEqual([CASE_NO_CRITERIA]);
  });

  it('reports a material issue verbatim and withholds the floor for it', () => {
    const assembled = buildConceptFixture();
    const c = assembled.cases.find((entry) => entry.id === CASE_EXACT_MISS)!;

    expect(c.concepts!.materialIssue).toBe(true);
    expect(c.concepts!.materialIssueNote).toContain(REGULATED.epa);
    expect(c.concepts!.expected.missing).toEqual([REGULATED.epa]);
    expect(c.evaluated!.materialIssue).toBe(true);
    expect(c.evaluated!.completeness).toBe(50);
    // Every must-have satisfied, so the floor would have lifted this to 70 — the material issue on
    // a regulated value withholds it. (The automatic Pass was never in play: an expected concept
    // is missing too, so full expected coverage was not achieved.)
    expect(c.evaluated!.floorApplied).toBe(false);
    expect(c.evaluated!.autoPassBlocked).toBe(false);
    expect(c.evaluated!.autoPassTriggered).toBe(false);
    expect(c.evaluated!.overall).toBe(67);
    expect(c.evaluated!.status).toBe('Pass');
    expect(c.evaluated!.statusSource).toBe('rubric');
    expect(c.evaluated!.passesOnlyUnderCurrentMark).toBe(true);
  });

  it('rolls the run up over the evaluated cases only', () => {
    const { metrics } = buildConceptFixture();
    const rollup = metrics.concepts!;

    expect(rollup.casesWithConcepts).toBe(2);
    expect(rollup.mandatory.casesSpecifying).toBe(2);
    expect(rollup.mandatory.casesSatisfyingAll).toBe(1);
    expect(rollup.missingMandatory).toEqual([
      { id: CASE_CRITERIA, question: CONCEPT_ITEMS[0].prompt, missing: [REGULATED.contactTime] },
    ]);
    expect(rollup.materialIssues.map((entry) => entry.id)).toEqual([CASE_EXACT_MISS]);
    expect(metrics.passOnlyUnderCurrentMark).toEqual([CASE_EXACT_MISS]);
    // B0-835 — the rules that produced those numbers, and what each one did, travel with the run.
    expect(rollup.gatedIds).toEqual([CASE_CRITERIA]);
    expect(rollup.preventedIds).toEqual([CASE_CRITERIA]);
    // Neither case has full expected coverage, so no automatic Pass was in play either way.
    expect(rollup.autoPassIds).toEqual([]);
    expect(rollup.autoPassBlockedIds).toEqual([]);
    expect(metrics.scoringRules).toEqual(DEFAULT_SCORING_RULES);
    expect(metrics.gateFloor).toMatchObject({
      gateEnabled: true,
      cappedIds: [CASE_CRITERIA],
      flooredIds: [],
      coverageCappedIds: [],
    });
  });

  it('threads the persisted concept rules through assembly rather than defaulting them', () => {
    const assembled = assembleReportCases({
      test: TEST_RECORD,
      run: RUN_RECORD,
      items: CONCEPT_ITEMS,
      resultItems: CONCEPT_RESULT_ITEMS,
      caseScores: CONCEPT_SCORES,
      scoringRules: { ...DEFAULT_SCORING_RULES, minimalGate: { enabled: false } },
    });
    const c = assembled.cases.find((entry) => entry.id === CASE_CRITERIA)!;

    // Gate off ⇒ ceiling off, so the same case keeps its 79 and its Pass.
    expect(c.evaluated!.overall).toBe(79);
    expect(c.evaluated!.status).toBe('Pass');
    expect(assembled.metrics.scoringRules.minimalGate.enabled).toBe(false);
    expect(assembled.metrics.gateFloor.gateEnabled).toBe(false);
  });

  /**
   * Reachability, not wording: the *phrasing* of every concept line and legend belongs to
   * `render.ts` (rewritten for B0-835 alongside this). What this test defends is that the concept
   * block, the coverage counts, the glance marker and the regulated phrases all reach the document
   * at all — and that the marker sits on the row whose Result the gate decided.
   */
  it('renders the concept coverage, the glance marker and the phrases into the Markdown', () => {
    const assembled = buildConceptFixture();
    const markdown = renderReportMarkdown({
      test: assembled.test,
      run: assembled.run,
      metrics: assembled.metrics,
      cases: assembled.cases,
      synthesis: SYNTHESIS,
      generatedAt: RUN_RECORD.report_generated_at!,
    });

    expect(markdown).toContain('## Concept coverage');
    expect(markdown).toContain('**Concept coverage:** Mandatory 1/2 · Expected 2/3');
    // † on the gated row, whose Result is now Fail, and the marker legend with it.
    expect(markdown).toContain('| Fail† |');
    expect(markdown).toContain('†');
    // Concept phrases verbatim, both kinds.
    expect(markdown).toContain(REGULATED.contactTime);
    expect(markdown).toContain(REGULATED.epa);
  });

  it('makes a run whose scores carry no concept data entirely Unable to Evaluate', () => {
    const assembled = assembleReportCases({
      test: TEST_RECORD,
      run: RUN_RECORD,
      items: ITEMS,
      resultItems: RESULT_ITEMS,
      caseScores: Object.fromEntries(
        Object.entries(CASE_SCORES).map(([id, s]) => [id, { ...s, concepts: null }]),
      ),
    });
    const markdown = renderReportMarkdown({
      test: assembled.test,
      run: assembled.run,
      metrics: assembled.metrics,
      cases: assembled.cases,
      synthesis: SYNTHESIS,
      generatedAt: RUN_RECORD.report_generated_at!,
    });

    expect(assembled.metrics.evaluated).toBe(0);
    expect(assembled.metrics.uteCount).toBe(4);
    expect(assembled.metrics.concepts).toBeNull();
    expect(markdown).not.toContain('## Concept coverage');
    expect(markdown).not.toContain('†');
  });
});

/**
 * B0-853 — the category of record is the dataset's human-authored `question_category` (stored by
 * the CSV importer under `input_payload`), not the keyword classifier's `prompt_category` slug.
 * The same fixture ids as above, so the persisted `CASE_SCORES` still apply.
 */
describe('assembleReportData → category of record (B0-853)', () => {
  const CATEGORY_ITEMS: TestItemRecord[] = [
    // question_category present: wins over the classifier slug.
    item({
      ...ITEMS[0],
      input_payload: { question_category: 'Dilution and Directions' },
      prompt_category: 'dilution',
    }),
    // Absent: falls back to prompt_category.
    item({ ...ITEMS[1], input_payload: {}, prompt_category: 'recommendation' }),
    // Both absent: Uncategorized.
    item({ ...ITEMS[2], input_payload: {}, prompt_category: null }),
    // Whitespace-only question_category: treated as absent, falls back.
    item({
      ...ITEMS[3],
      input_payload: { question_category: '   ' },
      prompt_category: 'pathogen-specific',
    }),
  ];

  function assemble() {
    return assembleReportData({
      test: TEST_RECORD,
      run: RUN_RECORD,
      items: CATEGORY_ITEMS,
      resultItems: RESULT_ITEMS,
      caseScores: CASE_SCORES,
      expectedSourceIndex: EXPECTED_SOURCE_INDEX,
      synthesis: SYNTHESIS,
      generatedAt: RUN_RECORD.report_generated_at!,
      config: CONFIG,
    });
  }

  it('reads question_category first, prompt_category second, else Uncategorized', () => {
    const { cases } = assemble();
    const byId = new Map(cases.map((c) => [c.id, c.category]));
    expect(byId.get(CASE_A)).toBe('Dilution and Directions');
    expect(byId.get(CASE_B)).toBe('recommendation');
    expect(byId.get(CASE_C)).toBe('Uncategorized');
    expect(byId.get(CASE_D)).toBe('pathogen-specific');
  });

  it('groups the category table by the same resolved label the case record prints', () => {
    const { metrics, cases } = assemble();
    const evaluatedIds = new Set(metrics.perCase.map((c) => c.id));
    const expectedNames = new Set(
      cases.filter((c) => evaluatedIds.has(c.id)).map((c) => c.category),
    );
    expect(new Set(metrics.categories.map(([name]) => name))).toEqual(expectedNames);
    // The classifier slug of a case that carries a question_category never reaches the table.
    expect(metrics.categories.map(([name]) => name)).not.toContain('dilution');
  });
});

describe('assembleReportCases → multi-pass consolidation and consistency (B0-719/720/721)', () => {
  /**
   * Three independent passes per case, as `report_state.casePassScores` persists them. CASE_A's
   * passes straddle the Pass boundary; CASE_B's sit 20 points apart; CASE_C's agree exactly;
   * CASE_D's disagree about whether the case could be evaluated at all.
   */
  const CASE_PASS_SCORES: Record<string, CaseScore[]> = {
    [CASE_A]: [
      score({ accuracy: 92, relevance: 95, clarity: 90, explanation: 'p1', concepts: CONCEPTS_A }),
      score({ accuracy: 70, relevance: 80, clarity: 78, explanation: 'p2', concepts: CONCEPTS_A }),
      score({ accuracy: 88, relevance: 90, clarity: 86, explanation: 'p3', concepts: CONCEPTS_A }),
    ],
    [CASE_B]: [
      score({ accuracy: 55, relevance: 70, clarity: 80, explanation: 'p1', concepts: CONCEPTS_B }),
      score({ accuracy: 55, relevance: 70, clarity: 80, explanation: 'p2', concepts: CONCEPTS_B }),
      score({ accuracy: 35, relevance: 50, clarity: 60, explanation: 'p3', concepts: CONCEPTS_B }),
    ],
    [CASE_C]: [
      score({ accuracy: 30, relevance: 50, clarity: 60, explanation: 'p1', concepts: CONCEPTS_C }),
      score({ accuracy: 30, relevance: 50, clarity: 60, explanation: 'p2', concepts: CONCEPTS_C }),
      score({ accuracy: 30, relevance: 50, clarity: 60, explanation: 'p3', concepts: CONCEPTS_C }),
    ],
    [CASE_D]: [
      score({ unableToEvaluate: true, uteReason: 'No result recorded for this item in this run.' }),
      score({ unableToEvaluate: true, uteReason: 'No result recorded for this item in this run.' }),
      score({ accuracy: 40, relevance: 40, clarity: 40, concepts: CONCEPTS_A }),
    ],
  };

  function buildMultiPassFixture() {
    return assembleReportData({
      test: TEST_RECORD,
      run: RUN_RECORD,
      items: ITEMS,
      resultItems: RESULT_ITEMS,
      caseScores: CASE_SCORES,
      casePassScores: CASE_PASS_SCORES,
      expectedSourceIndex: EXPECTED_SOURCE_INDEX,
      spreadThreshold: 10,
      synthesis: SYNTHESIS,
      generatedAt: RUN_RECORD.report_generated_at!,
    });
  }

  it('serializes the variance and the consistency rollup onto the wire contract', () => {
    const parsed = reportDataResponseSchema.parse(toReportDataPayload(buildMultiPassFixture()));
    if (parsed.status !== 'ready') throw new Error('fixture should assemble a ready report');

    const con = parsed.metrics.consistency!;
    expect(con.passes).toBe(3);
    expect(con.casesConsolidated).toBe(4);
    expect(con.spreadThreshold).toBe(10);
    // Every queue entry deep-links to the ledger through the same anchor the Markdown links to.
    for (const entry of con.queue) {
      const match = parsed.cases.find((c) => c.id === entry.id)!;
      expect(match.anchorId).toBe(caseAnchorId(entry.id));
      expect(match.variance!.flagged).toBe(true);
    }
    // The unflagged case still carries its variance, so its spread is visible in the ledger.
    const agreed = parsed.cases.find((c) => c.id === CASE_C)!;
    expect(agreed.variance!.flagged).toBe(false);
    expect(agreed.variance!.range).toBe(0);
  });

  it('consolidates on the median sub-score, leaving the weighted maths to recompute', () => {
    const { metrics } = buildMultiPassFixture();
    const caseA = metrics.perCase.find((c) => c.id === CASE_A)!;

    // Medians of 92/70/88, 95/80/90, 90/78/86 — not the median of the three totals — and
    // Completeness from the majority coverage verdict (2 of 2), never a judged number.
    expect(caseA.accuracy).toBe(88);
    expect(caseA.completeness).toBe(100);
    expect(caseA.relevance).toBe(90);
    expect(caseA.clarity).toBe(86);
    expect(caseA.overall).toBe(Math.round(0.4 * 88 + 0.3 * 100 + 0.2 * 90 + 0.1 * 86));
  });

  it('renders the consistency section, the queue and the ⚑ marker into the Markdown', () => {
    const assembled = buildMultiPassFixture();
    const markdown = renderReportMarkdown({
      test: assembled.test,
      run: assembled.run,
      metrics: assembled.metrics,
      cases: assembled.cases,
      synthesis: SYNTHESIS,
      generatedAt: RUN_RECORD.report_generated_at!,
    });

    expect(markdown).toContain('## Grading consistency');
    expect(markdown).toContain('### Cases flagged for human review');
    expect(markdown).toContain('**Grading consistency:** 3 independent passes');
    // The third marker, and its legend, alongside the existing concept marks.
    expect(markdown).toContain('⚑');
    expect(markdown).toContain(
      '⚑ Flagged for human review — the independent grading passes disagreed.',
    );
    // The causes are named with the same words the React report uses.
    expect(markdown).toContain('Passes disagreed on Pass / Fail');
    expect(markdown).toContain('Passes disagreed on whether the case could be evaluated');
    // Every flagged case is linked back to its ledger entry.
    for (const entry of assembled.metrics.consistency!.queue) {
      expect(markdown).toContain(`[${entry.id}](#${caseAnchorId(entry.id)})`);
    }
  });

  it('omits every consistency readout from a single-pass report', () => {
    const { markdown, payload } = buildFixture();
    expect(payload.metrics.consistency).toBeNull();
    expect(payload.cases.every((c) => c.variance === null)).toBe(true);
    expect(markdown).not.toContain('## Grading consistency');
    expect(markdown).not.toContain('**Grading consistency:**');
    expect(markdown).not.toContain('⚑');
    expect(markdown).not.toContain('flagged for human review');
  });

  it('assembles a report persisted before per-pass scores exactly as it always did', () => {
    // No `casePassScores` at all — the legacy `report_state` shape.
    const legacy = assembleReportCases({
      test: TEST_RECORD,
      run: RUN_RECORD,
      items: ITEMS,
      resultItems: RESULT_ITEMS,
      caseScores: CASE_SCORES,
    });
    const { assembled } = buildFixture();

    expect(legacy.metrics.consistency).toBeNull();
    expect(legacy.metrics.overall).toEqual(assembled.metrics.overall);
    expect(legacy.cases.every((c) => c.variance === null)).toBe(true);
  });
});

/** B0-809 — a line-for-line port of the reference skill's `split_concepts`, asserted against it. */
describe('splitConcepts — the CSV-cell splitter, not the DB reader (B0-809/B0-933)', () => {
  it('splits on pipes within a line and on newlines', () => {
    expect(splitConcepts('a | b\nc')).toEqual(['a', 'b', 'c']);
    expect(splitConcepts('dwell time is non-negotiable | surface must stay visibly wet | reapply if drying')).toEqual([
      'dwell time is non-negotiable',
      'surface must stay visibly wet',
      'reapply if drying',
    ]);
  });

  it('splits on semicolons only when nothing else delimited the cell', () => {
    expect(splitConcepts('a; b')).toEqual(['a', 'b']);
    // A pipe already delimited this cell, so the semicolon stays inside its phrase.
    expect(splitConcepts('a | b; c')).toEqual(['a', 'b; c']);
    expect(splitConcepts('a | b\nc; d')).toEqual(['a', 'b', 'c; d']);
  });

  it('strips list markers at the start of each line, but does not split inline numbering', () => {
    expect(splitConcepts('- first\n- second')).toEqual(['first', 'second']);
    expect(splitConcepts('1. first\n2) second\n(3) third')).toEqual(['first', 'second', 'third']);
    expect(splitConcepts('• first\no second')).toEqual(['first', 'second']);
    // One line, no delimiter: the reference keeps it as one phrase after stripping the first marker.
    expect(splitConcepts('1. first 2. second')).toEqual(['first 2. second']);
  });

  it('never splits on a comma — a concept phrase routinely contains one', () => {
    expect(splitConcepts('Dilute at 2 oz/gal, then dwell for 10 minutes')).toEqual([
      'Dilute at 2 oz/gal, then dwell for 10 minutes',
    ]);
  });

  it('treats a blank cell or an empty-cell marker as no concepts, never a failure', () => {
    expect(splitConcepts(null)).toEqual([]);
    expect(splitConcepts(undefined)).toEqual([]);
    expect(splitConcepts('   ')).toEqual([]);
    for (const marker of ['n/a', 'N/A', 'na', 'none', 'None', '-', '—']) {
      expect(splitConcepts(marker)).toEqual([]);
    }
  });

  it('keeps regulated phrases byte-for-byte', () => {
    expect(splitConcepts(`${REGULATED.dilution} | ${REGULATED.contactTime} | ${REGULATED.epa}`)).toEqual([
      REGULATED.dilution,
      REGULATED.contactTime,
      REGULATED.epa,
    ]);
  });
});

/**
 * B0-933 — the wire contract has to keep opening a payload produced before `test_items` was
 * retyped, where the concept columns were one free-text cell and `expected_sources` was prose. The
 * live path never takes these branches (assembly passes arrays through), but a stored or cached
 * older payload must render rather than throw at the boundary.
 */
describe('reportCaseSchema — tolerance for pre-retype payload shapes (B0-933)', () => {
  function legacyCase(overrides: Record<string, unknown>) {
    const { payload } = buildFixture();
    if (payload.status !== 'ready') throw new Error('fixture should assemble a ready report');
    return { ...payload, cases: [{ ...payload.cases[0], ...overrides }] };
  }

  it('splits a legacy free-text concept cell with the CSV-cell rules', () => {
    const parsed = reportDataResponseSchema.parse(
      legacyCase({
        expectedConcepts: `${REGULATED.metric} | ${REGULATED.epa}`,
        minimumConcepts: REGULATED.metric,
      }),
    );
    if (parsed.status !== 'ready') throw new Error('legacy payload should still parse');
    expect(parsed.cases[0]!.expectedConcepts).toEqual([REGULATED.metric, REGULATED.epa]);
    expect(parsed.cases[0]!.minimumConcepts).toEqual([REGULATED.metric]);
  });

  it('keeps a legacy prose source cell verbatim, marked unresolved', () => {
    const parsed = reportDataResponseSchema.parse(
      legacyCase({ expectedSources: `Product label — ${REGULATED.epa}` }),
    );
    if (parsed.status !== 'ready') throw new Error('legacy payload should still parse');
    expect(parsed.cases[0]!.expectedSources).toEqual([
      {
        id: `Product label — ${REGULATED.epa}`,
        title: `Product label — ${REGULATED.epa}`,
        documentKind: null,
        resolved: false,
      },
    ]);
  });

  it('ignores a legacy expectedShouldAnswer key instead of rejecting the payload', () => {
    const parsed = reportDataResponseSchema.parse(legacyCase({ expectedShouldAnswer: false }));
    if (parsed.status !== 'ready') throw new Error('legacy payload should still parse');
    expect(parsed.cases[0]).not.toHaveProperty('expectedShouldAnswer');
  });
});
