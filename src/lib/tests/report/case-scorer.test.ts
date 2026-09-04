import { describe, expect, it } from 'vitest';

import {
  buildGraderPayload,
  CASE_SCORING_SYSTEM_PROMPT,
  GRADER_JSON_SCHEMA,
  GRADER_MAX_OUTPUT_TOKENS,
  GRADING_PROMPT_HASH,
  GRADING_PROMPT_VERSION,
  graderOutputSchema,
  reconcileConcepts,
  requiredConcepts,
  scoreCase,
  toCaseScore,
  type CaseScoringInput,
  type GraderOutput,
  type StructuredCompletion,
} from './case-scorer';
import { NO_EXPECTED_CONCEPTS_UTE_REASON } from './metrics';

/**
 * B0-808 / B0-810 — the grader contract. Everything with a model behind it is exercised through the
 * injectable `complete` seam with a fake, so these tests cost nothing and pin the parts that matter:
 * what the grader is asked, how its answer is reconciled onto our own phrase lists, and — since
 * B0-835 — that its judged Completeness comes through untouched for `metrics.ts` to cap.
 */

const REGULATED = {
  dilution: 'Dilute 1:64 (2 oz/gal)',
  contactTime: '10 minutes contact time at 600 ppm active quat',
  epa: 'EPA Reg. No. 6836-140-4170',
  metric: 'Metric equivalent 15.6 mL/L',
} as const;

const INPUT: CaseScoringInput = {
  question: 'What is the dilution and dwell time for pH7Q Dual?',
  category: 'Dilution',
  priorityRaw: 1,
  idealResponse: `${REGULATED.dilution}; ${REGULATED.contactTime}.`,
  expectedSources: `Product label — ${REGULATED.epa}`,
  expectedShouldAnswer: true,
  mandatoryConcepts: [REGULATED.dilution, REGULATED.contactTime],
  expectedConcepts: [REGULATED.dilution, REGULATED.contactTime, REGULATED.metric],
  actualResponseText: 'Dilute at 2 oz per gallon (1:64) and keep the surface wet for ten minutes.',
  modelTag: 'gpt-5.6',
};

function output(partial: Partial<GraderOutput> = {}): GraderOutput {
  return {
    unable_to_evaluate: false,
    ute_reason: null,
    accuracy: 88,
    completeness: 66,
    relevance: 92,
    clarity: 85,
    concepts: {
      minimal_satisfied: [REGULATED.dilution, REGULATED.contactTime],
      minimal_missing: [],
      expected_satisfied: [REGULATED.dilution, REGULATED.contactTime],
      expected_missing: [REGULATED.metric],
      material_issue: false,
      material_issue_note: null,
    },
    similarity: 0.7,
    similarity_note: 'Both regulated facts present; the metric equivalent is not.',
    eval_confidence: 86,
    confidence_note: 'Concrete golden; values verifiable against the ideal response.',
    explanation: 'Quoted the ratio and dwell correctly.',
    missed: 'The metric equivalent.',
    incorrect: '',
    improvement: 'Add the mL/L equivalent when the label prints it.',
    ...partial,
  };
}

