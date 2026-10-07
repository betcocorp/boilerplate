import { createHash } from 'node:crypto';

import { z } from 'zod';

import { modelProviderFor, type ModelEffort } from '~/lib/constants/models';
import {
  completeStructuredWithUsage,
  type CompletionResult,
  type StructuredCompletionRequest,
} from '~/lib/llm/structured-completion';
import { recordGradingUsage, type GradingUsageContext } from '~/lib/tests/grading-usage';

import { normConcept, type CaseConcepts, type ConceptKindCoverage } from './case-concepts';
import { formatExpectedSourceRef, type ExpectedSourceRef } from './expected-sources';
import { DEFAULT_GRADING_MODEL_TAG, resolveGradingModel } from './grading-model';
import { NO_EXPECTED_CONCEPTS_UTE_REASON } from './metrics';
import { GRADING_CALL_FAILED_PREFIX, type CaseScore } from './schemas';

/**
 * B0-808 / B0-810 — the per-case grader.
 *
 * The grader judges the four sub-scores, the per-concept verdicts and two reported-only metrics, and
 * computes nothing — no overall score, no letter grade, no Pass/Fail, and none of the deterministic
 * rules (coverage cap, mandatory floor, mandatory ceiling, gate) that `metrics.ts` applies on top:
 *
 * 1. **Accuracy, Completeness, Relevance, Clarity** (0–100), judged holistically against the Ideal
 *    Response and both concept lists together (B0-835, reference SKILL.md §3 / methodology §2b
 *    Rule 4). Completeness is a *judgment* here and is never computed here: `metrics.ts` caps it
 *    downstream at expected-concept coverage — `min(judged, round(100 × satisfied ÷ required))` —
 *    a ceiling that only ever lowers it.
 * 2. **Every concept phrase** in the item's `minimum_concepts` (mandatory) and `expected_concepts`
 *    (expected) columns: satisfied or missing, semantically, phrase by phrase. Plus whether a material
 *    factual issue is present.
 * 3. **Similarity** to the Ideal Response (0–1) and **evaluator confidence** (0–100) — reported
 *    beside the grade, never in it (methodology §7c).
 *
 * The system prompt quotes the reference methodology's grading sections verbatim (marked with their
 * section numbers) so a Bex report and the colleague's desktop report are graded on the same words;
 * its SHA-256 (`GRADING_PROMPT_HASH`) is persisted on `report_state` so a report always says which
 * prompt graded it. Regulated-data rule: concept phrases are copied verbatim in and out; the grader's
 * satisfied/missing lists are matched back to *our* phrase list by `normConcept` identity and the
 * phrases re-emitted from our list, so no model re-spelling of a dilution ratio ever reaches a report.
 */

/** Bump when the prompt's meaning changes; the hash below catches every byte change regardless. */
export const GRADING_PROMPT_VERSION = '2026-09-04.1';

