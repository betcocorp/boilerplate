import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-832 — mocks for `gradeWithCriteria`'s model dependencies, so the collision-guardrail test
 * below can drive the real `gradeSemanticCriteria` → `aggregateCriteriaVerdicts` path with a
 * scripted model response, without a live API call. B0-908 — the seam is now the provider-neutral
 * `completeStructuredWithUsage`, not the OpenAI client.
 */
const { mockComplete, mockResolveModel, mockRecordGradingUsage } = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockResolveModel: vi.fn(async () => 'gpt-test'),
  mockRecordGradingUsage: vi.fn(),
}));
const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 };
vi.mock('~/lib/llm/structured-completion', () => ({
  completeStructuredWithUsage: mockComplete,
}));
vi.mock('~/lib/openai/client', () => ({
  resolveResponsesModel: mockResolveModel,
}));
// B0-1109 — recordGradingUsage talks to Supabase; stubbed so this stays a pure unit test.
vi.mock('./grading-usage', () => ({
  recordGradingUsage: mockRecordGradingUsage,
}));
vi.mock('~/lib/openai/transport-retry', () => ({
  resolveOpenAiRequestTimeoutMs: () => 1000,
  retryTransportFaults: (fn: () => unknown) => fn(),
}));
vi.mock('~/lib/workflows/product-support/max-output-tokens', () => ({
  resolveMaxOutputTokens: () => 1024,
}));

import { findDilutionEquivalence, gradeExactCriterion, gradeWithCriteria } from './criteria-grader';
import { GRADER_JSON_SCHEMA, type ExpectedCriterion } from './criteria-schemas';

/**
 * B0-803 — `gradeExactCriterion` is the deterministic guardrail for `match: 'exact'` criteria and,
 * via B0-538's `matchTerm`, for every regulated-looking multi-turn expectation term. The rule it
 * implements is pinned here: lower-case + collapse whitespace runs + trim on BOTH sides, and
 * nothing else. The positive cases prove capitalisation and line-wrapping no longer fail a correct
 * answer; the negative cases prove digits, units and punctuation are still matched exactly as
 * printed, so the fix cannot be over-loosened without a test going red.
 *
 * Figures below are matcher fixtures only — never an authored expectation about a real product.
 */

const ANSWER = 'Keep the surface wet for 2 minutes.';

describe('gradeExactCriterion — B0-803 case/whitespace normalisation', () => {
  it('matches an identical phrase and reports the original concept as evidence', () => {
    expect(gradeExactCriterion('2 minutes', ANSWER)).toEqual({
      criterionIndex: -1,
      met: true,
      evidence: '2 minutes',
    });
  });

  it('ignores capitalisation differences (the B0-236 failure mode)', () => {
    expect(gradeExactCriterion('2 Minutes', ANSWER)).toEqual({
      criterionIndex: -1,
      met: true,
      evidence: '2 Minutes',
    });
    expect(gradeExactCriterion('KEEP THE SURFACE WET', ANSWER).met).toBe(true);
    expect(gradeExactCriterion('epa reg. no. 1839-83', 'EPA Reg. No. 1839-83').met).toBe(true);
  });

  describe('whitespace runs collapse to a single space on both sides', () => {
    it.each([
      ['double space in the concept', '2  minutes', ANSWER],
      ['tab in the concept', '2\tminutes', ANSWER],
      ['newline in the concept', '2\nminutes', ANSWER],
      ['leading/trailing space in the concept', '  2 minutes  ', ANSWER],
      ['newline inside the phrase in the response', '2 minutes', 'Keep the surface wet for 2\nminutes.'],
      ['CRLF inside the phrase in the response', '10 minutes', 'contact time of 10\r\nminutes'],
      ['line-wrapped, indented response', '4 oz/gal', 'Dilute at 4\n   oz/gal for general cleaning.'],
    ])('%s', (_label, concept, response) => {
      expect(gradeExactCriterion(concept, response)).toEqual({
        criterionIndex: -1,
        met: true,
        evidence: concept,
      });
    });
  });

  describe('digits, units and punctuation stay literal', () => {
    it.each([
      ['4.0 is not 4', '4 oz/gal', 'Use 4.0 oz/gal.'],
      ['40 is not 4', '4 oz/gal', 'Use 40 oz/gal.'],
      ['20 minutes is not 2 minutes', '2 minutes', 'Keep the surface wet for 20 minutes.'],
      ['unit mismatch', '4 oz/gal', 'Use 4 oz/L.'],
      ['punctuation difference in a registration number', 'EPA Reg. No. 1839-83', 'EPA Reg No 1839-83'],
      ['ratio separator', '1:64', 'dilute 1-64'],
      ['decimal dropped', '0.5%', 'apply at 5%'],
    ])('%s: "%s" does not match "%s"', (_label, concept, response) => {
      expect(gradeExactCriterion(concept, response)).toEqual({
        criterionIndex: -1,
        met: false,
        evidence: '',
      });
    });
  });

  it('never matches an empty or whitespace-only concept', () => {
    for (const concept of ['', ' ', '   ', '\n', '\t\n ']) {
      expect(gradeExactCriterion(concept, ANSWER)).toEqual({
        criterionIndex: -1,
        met: false,
        evidence: '',
      });
    }
  });

  it('returns met:false with empty evidence when the concept is absent', () => {
    expect(gradeExactCriterion('30 seconds', ANSWER)).toEqual({
      criterionIndex: -1,
      met: false,
      evidence: '',
    });
  });

  it('never matches anything against an empty response', () => {
    expect(gradeExactCriterion('2 minutes', '').met).toBe(false);
  });
});