describe('the grading prompt (B0-810 / B0-835)', () => {
  it('has a stable content hash and the version that names this revision', () => {
    expect(GRADING_PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(GRADING_PROMPT_VERSION).toBe('2026-09-04.1');
  });

  it('quotes the methodology sections it grades by, and asks for no derived field', () => {
    for (const section of ['§1', '§2b', '§4', '§5', '§6', '§7c']) {
      expect(CASE_SCORING_SYSTEM_PROMPT).toContain(`methodology ${section}`);
    }
    // Verbatim anchors from the reference methodology.
    expect(CASE_SCORING_SYSTEM_PROMPT).toContain(
      'A concept is present when the actual response clearly communicates the same substantive idea',
    );
    expect(CASE_SCORING_SYSTEM_PROMPT).toContain('transcribe them exactly as written; never round, convert, or infer');
    expect(CASE_SCORING_SYSTEM_PROMPT).toContain('1.00 essentially everything · 0.75 most of the substance');
    expect(CASE_SCORING_SYSTEM_PROMPT).toContain(
      'never author a derived field, an overall score, a grade or a Pass/Fail',
    );
    // Nothing from the retired rule set (the prompt does tell the grader it must not floor anything).
    expect(CASE_SCORING_SYSTEM_PROMPT).not.toMatch(/capped at 59|raised to (the )?70|automatic Pass|Pre-Gate/i);
  });

  it('asks for a holistically judged Completeness and forbids pre-applying the caps (B0-835)', () => {
    expect(CASE_SCORING_SYSTEM_PROMPT).toContain(
      'You judge four sub-scores (Accuracy, Completeness, Relevance, Clarity — each 0-100)',
    );
    expect(CASE_SCORING_SYSTEM_PROMPT).toContain('Completeness — 30%. Did it include the important expected information?');
    expect(CASE_SCORING_SYSTEM_PROMPT).toContain('Judge Completeness holistically first');
    expect(CASE_SCORING_SYSTEM_PROMPT).toContain('it only ever lowers a value');
    expect(CASE_SCORING_SYSTEM_PROMPT).toContain(
      'A response that satisfied half its must-haves is not 73% complete',
    );
    expect(CASE_SCORING_SYSTEM_PROMPT).toMatch(
      /Do not pre-apply that cap, the mandatory floor, the mandatory ceiling or the gate yourself/,
    );
    // The B0-813 instruction is gone: the grader judges Completeness again.
    expect(CASE_SCORING_SYSTEM_PROMPT).not.toContain('You do NOT judge Completeness');
    expect(CASE_SCORING_SYSTEM_PROMPT).not.toMatch(/do not author a number for it/i);
  });
});

describe('the grader wire contract (B0-835)', () => {
  it('requires a completeness field in the strict json_schema, with no bounds keywords', () => {
    expect(GRADER_JSON_SCHEMA.required).toContain('completeness');
    const completeness = GRADER_JSON_SCHEMA.properties.completeness;
    expect(completeness.type).toEqual(['number', 'null']);
    expect(completeness.description).toContain('0-100');
    expect(Object.keys(completeness)).toEqual(['type', 'description']);
  });

  it('rejects a grader payload that omits completeness', () => {
    const withoutCompleteness: Record<string, unknown> = { ...output() };
    delete withoutCompleteness.completeness;
    expect(graderOutputSchema.safeParse(withoutCompleteness).success).toBe(false);
    expect(graderOutputSchema.safeParse({ ...output(), completeness: null }).success).toBe(true);
  });
});

describe('buildGraderPayload / requiredConcepts (B0-809)', () => {
  it('mirrors the reference cases.json field names and sends the split phrase lists', () => {
    const payload = JSON.parse(buildGraderPayload(INPUT));
    expect(Object.keys(payload)).toEqual([
      'question',
      'priority_raw',
      'category',
      'expected',
      'expected_sources',
      'should_cite',
      'minimal_concepts',
      'expected_concepts',
      'actual',
    ]);
    expect(payload.minimal_concepts).toEqual([REGULATED.dilution, REGULATED.contactTime]);
    expect(payload.expected_concepts).toEqual([
      REGULATED.dilution,
      REGULATED.contactTime,
      REGULATED.metric,
    ]);
    expect(payload.actual).toBe(INPUT.actualResponseText);
  });

  it('adds a must-have the expected column omits to the expected set, so its miss shows in coverage', () => {
    const required = requiredConcepts({
      mandatoryConcepts: [REGULATED.epa],
      expectedConcepts: [REGULATED.dilution],
    });
    expect(required.mandatory).toEqual([REGULATED.epa]);
    expect(required.expected).toEqual([REGULATED.dilution, REGULATED.epa]);
  });

  it('recognises the same phrase spelled differently as one phrase when unioning', () => {
    const required = requiredConcepts({
      mandatoryConcepts: ['Dilute 1:64 (2 oz/gal)'],
      expectedConcepts: ['dilute 1:64 — 2 oz/gal'],
    });
    // Identity by normConcept; the expected column's spelling is kept.
    expect(required.expected).toEqual(['dilute 1:64 — 2 oz/gal']);
  });
});

describe('reconcileConcepts (B0-809)', () => {
  it('re-emits our phrases verbatim and partitions them from the grader verdicts', () => {
    const concepts = reconcileConcepts(requiredConcepts(INPUT), output().concepts);
    expect(concepts.mandatory).toEqual({
      required: [REGULATED.dilution, REGULATED.contactTime],
      satisfied: [REGULATED.dilution, REGULATED.contactTime],
      missing: [],
    });
    expect(concepts.expected).toEqual({
      required: [REGULATED.dilution, REGULATED.contactTime, REGULATED.metric],
      satisfied: [REGULATED.dilution, REGULATED.contactTime],
      missing: [REGULATED.metric],
    });
    expect(concepts.materialIssue).toBe(false);
    expect(concepts.materialIssueNote).toBeNull();
  });

  it('matches a grader re-spelling back to our phrase and never lets the re-spelling through', () => {
    const concepts = reconcileConcepts(
      requiredConcepts(INPUT),
      output({
        concepts: {
          ...output().concepts,
          minimal_satisfied: ['dilute 1:64, 2 oz/gal', '10 minute contact time @ 600ppm active quat'],
          expected_satisfied: ['dilute 1:64, 2 oz/gal', '10 minute contact time @ 600ppm active quat'],
        },
      }).concepts,
    );
    // "10 minute" ≠ "10 minutes" and "600ppm" ≠ "600 ppm" under normConcept, so only the dilution matches.
    expect(concepts.mandatory.satisfied).toEqual([REGULATED.dilution]);
    expect(concepts.mandatory.missing).toEqual([REGULATED.contactTime]);
    // Our spelling, not the grader's, is what comes out.
    expect(concepts.mandatory.satisfied[0]).toBe(REGULATED.dilution);
  });

  it('treats an unjudged phrase as missing, and a phrase listed both ways as missing', () => {
    const concepts = reconcileConcepts(
      requiredConcepts(INPUT),
      output({
        concepts: {
          minimal_satisfied: [REGULATED.dilution],
          minimal_missing: [REGULATED.dilution],
          expected_satisfied: [],
          expected_missing: [],
          material_issue: false,
          material_issue_note: null,
        },
      }).concepts,
    );
    expect(concepts.mandatory.missing).toEqual([REGULATED.dilution, REGULATED.contactTime]);
    expect(concepts.expected.satisfied).toEqual([]);
    expect(concepts.expected.missing).toHaveLength(3);
  });

  it('drops the material-issue note when the flag is false', () => {
    const concepts = reconcileConcepts(
      requiredConcepts(INPUT),
      output({
        concepts: { ...output().concepts, material_issue: false, material_issue_note: 'stray note' },
      }).concepts,
    );
    expect(concepts.materialIssueNote).toBeNull();
  });
});

describe('toCaseScore (B0-808)', () => {
  it('carries the judged Completeness through uncapped, and clamps the judged fields', () => {
    const score = toCaseScore(output({ accuracy: 104, similarity: 1.4, eval_confidence: -3 }), INPUT);
    // 2 of 3 expected concepts are satisfied, so coverage is 67 — but capping is `metrics.ts`'s job.
    expect(score.completeness).toBe(66);
    expect(score.accuracy).toBe(100);
    expect(score.similarity).toBe(1);
    expect(score.evalConfidence).toBe(0);
    expect(score.concepts!.expected.missing).toEqual([REGULATED.metric]);
    expect(score.similarityNote).toBe('Both regulated facts present; the metric equivalent is not.');
  });

  it('clamps an out-of-range Completeness to 0-100 (B0-835)', () => {
    expect(toCaseScore(output({ completeness: 105 }), INPUT).completeness).toBe(100);
    expect(toCaseScore(output({ completeness: -3 }), INPUT).completeness).toBe(0);
    expect(toCaseScore(output({ completeness: null }), INPUT).completeness).toBeNull();
  });

  it('maps an Unable-to-Evaluate verdict to the empty score with its reason', () => {
    const score = toCaseScore(
      output({ unable_to_evaluate: true, ute_reason: 'The response is empty.' }),
      INPUT,
    );
    expect(score.unableToEvaluate).toBe(true);
    expect(score.uteReason).toBe('The response is empty.');
    expect(score.concepts).toBeNull();
    expect(score.accuracy).toBeNull();
    // A UTE case has no judged Completeness either, whatever the grader put in the field.
    expect(score.completeness).toBeNull();
  });
});

describe('scoreCase (B0-808)', () => {
  it('sends the prompt and the payload to the model and returns the reconciled score', async () => {
    const calls: Array<{ model: string; system: string; user: string }> = [];
    const score = await scoreCase(INPUT, {
      resolveModel: async (tag) => `resolved:${tag}`,
      complete: async (params) => {
        calls.push(params);
        return JSON.stringify(output());
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe('resolved:gpt-5.6');
    expect(calls[0]!.system).toBe(CASE_SCORING_SYSTEM_PROMPT);
    expect(JSON.parse(calls[0]!.user).minimal_concepts).toEqual(INPUT.mandatoryConcepts);
    expect(score.unableToEvaluate).toBe(false);
    expect(score.accuracy).toBe(88);
    expect(score.completeness).toBe(66);
    expect(score.concepts!.mandatory.missing).toEqual([]);
    expect(score.evalConfidence).toBe(86);
  });

  it('hands the seam the strict grader schema, the output cap, temperature 0 and the configured effort (B0-819)', async () => {
    const calls: Array<Parameters<StructuredCompletion>[0]> = [];
    await scoreCase(
      { ...INPUT, modelTag: 'claude-opus-5', effort: 'xhigh' },
      {
        resolveModel: async (tag) => tag ?? '',
        complete: async (params) => {
          calls.push(params);
          return JSON.stringify(output());
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe('claude-opus-5');
    expect(calls[0]!.schema).toBe(GRADER_JSON_SCHEMA);
    expect(calls[0]!.schemaName).toBe('case_score');
    expect(calls[0]!.maxOutputTokens).toBe(GRADER_MAX_OUTPUT_TOKENS);
    expect(calls[0]!.temperature).toBe(0);
    expect(calls[0]!.effort).toBe('xhigh');
  });

  it('sends no effort when the input carries none, so OpenAI-graded reports are unchanged', async () => {
    const calls: Array<Parameters<StructuredCompletion>[0]> = [];
    await scoreCase(INPUT, {
      resolveModel: async (tag) => tag ?? '',
      complete: async (params) => {
        calls.push(params);
        return JSON.stringify(output());
      },
    });
    expect(calls[0]!.effort).toBeUndefined();
  });

  it('returns Unable to Evaluate without a model call when the item has no concept columns', async () => {
    let called = false;
    const score = await scoreCase(
      { ...INPUT, mandatoryConcepts: [], expectedConcepts: [] },
      {
        complete: async () => {
          called = true;
          return '{}';
        },
      },
    );
    expect(called).toBe(false);
    expect(score.unableToEvaluate).toBe(true);
    expect(score.uteReason).toBe(NO_EXPECTED_CONCEPTS_UTE_REASON);
  });

  it('turns a malformed model answer into an Unable-to-Evaluate score naming the failure', async () => {
    const score = await scoreCase(INPUT, {
      resolveModel: async () => 'm',
      complete: async () => '{"not":"a grader output"}',
    });
    expect(score.unableToEvaluate).toBe(true);
    expect(score.uteReason).toContain('Grading call failed');
  });

  it('validates the wire shape with the same schema the strict json_schema mirrors', () => {
    expect(graderOutputSchema.safeParse(output()).success).toBe(true);
    expect(graderOutputSchema.safeParse({ ...output(), concepts: undefined }).success).toBe(false);
  });
});