export const CASE_SCORING_SYSTEM_PROMPT = `You are grading one AI agent response against a golden-dataset expected answer, following Betco's agent-evaluation methodology. The Golden Dataset is always the source of truth; judge substantive correctness, not wording.

# What you judge, and what you do not

You judge four sub-scores (Accuracy, Completeness, Relevance, Clarity — each 0-100), whether the response communicates each listed concept phrase, whether a material factual issue is present, and two reported-only metrics (similarity, evaluator confidence).

Score all four sub-scores holistically against the Ideal Response, the expected concepts and the mandatory concepts together (methodology §2b Rule 4) — judge first, and let code apply the caps afterwards. A response that satisfied half its must-haves is not 73% complete, and with both concept lists in front of you it should not be scored as though it were. Judge Completeness holistically first; the coverage cap is a ceiling on that judgment, not a substitute for it, and it only ever lowers a value (methodology §2b Rule 3). Do not pre-apply that cap, the mandatory floor, the mandatory ceiling or the gate yourself, and never author a derived field, an overall score, a grade or a Pass/Fail — code derives every one of those from your judgments alone.

# 1. Scoring framework (methodology §1)

Score each sub-score 0-100 against the Golden Dataset:

- Accuracy — 40% of the overall. Is the answer factually correct against the Golden Dataset?
- Completeness — 30%. Did it include the important expected information?
- Relevance — 20%. Did it directly address the question without unrelated filler?
- Clarity — 10%. Was it clear, understandable, and well structured?

Judge all four against the Ideal Response, the expected concepts and the mandatory concepts together (§2b Rule 4), in this order: is the case evaluable at all; read all three sources together; decide which mandatory concepts are satisfied; decide which expected concepts are satisfied; identify material factual errors or contradictions; then assign the four sub-scores with all of the above in view. Code takes it from there — it caps Completeness at expected-concept coverage, weights the four sub-scores, then applies the floor and the ceiling.

Anchor every sub-score in evidence from the expected and actual text. Do not assign round-number scores out of habit — if Accuracy is 70 rather than 80, the explanation should make clear why. Unsupported, fabricated, or materially incorrect information must significantly reduce Accuracy (and usually Relevance), because a confident wrong answer is worse than an incomplete one, especially for regulated content.

# 2. Judge concepts semantically, never by keyword (methodology §2b)

A concept is present when the actual response clearly communicates the same substantive idea — different wording, synonyms, abbreviations, or sentence structure are all fine. A concept is not present merely because a related word appears without the required meaning ("dilution" appearing in a sentence that never states or sources a dilution does not satisfy a "state the label dilution" concept). This judgment is yours; the scripts never look at the response text.

Treat every phrase listed under minimal_concepts as mandatory (a must-have) and every phrase under expected_concepts as expected (the full success set). Judge each phrase independently as satisfied or missing. Partial coverage, a vague implication, or coverage of a merely related concept does not count unless the required meaning is clearly communicated. List every phrase you were given exactly once, verbatim as given, under either satisfied or missing for its kind — never paraphrase, split, merge, or drop a phrase.

Set material_issue to true ONLY for a material factual error, contradiction, fabrication, unsafe instruction, or wrong regulated value (dilution, oz/gal, mL/L, ppm, %, contact time, CAS, EPA reg no., log reduction), and name the specific value in material_issue_note. A material factual error must also be reflected in Accuracy.

# 3. Unable to Evaluate (methodology §4)

If a case cannot reasonably be judged — no actual response, an empty or corrupted response, or an expected answer too ambiguous to score — set unable_to_evaluate to true and give a one-line ute_reason. Do not invent information to force a score. Flag gaps in the source data plainly. When unable_to_evaluate is true, set every sub-score, similarity and eval_confidence to null, every concept list to empty, and every narrative field to an empty string.

# 4. Regulated-data caveat (methodology §5)

Many golden answers are structural templates with placeholders (e.g. "[insert label-confirmed dilution rate]"). They define expected behavior and sourcing, not literal fact keys. When the agent supplies specific regulated values — dilution ratios, oz/gal, mL/L, ppm, contact times, CAS numbers, EPA registration numbers, log-reduction values — and you cannot verify them against an authoritative source in the material given to you:

- transcribe them exactly as written; never round, convert, or infer,
- do not reward them as correct nor mark them wrong purely for being unverifiable,
- grade on whether the agent produced the expected behavior and cited the right source,
- and call the specific values out under "incorrect" as items to confirm.

An answer that fabricates a regulated value not present in the source (or that contradicts the golden) is a materially incorrect answer — cut Accuracy hard.

# 5. Fairness rules (methodology §6)

Be rigorous but fair. Do not require exact phrase matching. For each response ask: (1) correct information? (2) important expected information included? (3) directly addresses the question? (4) free of incorrect/fabricated content? (5) communicated clearly? Reward a substantively correct answer even if its wording, ordering, or extra helpful detail differs from the golden. Penalize confident wrongness and missing must-have content.

# 6. Judged similarity and evaluator confidence (methodology §7c) — reported, never graded

Both are judgments made while reading the case and are never folded into any sub-score, the weighted score, the letter grade, or Pass/Fail. Do not copy confidence or similarity numbers from anywhere else.

- similarity (0-1, two decimals) — how much of what the Ideal Response says the actual response also says, judged semantically and independent of wording. It is deliberately not the grade. Anchors: 1.00 essentially everything · 0.75 most of the substance · 0.50 about half · 0.25 same topic, little shared substance · 0.00 unrelated or opposite. Judge it separately from the score; do not anchor one to the other. Add a one-line similarity_note.
- eval_confidence (0-100) — how sure you are of the grade you just assigned. 90-100 unambiguous · 70-89 solid, minor judgment calls · 50-69 real ambiguity · below 50 an SME should review. Lower it when the golden is a behavioural template with "[insert …]" placeholders, when the response supplies regulated values that cannot be verified from the material given, or when the response is too thin to judge. Add a one-line confidence_note.

# 7. Narrative

explanation: why these scores, citing specific evidence from expected vs. actual. missed: important expected information the response omitted. incorrect: incorrect, misleading, unsupported, or unverified information — name specific regulated values that need confirming. improvement: the single most useful fix for this case.

Ground every field in specific evidence from the expected and actual text given to you.`;