/**
 * B0-832 — reproduces the index-collision bug: an `exact` criterion at index 0 (checked
 * deterministically, never by the model) and a semantic criterion at index 1, where the grader
 * model mis-numbers its answer and claims `criterionIndex: 0` for the semantic verdict too. Before
 * the fix, `aggregateCriteriaVerdicts`'s `Map` silently let the later (semantic) entry win,
 * overwriting the deterministic exact verdict with the model's judgment — a false pass on
 * regulated content. The AC: the exact verdict must win, and the colliding semantic verdict must
 * be discarded (logged), never silently merged in.
 */
describe('gradeWithCriteria — B0-832 exact verdict cannot be overwritten on index collision', () => {
  beforeEach(() => {
    mockComplete.mockReset();
    mockResolveModel.mockReset();
    mockResolveModel.mockResolvedValue('gpt-test');
  });

  it('keeps the exact verdict at index 0 when a semantic verdict also claims index 0', async () => {
    // The response text does NOT contain "4 oz/gal" (the exact criterion), so the deterministic
    // check must fail it. The scripted model reply — mis-numbering its one semantic criterion as
    // index 0 instead of the real index 1 — must not be allowed to flip that to met:true.
    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        verdicts: [{ criterionIndex: 0, met: true, evidence: 'mentions dwell time' }],
      }),
      usage: USAGE,
    });

    const criteria: ExpectedCriterion[] = [
      { concept: '4 oz/gal', tier: 1, match: 'exact' },
      { concept: 'mentions dwell time', tier: 2, match: 'semantic' },
    ];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outcome = await gradeWithCriteria({
      prompt: 'How do I dilute this?',
      responseText: 'Leave the solution to dwell for 10 minutes before rinsing.',
      criteria,
    });

    expect(outcome).not.toBeNull();
    // The exact verdict (met:false, since "4 oz/gal" never appears in the response) must win —
    // not the colliding semantic verdict claiming met:true at the same index.
    expect(outcome!.verdicts[0]).toMatchObject({ criterionIndex: 0, met: false, match: 'exact' });
    // The real semantic criterion (index 1) never got a matching verdict from the model (it only
    // returned one for the colliding index 0), so it's treated as not-met rather than fabricated.
    expect(outcome!.verdicts[1]).toMatchObject({ criterionIndex: 1, met: false, match: 'semantic' });
    expect(outcome!.passed).toBe(false);
    // Logged, not silently merged in — the AC's explicit requirement.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('B0-832'));

    warnSpy.mockRestore();
  });

  it('applies a correctly-numbered semantic verdict normally (no collision)', async () => {
    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        verdicts: [{ criterionIndex: 1, met: true, evidence: 'dwell for 10 minutes' }],
      }),
      usage: USAGE,
    });

    const criteria: ExpectedCriterion[] = [
      { concept: '4 oz/gal', tier: 1, match: 'exact' },
      { concept: 'mentions dwell time', tier: 2, match: 'semantic' },
    ];

    const outcome = await gradeWithCriteria({
      prompt: 'How do I dilute this?',
      responseText: 'Dilute at 4 oz/gal and let it dwell for 10 minutes before rinsing.',
      criteria,
    });

    expect(outcome).not.toBeNull();
    expect(outcome!.verdicts[0]).toMatchObject({ met: true, match: 'exact' });
    expect(outcome!.verdicts[1]).toMatchObject({ met: true, match: 'semantic' });
    expect(outcome!.passed).toBe(true);
  });

  /**
   * B0-908 — a `claude-*` id resolved from `BEX_RESPONSES_MODEL` / the run's `modelTag` must reach
   * the provider-neutral helper unchanged, with the same prompt + schema bytes and the same
   * transport knobs the OpenAI call carried (`maxRetries: 0`, per-attempt timeout).
   */
  it('passes a resolved claude id through to completeStructuredWithUsage with the grader schema', async () => {
    mockResolveModel.mockResolvedValue('claude-sonnet-5');
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ verdicts: [{ criterionIndex: 0, met: true, evidence: 'ok' }] }),
      usage: USAGE,
    });

    const outcome = await gradeWithCriteria({
      prompt: 'What is this for?',
      responseText: 'It is a neutral floor cleaner.',
      criteria: [{ concept: 'says it is a floor cleaner', tier: 1, match: 'semantic' }],
      modelTag: 'claude-sonnet-5',
    });

    expect(mockResolveModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(mockComplete).toHaveBeenCalledOnce();
    const request = mockComplete.mock.calls[0][0];
    expect(request).toMatchObject({
      model: 'claude-sonnet-5',
      schemaName: 'criteria_grading_result',
      schema: GRADER_JSON_SCHEMA,
      maxOutputTokens: 1024,
      temperature: 0,
      requestOptions: { maxRetries: 0, timeoutMs: 1000 },
    });
    expect(request.system).toContain('You are grading a single AI assistant response');
    expect(request.user).toContain('0. says it is a floor cleaner');
    expect(outcome?.passed).toBe(true);
  });

  /**
   * B0-1109 — when the caller supplies a usage context, a successful semantic-grading call
   * records its token usage against that run + item; when it doesn't, nothing is recorded.
   */
  it('records grading usage against the run + item when a context is supplied', async () => {
    mockResolveModel.mockResolvedValue('claude-sonnet-5');
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ verdicts: [{ criterionIndex: 0, met: true, evidence: 'ok' }] }),
      usage: USAGE,
    });
    mockRecordGradingUsage.mockClear();

    await gradeWithCriteria({
      prompt: 'What is this for?',
      responseText: 'It is a neutral floor cleaner.',
      criteria: [{ concept: 'says it is a floor cleaner', tier: 1, match: 'semantic' }],
      modelTag: 'claude-sonnet-5',
      context: { testResultId: 'tr-1', testItemId: 'ti-1' },
    });

    expect(mockRecordGradingUsage).toHaveBeenCalledWith({
      context: { testResultId: 'tr-1', testItemId: 'ti-1' },
      callSite: 'criteria_grader',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: USAGE,
    });
  });

  it('records nothing when no context is supplied', async () => {
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ verdicts: [{ criterionIndex: 0, met: true, evidence: 'ok' }] }),
      usage: USAGE,
    });
    mockRecordGradingUsage.mockClear();

    await gradeWithCriteria({
      prompt: 'What is this for?',
      responseText: 'It is a neutral floor cleaner.',
      criteria: [{ concept: 'says it is a floor cleaner', tier: 1, match: 'semantic' }],
    });

    expect(mockRecordGradingUsage).not.toHaveBeenCalled();
  });
});

