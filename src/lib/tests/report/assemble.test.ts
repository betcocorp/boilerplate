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
import { splitConceptPhrases } from './case-concepts';
import { reportDataResponseSchema, type ReportDataReady } from './data-schemas';
import { caseAnchorId, renderReportMarkdown } from './render';
import type { CaseScore, ReportSynthesis } from './schemas';

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

/** Regulated strings that must survive assembly and serialization byte-for-byte. */
const REGULATED = {
  dilution: 'Dilute 1:64 (2 oz/gal) for routine cleaning; 1:32 (4 oz/gal) for heavy soil.',
  contactTime: 'Contact time: 10 minutes at 600 ppm active quat.',
  epa: 'EPA Reg. No. 6836-140-4170',
  concentration: 'Active: n-Alkyl dimethyl benzyl ammonium chloride 5.25%',
  metric: 'Metric equivalent as printed: 15.6 mL/L',
} as const;

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
    expected_should_answer: null,
    expected_result_type: null,
    expected_canonical_product: null,
    expected_reason_code: null,
    input_payload: {},
    metadata: {},
    created_at: '2026-08-01T00:00:00.000Z',
    prompt_category: null,
    priority: null,
    ideal_response: null,
    expected_concepts: null,
    minimum_concepts: null,
    expected_sources: null,
    should_cite: null,
    source: null,
    intended_agent_item: null,
    expected_criteria: {},
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
    expected_concepts: REGULATED.metric,
    minimum_concepts: 'States the 1:64 ratio.',
    expected_sources: `Product label — ${REGULATED.epa}`,
    expected_should_answer: true,
  }),
  item({
    id: CASE_B,
    row_index: 1,
    prompt: 'How long must the surface stay wet to disinfect?',
    prompt_category: 'Dilution',
    priority: 1,
    ideal_response: REGULATED.contactTime,
    expected_concepts: 'Dwell time is 10 minutes.',
    minimum_concepts: null,
    expected_sources: null,
    expected_should_answer: true,
  }),
  item({
    id: CASE_C,
    row_index: 2,
    prompt: 'Which active ingredient does this product use?',
    prompt_category: 'Disinfection',
    priority: 2,
    ideal_response: REGULATED.concentration,
    expected_concepts: null,
    minimum_concepts: null,
    expected_sources: null,
    expected_should_answer: false,
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
    passed: true,
    status: 'ok',
    response_text: `  ${REGULATED.dilution} ${REGULATED.metric}  `,
    response_payload: {
      sources: [
        { documentId: 'doc-label-1', chunkId: 'chunk-1', similarity: 0.83 },
        { documentId: 'doc-label-1', chunkId: 'chunk-2', similarity: 0.71 },
        { documentId: 'doc-sds-9', chunkId: 'chunk-3', similarity: 0.64 },
      ],
    },
    workflow_run_id: 'wf-aaa',
  }),
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
    passed: false,
    status: 'failed',
    response_text: REGULATED.concentration,
  }),
  // CASE_D has no result row at all — the Unable-to-Evaluate path.
];