export const GRADING_PROMPT_HASH = createHash('sha256')
  .update(CASE_SCORING_SYSTEM_PROMPT)
  .digest('hex');

/**
 * Strict json_schema for the grading call, mirrored by hand from `graderOutputSchema` (strict mode
 * has no `minimum`/`maximum`/`minItems`; bounds are enforced by the prompt and by Zod after parse).
 * Field names mirror the reference skill's `eval.json` case shape so the two graders are asked the
 * same questions in the same words.
 */
export const GRADER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    unable_to_evaluate: {
      type: 'boolean',
      description:
        'true only if this case cannot reasonably be judged: no actual response, an empty/corrupted response, or an expected answer too ambiguous to score.',
    },
    ute_reason: {
      type: ['string', 'null'],
      description: 'One-line reason, required when unable_to_evaluate is true; otherwise null.',
    },
    accuracy: { type: ['number', 'null'], description: '0-100, or null when unable_to_evaluate.' },
    completeness: { type: ['number', 'null'], description: '0-100, or null when unable_to_evaluate.' },
    relevance: { type: ['number', 'null'], description: '0-100, or null when unable_to_evaluate.' },
    clarity: { type: ['number', 'null'], description: '0-100, or null when unable_to_evaluate.' },
    concepts: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minimal_satisfied: {
          type: 'array',
          items: { type: 'string' },
          description: 'The minimal_concepts phrases the response substantively communicates, verbatim.',
        },
        minimal_missing: {
          type: 'array',
          items: { type: 'string' },
          description: 'The minimal_concepts phrases it does not, verbatim.',
        },
        expected_satisfied: {
          type: 'array',
          items: { type: 'string' },
          description: 'The expected_concepts phrases the response substantively communicates, verbatim.',
        },
        expected_missing: {
          type: 'array',
          items: { type: 'string' },
          description: 'The expected_concepts phrases it does not, verbatim.',
        },
        material_issue: {
          type: 'boolean',
          description:
            'true ONLY for a material factual error, contradiction, fabrication, unsafe instruction, or wrong regulated value.',
        },
        material_issue_note: {
          type: ['string', 'null'],
          description: 'Names the specific value or error when material_issue is true; otherwise null.',
        },
      },
      required: [
        'minimal_satisfied',
        'minimal_missing',
        'expected_satisfied',
        'expected_missing',
        'material_issue',
        'material_issue_note',
      ],
    },
    similarity: {
      type: ['number', 'null'],
      description: '0-1, two decimals: how much of what the Ideal Response says the response also says. Null when unable_to_evaluate.',
    },
    similarity_note: { type: 'string', description: 'One short sentence justifying similarity.' },
    eval_confidence: {
      type: ['number', 'null'],
      description: '0-100: how sure you are of the grade you assigned. Null when unable_to_evaluate.',
    },
    confidence_note: {
      type: 'string',
      description: 'One short sentence on what makes you more or less sure.',
    },
    explanation: {
      type: 'string',
      description: 'Why these scores, citing specific evidence from expected vs. actual. Empty string when unable_to_evaluate.',
    },
    missed: {
      type: 'string',
      description: 'Important expected information the response omitted. Empty string if none.',
    },
    incorrect: {
      type: 'string',
      description:
        'Incorrect, misleading, unsupported, or unverified information — name specific regulated values (dilution, ppm, EPA/CAS, log-reduction) that need confirming. Empty string if none.',
    },
    improvement: {
      type: 'string',
      description: 'The single most useful fix for this case. Empty string when unable_to_evaluate.',
    },
  },
  required: [
    'unable_to_evaluate',
    'ute_reason',
    'accuracy',
    'completeness',
    'relevance',
    'clarity',
    'concepts',
    'similarity',
    'similarity_note',
    'eval_confidence',
    'confidence_note',
    'explanation',
    'missed',
    'incorrect',
    'improvement',
  ],
} as const;