/**
 * B0-953 — dilution-unit equivalence. `ANSWER_PH7Q` below is the verbatim assistant response from
 * golden run 61e80e45-80fb-4207-a299-36c60cd62e6a, row 1, which was scored not-met on the concept
 * "pH7Q dilutes at 1:64" while stating the identical value as "2 oz per gallon" / "2 oz/gal".
 * The figures are the run's own transcription of the label; nothing here converts or rounds them.
 */
const ANSWER_PH7Q = [
  'The main differences between Betco pH7Q and pH7Q Dual are their dilution rates, EPA registration numbers, and some aspects of their kill claims and usage.',
  '',
  '**pH7Q:**',
  '- Labeled as a one-step disinfectant, germicidal detergent, and deodorizer.',
  '- EPA Registration Number: 47371-131-4170.',
  '- Active ingredients: Didecyl dimethyl ammonium chloride (2.54%) and n-Alkyl dimethyl benzyl ammonium chloride (1.69%).',
  '- Labeled dilution: 2 oz per gallon of water for general disinfection.',
  '- Contact time: 10 minutes for most organisms; 1 minute for SARS-CoV-2 and Human Coronavirus.',
  '- Approved for use on hard, nonporous surfaces such as floors, walls, metal, stainless steel, glazed porcelain, and plastics.',
  '',
  '**pH7Q Dual:**',
  '- Labeled as a concentrated neutral disinfectant cleaner.',
  '- EPA Registration Number: 10324-141-4170.',
  '- Labeled dilution: 1:256 (0.5 oz per gallon of water).',
  '- Contact time: 10 minutes for most organisms; 2 minutes for SARS-CoV-2.',
  '- Coverage: 500 sq ft/gal.',
  '',
  '**Key differences:**',
  '- **Dilution:** pH7Q uses 2 oz/gal; pH7Q Dual uses 0.5 oz/gal (more concentrated).',
  '- **Contact time for SARS-CoV-2:** pH7Q is 1 minute; pH7Q Dual is 2 minutes.',
  '- **EPA Registration:** Each has a different EPA registration number, meaning claims and directions are not interchangeable.',
  '',
  'Always confirm the product in hand matches the intended use and review the label for the specific organism and surface.',
].join('\n');

