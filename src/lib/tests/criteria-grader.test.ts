import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-832 — mocks for `gradeWithCriteria`'s model dependencies, so the collision-guardrail test
 * below can drive the real `gradeSemanticCriteria` → `aggregateCriteriaVerdicts` path with a
 * scripted model response, without a live API call. B0-908 — the seam is now the provider-neutral
 * `completeStructuredWithUsage`, not the OpenAI client.
 */
const { mockComplete, mockResolveModel } = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockResolveModel: vi.fn(async () => 'gpt-test'),
}));
const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 };
vi.mock('~/lib/llm/structured-completion', () => ({
  completeStructuredWithUsage: mockComplete,
}));
vi.mock('~/lib/openai/client', () => ({
  resolveResponsesModel: mockResolveModel,
}));
vi.mock('~/lib/openai/transport-retry', () => ({
  resolveOpenAiRequestTimeoutMs: () => 1000,
  retryTransportFaults: (fn: () => unknown) => fn(),
}));
vi.mock('~/lib/workflows/product-support/max-output-tokens', () => ({
  resolveMaxOutputTokens: () => 1024,
}));

import { gradeExactCriterion, gradeWithCriteria } from './criteria-grader';
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
});