/** What the grader returns, before reconciliation against our own phrase lists. */
export const graderOutputSchema = z.object({
  unable_to_evaluate: z.boolean(),
  ute_reason: z.string().nullable(),
  accuracy: z.number().nullable(),
  completeness: z.number().nullable(),
  relevance: z.number().nullable(),
  clarity: z.number().nullable(),
  concepts: z.object({
    minimal_satisfied: z.array(z.string()),
    minimal_missing: z.array(z.string()),
    expected_satisfied: z.array(z.string()),
    expected_missing: z.array(z.string()),
    material_issue: z.boolean(),
    material_issue_note: z.string().nullable(),
  }),
  similarity: z.number().nullable(),
  similarity_note: z.string(),
  eval_confidence: z.number().nullable(),
  confidence_note: z.string(),
  explanation: z.string(),
  missed: z.string(),
  incorrect: z.string(),
  improvement: z.string(),
});

export type GraderOutput = z.infer<typeof graderOutputSchema>;

export type CaseScoringInput = {
  question: string;
  category: string | null;
  priorityRaw: number | null;
  idealResponse: string | null;
  /**
   * B0-933 — `test_items.expected_sources` (a `uuid[]` of `rag.document.id`) resolved to document
   * titles by `./expected-sources`. The grader is shown the titles, never the uuids: a uuid is not
   * something a source expectation can be judged against.
   */
  expectedSources: readonly ExpectedSourceRef[];
  /** `test_items.should_cite` — whether the answer is expected to cite sources. Null = no expectation. */
  shouldCite: boolean | null;
  /** `test_items.minimum_concepts` — a `text[]`, one phrase per element, read straight through. */
  mandatoryConcepts: readonly string[];
  /** `test_items.expected_concepts` — a `text[]`, one phrase per element, read straight through. */
  expectedConcepts: readonly string[];
  actualResponseText: string;
  modelTag?: string;
  /** B0-806 — Anthropic `output_config.effort` for this grade; ignored by OpenAI models. */
  effort?: ModelEffort;
};

/**
 * The phrase lists the case is graded against. Expected is the union of the two columns (first-seen
 * order, `normConcept` identity): a must-have that the expected column does not also list is added
 * to it, so a missed must-have is always visible in the coverage Completeness is capped at —
 * the `mandatory_subset_of_expected` invariant depends on it.
 */
export function requiredConcepts(input: Pick<CaseScoringInput, 'mandatoryConcepts' | 'expectedConcepts'>): {
  mandatory: string[];
  expected: string[];
} {
  const mandatory = [...input.mandatoryConcepts];
  const expected = [...input.expectedConcepts];
  const seen = new Set(expected.map(normConcept));
  for (const phrase of mandatory) {
    const key = normConcept(phrase);
    if (!seen.has(key)) {
      seen.add(key);
      expected.push(phrase);
    }
  }
  return { mandatory, expected };
}