describe('findDilutionEquivalence — B0-953 exact unit identity only', () => {
  it('treats 1:64 and the response’s own oz/gal wording as the same concept', () => {
    const match = findDilutionEquivalence('pH7Q dilutes at 1:64', ANSWER_PH7Q);
    expect(match).not.toBeNull();
    expect(match!.matched).toBe('2 oz/gal');
    expect(match!.evidence).toContain('pH7Q uses 2 oz/gal');
  });

  it('does NOT accept 2.5 oz/gal for 1:64 — close is wrong on a regulated value', () => {
    expect(
      findDilutionEquivalence('pH7Q dilutes at 1:64', 'pH7Q uses 2.5 oz/gal for disinfection.'),
    ).toBeNull();
  });

  it.each([
    ['1:64 ↔ 2 oz/gal', 'pH7Q dilutes at 1:64', 'pH7Q uses 2 oz/gal.'],
    ['1:64 ↔ 2 fl. oz. per gallon', 'pH7Q dilutes at 1:64', 'pH7Q: 2 fl. oz. per gallon.'],
    ['1:256 ↔ 0.5 oz/gal', 'pH7Q Dual dilutes at 1:256', 'pH7Q Dual uses 0.5 oz/gal.'],
    ['1:128 ↔ 1 ounce per gallon', 'Sanibet dilutes at 1:128', 'Sanibet: 1 ounce per gallon.'],
    ['1:64 ↔ 15.625 mL/L', 'dilutes at 1:64', 'Mix at 15.625 mL/L.'],
    // The post-B0-953 fixture wording (both forms spelled) still resolves to the one value.
    ['both forms spelled in the concept', 'pH7Q dilutes at 1:64 (2 oz/gal)', ANSWER_PH7Q],
    ['1:100 ↔ 10 mL per litre', 'dilutes at 1:100', 'Mix at 10 mL per litre.'],
  ])('%s is met', (_label, concept, response) => {
    expect(findDilutionEquivalence(concept, response)).not.toBeNull();
  });

  it.each([
    ['a near miss the other way', 'pH7Q dilutes at 1:64', 'pH7Q uses 1.9 oz/gal.'],
    ['1:64 is not 1:65', 'pH7Q dilutes at 1:64', 'pH7Q dilutes at 1:65.'],
    ['mL/L is not oz/gal', 'dilutes at 1:64', 'Mix at 2 mL/L.'],
    ['a percentage is never converted', 'dilutes at 1:64', 'Use a 1.5% solution.'],
    ['no dilution in the concept at all', 'both are neutral pH cleaners', 'pH7Q uses 2 oz/gal.'],
    ['no dilution in the response', 'pH7Q dilutes at 1:64', 'pH7Q is a neutral disinfectant.'],
  ])('%s is not met', (_label, concept, response) => {
    expect(findDilutionEquivalence(concept, response)).toBeNull();
  });

  it('will not borrow a sibling product’s value', () => {
    expect(
      findDilutionEquivalence(
        'pH7Q dilutes at 1:64',
        'pH7Q is a neutral disinfectant. Fastdraw 6 uses 2 oz/gal.',
      ),
    ).toBeNull();
  });

  it('will not borrow from a sibling whose NAME CONTAINS the criterion’s subject', () => {
    // "pH7Q Dual" satisfies a naive subject check for a "pH7Q" criterion, because "pH7Q" is a
    // prefix of it. Dual's labeled rate is 1:256, so crediting this would certify 1:64 for pH7Q
    // off a clause that never mentions pH7Q on its own — and would do so even when the sibling's
    // own rate is stated wrongly. The extra identifier ("dual") is what disqualifies the clause.
    expect(findDilutionEquivalence('pH7Q dilutes at 1:64', 'pH7Q Dual uses 2 oz/gal.')).toBeNull();
    // Same clause set, but pH7Q now speaks for itself — that one is legitimate evidence.
    expect(
      findDilutionEquivalence(
        'pH7Q dilutes at 1:64',
        'pH7Q uses 2 oz/gal; pH7Q Dual uses 0.5 oz/gal.',
      ),
    ).not.toBeNull();
  });

  it('stays out of it when the response states a different value for the same product', () => {
    expect(
      findDilutionEquivalence(
        'pH7Q dilutes at 1:64',
        'pH7Q dilutes at 1:32. Elsewhere the guide lists 2 oz/gal.',
      ),
    ).toBeNull();
  });

  it('declines an unsubjected concept when the response states several dilutions', () => {
    expect(findDilutionEquivalence('dilutes at 1:64', 'Use 2 oz/gal, or 4 oz/gal for heavy soil.')).toBeNull();
  });

  it('reports nothing when the concept’s own two forms disagree (a fixture bug to report)', () => {
    expect(findDilutionEquivalence('pH7Q dilutes at 1:64 (3 oz/gal)', ANSWER_PH7Q)).toBeNull();
  });
});