const CASE_SCORES: Record<string, CaseScore> = {
  [CASE_A]: score({
    accuracy: 92,
    completeness: 88,
    relevance: 95,
    clarity: 90,
    explanation: 'Quoted the ratio exactly as printed on the label.',
    missed: 'Did not restate the metric equivalent.',
    incorrect: 'Nothing incorrect.',
    improvement: 'Cite the label section number.',
  }),
  [CASE_B]: score({
    accuracy: 55,
    completeness: 60,
    relevance: 70,
    clarity: 80,
    explanation: 'Gave the dwell time but omitted the concentration it applies at.',
    missed: 'The 600 ppm qualifier.',
    incorrect: 'Implied the time applies at any dilution.',
    improvement: 'Always pair contact time with concentration.',
  }),
  [CASE_C]: score({
    accuracy: 30,
    completeness: 40,
    relevance: 50,
    clarity: 60,
    explanation: 'Named the wrong active ingredient family.',
    missed: 'The 5.25% concentration.',
    incorrect: 'Called it a phenolic.',
    improvement: 'Read actives off the label, not the SDS summary.',
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

function buildFixture() {
  const assembled = assembleReportData({
    test: TEST_RECORD,
    run: RUN_RECORD,
    items: ITEMS,
    resultItems: RESULT_ITEMS,
    caseScores: CASE_SCORES,
    synthesis: SYNTHESIS,
    generatedAt: RUN_RECORD.report_generated_at!,
  });

  const markdown = renderReportMarkdown({
    test: assembled.test,
    run: assembled.run,
    metrics: assembled.metrics,
    cases: assembled.cases,
    synthesis: assembled.synthesis,
    generatedAt: assembled.generatedAt,
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

    // --- Tier + category tables (whole row, so every RateBlock field is covered) ---
    for (const { name, block } of [...m.tiers, ...m.categories]) {
      check(
        `rate row: ${name}`,
        `| ${name} | ${block.n} | ${block.avg} | ${block.grade} | ${block.passPct}% | ${block.partialPct}% | ${block.failPct}% |`,
      );
    }
    check(
      'metrics.strongest/weakestCategory',
      `_Strongest: ${m.strongestCategory} · Weakest: ${m.weakestCategory}_`,
    );

    // --- Responsiveness ---
    const lat = m.latency!;
    check(
      'metrics.latency (summary line)',
      `Average response time: **${lat.avg} s** (range ${lat.min}–${lat.max} s, median ${lat.median} s, n=${lat.n}).`,
    );
    check(
      'metrics.latency.thresholds/bands',
      `Bands (good ≤ ${lat.thresholds.good} s · acceptable ≤ ${lat.thresholds.slow} s · slow > ${lat.thresholds.slow} s): **${lat.bands.good} good, ${lat.bands.acceptable} acceptable, ${lat.bands.slow} slow**.`,
    );
    for (const slowest of lat.slowest) {
      check(
        `metrics.latency.slowest[${slowest.id}]`,
        `[${slowest.id}](#${caseAnchorId(slowest.id)}) (${slowest.seconds} s)`,
      );
    }
    check('metrics.latency.unit', ` ${lat.unit}`);

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
      if (c.expectedConcepts) {
        check(`case[${c.id}].expectedConcepts`, `**Expected concepts:** ${c.expectedConcepts}`);
      }
      if (c.minimumConcepts) {
        check(`case[${c.id}].minimumConcepts`, `**Minimum concepts:** ${c.minimumConcepts}`);
      }
      if (c.expectedSources) {
        check(`case[${c.id}].expectedSources`, `**Expected sources:** ${c.expectedSources}`);
      }
      if (c.expectedShouldAnswer != null) {
        check(
          `case[${c.id}].expectedShouldAnswer`,
          `**Should answer:** ${c.expectedShouldAnswer ? 'Yes' : 'No'}`,
        );
      }

      if (c.unableToEvaluate) {
        check(`case[${c.id}].score.uteReason`, `**Reason:** ${c.score.uteReason}`);
        check(`case[${c.id}] glance row (UTE)`, `| ${c.tier} | — | — | Unable to Evaluate |`);
        expect(c.evaluated, `${c.id} must have no scoreline`).toBeNull();
        continue;
      }

      const e = c.evaluated!;
      check(
        `case[${c.id}].evaluated (sub-score row)`,
        `| ${e.accuracy} | ${e.completeness} | ${e.relevance} | ${e.clarity} | ${e.overall}/100 | ${e.grade} | ${e.status} |`,
      );
      check(`case[${c.id}] glance row`, `| ${c.tier} | ${e.overall} | ${e.grade} | ${e.status} |`);
      check(
        `case[${c.id}].latencySeconds/latencyBand`,
        `**Response time:** ${c.latencySeconds} s (${c.latencyBand})`,
      );
      if (c.harness) {
        check(
          `case[${c.id}].harness`,
          `**Harness signal:** harness result: ${c.harness.passed ? 'passed' : 'failed'}${
            c.harness.similarity != null ? ` · similarity ${c.harness.similarity.toFixed(2)}` : ''
          }`,
        );
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
      `- Pass: ${m.overall.pass} of ${m.evaluated} (${m.overall.passPct}%)`,
    );
    check(
      'metrics.overall.partial',
      `- Partial Pass: ${m.overall.partial} of ${m.evaluated} (${m.overall.partialPct}%)`,
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
    expect(m.overall.pass + m.overall.partial + m.overall.fail).toBe(3);
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
    expect(a.expectedConcepts).toBe(REGULATED.metric);
    expect(a.expectedSources).toBe(`Product label — ${REGULATED.epa}`);
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

    // Sub-scores and latency at source precision.
    expect(a.score.accuracy).toBe(92);
    expect(a.evaluated!.overall).toBe(91);
    expect(a.latencyMs).toBe(3200);
    expect(a.latencySeconds).toBe(3.2);
    expect(a.harness).toEqual({ passed: true, status: 'ok', similarity: 0.83 });
    expect(a.retrievedDocumentIds).toEqual(['doc-label-1', 'doc-sds-9']);
    expect(a.workflowRunId).toBe('wf-aaa');
    expect(a.latencyBand).toBe('good');
    expect(byId.get(CASE_B)!.latencyBand).toBe('acceptable');
    expect(byId.get(CASE_C)!.latencyBand).toBe('slow');
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
 * B0-711 — the concept block is threaded in from the criteria grading the *run* persisted
 * (`test_result_items.response_payload.criteriaGrading`), not from a second grader call. These
 * cases use their own fixture so the contract walk above keeps exercising the concept-free path
 * that every legacy run takes.
 */
describe('assembleReportCases → per-concept verdicts (B0-711)', () => {
  const CASE_CRITERIA = '55555555-eeee-4eee-8eee-eeeeeeeeeeee';
  const CASE_NO_CRITERIA = '66666666-ffff-4fff-8fff-ffffffffffff';
  const CASE_EXACT_MISS = '77777777-9999-4999-8999-999999999999';

  /** `criteriaGrading` exactly as `~/lib/tests/runner.ts` writes it onto the payload. */
  function grading(
    verdicts: Array<{
      concept: string;
      tier: 1 | 2 | 3;
      match: 'semantic' | 'exact';
      met: boolean;
    }>,
  ) {
    return {
      criteriaGrading: {
        passed: verdicts.every((v) => v.tier !== 1 || v.met),
        score: 0.5,
        failureReason: null,
        verdicts: verdicts.map((v, index) => ({
          criterionIndex: index,
          met: v.met,
          evidence: v.met ? 'quoted' : '',
          concept: v.concept,
          tier: v.tier,
          match: v.match,
        })),
      },
    };
  }

  const CONCEPT_ITEMS: TestItemRecord[] = [
    item({
      id: CASE_CRITERIA,
      row_index: 0,
      prompt: 'What is the dilution ratio and dwell time?',
      prompt_category: 'Dilution',
      priority: 1,
      // Free text is present too — the block must still come from the verdicts, not from here.
      minimum_concepts: 'States the 1:64 ratio | States the 10 minute dwell',
      expected_concepts: 'States the 1:64 ratio | States the 10 minute dwell | Metric equivalent',
    }),
    item({
      id: CASE_NO_CRITERIA,
      row_index: 1,
      prompt: 'Is this product registered in Canada?',
      prompt_category: 'Registration',
      priority: 1,
      minimum_concepts: 'Names the DIN',
    }),
    item({
      id: CASE_EXACT_MISS,
      row_index: 2,
      prompt: 'Quote the EPA registration number.',
      prompt_category: 'Registration',
      priority: 2,
    }),
  ];

  const CONCEPT_RESULT_ITEMS: TestResultItemRecord[] = [
    resultItem({
      test_item_id: CASE_CRITERIA,
      response_text: REGULATED.dilution,
      response_payload: grading([
        { concept: 'Dilute 1:64 (2 oz/gal)', tier: 1, match: 'semantic', met: true },
        { concept: REGULATED.contactTime, tier: 1, match: 'semantic', met: false },
        { concept: REGULATED.metric, tier: 3, match: 'semantic', met: true },
      ]),
    }),
    resultItem({
      test_item_id: CASE_NO_CRITERIA,
      response_text: 'Registered in Canada.',
      response_payload: { sources: [] },
    }),
    resultItem({
      test_item_id: CASE_EXACT_MISS,
      response_text: REGULATED.epa,
      response_payload: grading([
        { concept: 'Names the product', tier: 1, match: 'semantic', met: true },
        { concept: REGULATED.epa, tier: 2, match: 'exact', met: false },
      ]),
    }),
  ];

  const CONCEPT_SCORES: Record<string, CaseScore> = {
    [CASE_CRITERIA]: score({ accuracy: 84, completeness: 84, relevance: 84, clarity: 84 }),
    [CASE_NO_CRITERIA]: score({ accuracy: 84, completeness: 84, relevance: 84, clarity: 84 }),
    [CASE_EXACT_MISS]: score({ accuracy: 74, completeness: 74, relevance: 74, clarity: 74 }),
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

  it('populates the concept block from the persisted criteria verdicts', () => {
    const assembled = buildConceptFixture();
    const c = assembled.cases.find((entry) => entry.id === CASE_CRITERIA)!;

    expect(c.concepts).not.toBeNull();
    // mandatory = tier 1 only; expected = the full criteria set.
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
    expect(c.concepts!.materialIssue).toBe(false);
    expect(c.concepts!.materialIssueNote).toBeNull();

    // The block is the same object the metrics rated the case with.
    expect(c.evaluated!.concepts).toEqual(c.concepts);
    expect(c.evaluated!.ratingConstrained).toBe(true);
    expect(c.evaluated!.grade).toBe('B');
    expect(c.evaluated!.status).toBe('Partial Pass');
  });

  it('gives a case with no persisted criteria no concept block at all', () => {
    const assembled = buildConceptFixture();
    const c = assembled.cases.find((entry) => entry.id === CASE_NO_CRITERIA)!;

    // Free text in `minimum_concepts` alone is not a usable block — a blank cell is not a failure.
    expect(c.concepts).toBeNull();
    expect(c.evaluated!.concepts).toBeNull();
    expect(c.evaluated!.status).toBe('Pass');
    expect(c.evaluated!.statusSource).toBe('rubric');
    expect(c.evaluated!.ratingConstrained).toBe(false);
  });

  it('flags a failed exact-match check as a material issue and names the concept verbatim', () => {
    const assembled = buildConceptFixture();
    const c = assembled.cases.find((entry) => entry.id === CASE_EXACT_MISS)!;

    expect(c.concepts!.materialIssue).toBe(true);
    expect(c.concepts!.materialIssueNote).toContain(REGULATED.epa);
    // The failed exact criterion is itself part of the expected set, so coverage is not full and
    // the automatic Pass never had a chance to fire (the withholding branch stays a guard — see
    // `applyConceptRules`). The case keeps its rubric Result.
    expect(c.evaluated!.autoPassTriggered).toBe(false);
    expect(c.evaluated!.statusSource).toBe('rubric');
    expect(c.evaluated!.status).toBe('Partial Pass');
    expect(c.concepts!.expected.missing).toEqual([REGULATED.epa]);
  });

  it('rolls the run up with the concept-free case excluded from the denominators', () => {
    const rollup = buildConceptFixture().metrics.concepts!;

    expect(rollup.casesWithConcepts).toBe(2);
    expect(rollup.mandatory.casesSpecifying).toBe(2);
    expect(rollup.mandatory.casesSatisfyingAll).toBe(1);
    expect(rollup.missingMandatory).toEqual([
      { id: CASE_CRITERIA, question: CONCEPT_ITEMS[0].prompt, missing: [REGULATED.contactTime] },
    ]);
    expect(rollup.gateBlockedPasses).toBe(1);
    expect(rollup.autoPassBlocked).toEqual([]);
  });

  it('renders the concept lines and the glance markers into the Markdown', () => {
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
    expect(markdown).toContain(`**Missing mandatory concepts:** "${REGULATED.contactTime}"`);
    expect(markdown).toContain('**Rating constrained:**');
    // † on the gated row, and a legend for it.
    expect(markdown).toContain('| Partial Pass† |');
    expect(markdown).toContain('† Rating constrained by a missing mandatory concept.');
    // Concept phrases verbatim.
    expect(markdown).toContain(REGULATED.epa);
  });

  it('leaves a run with no concept data free of every concept section', () => {
    const { markdown } = buildFixture();
    expect(markdown).not.toContain('## Concept coverage');
    expect(markdown).not.toContain('**Concept coverage:**');
    expect(markdown).not.toContain('Rating constrained');
    expect(markdown).not.toContain('†');
    expect(markdown).not.toContain('‡');
  });
});

describe('splitConceptPhrases (B0-711 fallback splitter)', () => {
  it('splits on pipes, newlines, bullets, numbered markers and semicolons', () => {
    expect(splitConceptPhrases('a | b\nc; d')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitConceptPhrases('- first\n- second')).toEqual(['first', 'second']);
    expect(splitConceptPhrases('1. first 2. second')).toEqual(['first', 'second']);
  });

  it('never splits on a comma — a concept phrase routinely contains one', () => {
    expect(splitConceptPhrases('Dilute at 2 oz/gal, then dwell for 10 minutes')).toEqual([
      'Dilute at 2 oz/gal, then dwell for 10 minutes',
    ]);
  });

  it('returns nothing for a blank or absent column', () => {
    expect(splitConceptPhrases(null)).toEqual([]);
    expect(splitConceptPhrases('   ')).toEqual([]);
  });
});