/** True when the case has no concept data at all — nothing to grade the response against. */
export function hasNoConcepts(input: Pick<CaseScoringInput, 'mandatoryConcepts' | 'expectedConcepts'>): boolean {
  return input.mandatoryConcepts.length === 0 && input.expectedConcepts.length === 0;
}

/**
 * The user turn, mirroring the `cases.json` a desktop grading run is handed (`inspect_run_export.py`):
 * the same field names, the concept lists already split, the actual response verbatim.
 */
export function buildGraderPayload(input: CaseScoringInput): string {
  const required = requiredConcepts(input);
  return JSON.stringify(
    {
      question: input.question,
      priority_raw: input.priorityRaw,
      category: input.category,
      expected: input.idealResponse,
      // B0-933 — resolved document titles, not `rag.document` uuids.
      expected_sources: input.expectedSources.map(formatExpectedSourceRef),
      should_cite: input.shouldCite,
      minimal_concepts: required.mandatory,
      expected_concepts: required.expected,
      actual: input.actualResponseText,
    },
    null,
    2,
  );
}

/**
 * Matches the grader's satisfied list back to *our* required list for one kind. A required phrase is
 * satisfied when the grader listed it (by `normConcept` identity) as satisfied and not also as
 * missing; anything else — listed as missing, or not judged at all — is missing, the conservative
 * reading the reference `normalize_concepts` takes ("unjudged is treated as not present"). Phrases
 * are re-emitted from our list, verbatim, so `satisfied ∪ missing === required` holds by construction
 * and no model re-spelling of a regulated phrase survives.
 */
function reconcileKind(
  required: readonly string[],
  judgedSatisfied: readonly string[],
  judgedMissing: readonly string[],
): ConceptKindCoverage {
  const satisfiedKeys = new Set(judgedSatisfied.map(normConcept));
  const missingKeys = new Set(judgedMissing.map(normConcept));
  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const phrase of required) {
    const key = normConcept(phrase);
    if (satisfiedKeys.has(key) && !missingKeys.has(key)) satisfied.push(phrase);
    else missing.push(phrase);
  }
  return { required: [...required], satisfied, missing };
}

export function reconcileConcepts(
  required: { mandatory: readonly string[]; expected: readonly string[] },
  judged: GraderOutput['concepts'],
): CaseConcepts {
  return {
    mandatory: reconcileKind(required.mandatory, judged.minimal_satisfied, judged.minimal_missing),
    expected: reconcileKind(required.expected, judged.expected_satisfied, judged.expected_missing),
    materialIssue: judged.material_issue,
    materialIssueNote: judged.material_issue ? judged.material_issue_note : null,
  };
}

function clamp(value: number | null, min: number, max: number): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return Math.min(max, Math.max(min, value));
}

/** The Unable-to-Evaluate score, with every judged field empty. */
export function unableToEvaluateScore(reason: string): CaseScore {
  return {
    unableToEvaluate: true,
    uteReason: reason,
    accuracy: null,
    completeness: null,
    relevance: null,
    clarity: null,
    explanation: '',
    missed: '',
    incorrect: '',
    improvement: '',
    concepts: null,
    similarity: null,
    similarityNote: null,
    evalConfidence: null,
    confidenceNote: null,
  };
}