describe('gradeWithCriteria — B0-953 dilution equivalence is settled in code', () => {
  beforeEach(() => {
    mockComplete.mockReset();
    mockResolveModel.mockReset();
    mockResolveModel.mockResolvedValue('gpt-test');
  });

  it('flips the golden-run row-1 concept to met without asking the model', async () => {
    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        verdicts: [{ criterionIndex: 1, met: true, evidence: 'neutral pH' }],
      }),
      usage: USAGE,
    });

    const outcome = await gradeWithCriteria({
      prompt: "What's the difference between pH7Q and pH7Q Dual?",
      responseText: ANSWER_PH7Q,
      criteria: [
        { concept: 'pH7Q dilutes at 1:64', tier: 1, match: 'semantic' },
        { concept: 'both are neutral pH disinfectant cleaners', tier: 2, match: 'semantic' },
      ],
    });

    expect(outcome!.verdicts[0]).toMatchObject({
      met: true,
      source: 'dilution_equivalence',
      match: 'semantic',
    });
    expect(outcome!.verdicts[0].evidence).toContain('2 oz/gal');
    expect(outcome!.passed).toBe(true);
    // The criterion never reached the model: only the second one was listed for it.
    const user = mockComplete.mock.calls[0][0].user as string;
    expect(user).not.toContain('0. pH7Q dilutes at 1:64');
    expect(user).toContain('1. both are neutral pH disinfectant cleaners');
  });

  it('falls through to the semantic grader when the values are not exactly equal', async () => {
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ verdicts: [{ criterionIndex: 0, met: false, evidence: '' }] }),
      usage: USAGE,
    });

    const outcome = await gradeWithCriteria({
      prompt: 'How do I dilute pH7Q?',
      responseText: 'pH7Q uses 2.5 oz/gal.',
      criteria: [{ concept: 'pH7Q dilutes at 1:64', tier: 1, match: 'semantic' }],
    });

    expect(mockComplete).toHaveBeenCalledOnce();
    expect(mockComplete.mock.calls[0][0].user).toContain('0. pH7Q dilutes at 1:64');
    expect(outcome!.verdicts[0]).toMatchObject({ met: false, source: 'semantic' });
    expect(outcome!.passed).toBe(false);
  });

  it('leaves an exact-tagged criterion deterministic — no unit conversion is ever applied to it', async () => {
    const outcome = await gradeWithCriteria({
      prompt: 'How do I dilute pH7Q?',
      responseText: 'pH7Q uses 2 oz/gal.',
      criteria: [{ concept: '1:64', tier: 1, match: 'exact' }],
    });

    expect(mockComplete).not.toHaveBeenCalled();
    expect(outcome!.verdicts[0]).toMatchObject({ met: false, source: 'exact' });
    expect(outcome!.passed).toBe(false);
  });
});