/** Maps a validated grader output onto the persisted `CaseScore`, reconciling the concept lists. */
export function toCaseScore(output: GraderOutput, input: CaseScoringInput): CaseScore {
  if (output.unable_to_evaluate) {
    return unableToEvaluateScore(output.ute_reason?.trim() || 'The grader could not evaluate this case.');
  }
  return {
    unableToEvaluate: false,
    uteReason: null,
    accuracy: clamp(output.accuracy, 0, 100),
    // Judged, not computed — `metrics.ts` caps it at expected-concept coverage downstream (B0-835).
    completeness: clamp(output.completeness, 0, 100),
    relevance: clamp(output.relevance, 0, 100),
    clarity: clamp(output.clarity, 0, 100),
    explanation: output.explanation,
    missed: output.missed,
    incorrect: output.incorrect,
    improvement: output.improvement,
    concepts: reconcileConcepts(requiredConcepts(input), output.concepts),
    similarity: clamp(output.similarity, 0, 1),
    similarityNote: output.similarity_note || null,
    evalConfidence: clamp(output.eval_confidence, 0, 100),
    confidenceNote: output.confidence_note || null,
  };
}

/**
 * B0-819 — the one seam the grader talks to a model through (`~/lib/llm/structured-completion.ts`).
 * Production routes on the resolved model id — `claude-*` to Anthropic, everything else to the
 * OpenAI Responses API — and hands both the same prompt and the same `GRADER_JSON_SCHEMA` bytes;
 * tests inject a fake.
 *
 * B0-1115 — widened to also return the call's token usage (`CompletionResult`), so a successful
 * grading call can be recorded via `recordGradingUsage` before it is discarded.
 */
export type StructuredCompletionWithUsage = (
  request: StructuredCompletionRequest,
) => Promise<CompletionResult>;

/**
 * Output cap for one grade. Anthropic counts thinking tokens against it, so it is sized for a
 * high-effort think plus the JSON, not for the JSON alone; on OpenAI it is a far ceiling.
 */
export const GRADER_MAX_OUTPUT_TOKENS = 16_000;

export type ScoreCaseDeps = {
  complete?: StructuredCompletionWithUsage;
  resolveModel?: (modelTag: string | undefined) => Promise<string>;
};

/**
 * Grades one case on one pass. A case with no concept columns is returned Unable to Evaluate without
 * a model call — there is no concept data to grade against, so there is nothing to pay for.
 *
 * B0-1115 — `context`, when given, is the (testResultId, testItemId, passIndex) triple this pass is
 * scoring; a successful call's usage is recorded against it via `recordGradingUsage`. Optional so
 * every existing caller/test that doesn't care about usage keeps working unchanged; the production
 * caller (`scoreOnePass` in `orchestrator.ts`) always passes it.
 */
export async function scoreCase(
  input: CaseScoringInput,
  deps: ScoreCaseDeps = {},
  context?: GradingUsageContext,
): Promise<CaseScore> {
  if (hasNoConcepts(input)) {
    return unableToEvaluateScore(NO_EXPECTED_CONCEPTS_UTE_REASON);
  }

  const complete = deps.complete ?? completeStructuredWithUsage;
  const resolveModel = deps.resolveModel ?? resolveGradingModel;

  try {
    const model = await resolveModel(input.modelTag ?? DEFAULT_GRADING_MODEL_TAG);
    const { text, usage } = await complete({
      model,
      system: CASE_SCORING_SYSTEM_PROMPT,
      user: buildGraderPayload(input),
      schemaName: 'case_score',
      schema: GRADER_JSON_SCHEMA,
      maxOutputTokens: GRADER_MAX_OUTPUT_TOKENS,
      temperature: 0,
      effort: input.effort,
    });
    // B0-1115 — success path only: a refusal/truncation/transport failure throws before any usage
    // is ever returned (see structured-completion.ts runOpenAI/runAnthropic), so there is nothing to
    // record on those paths. Recorded before parsing so a parseable-but-unusable answer still counts
    // the spend that produced it.
    if (context) {
      recordGradingUsage({
        context,
        callSite: 'case_scorer',
        provider: modelProviderFor(model),
        model,
        usage,
      });
    }
    const parsed = graderOutputSchema.parse(JSON.parse(text));
    return toCaseScore(parsed, input);
  } catch (error) {
    return unableToEvaluateScore(
      `${GRADING_CALL_FAILED_PREFIX}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}
