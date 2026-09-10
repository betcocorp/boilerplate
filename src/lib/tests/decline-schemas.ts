import { z } from 'zod';

/**
 * B0-755 — structured-output contract for the semantic decline grader
 * (`~/lib/tests/decline-grader.ts`).
 *
 * Rows whose correct outcome is a refusal used to be graded by matching the response's wording
 * against a fixed phrase/regex list (`responseIndicatesDeclineStyleAnswer` in `./grading.ts`).
 * That list catches "I can't provide…" but misses the model's actual paraphrased declines
 * ("Pricing is not published… please contact your Betco distributor"), so the SAME response flips
 * pass/fail across identical runs purely on wording. This schema is the shape of the model's
 * judgement of whether a response is *substantively* a decline, independent of vocabulary.
 *
 * B0-932 — "a refusal is the correct outcome here" is no longer a column
 * (`expected_should_answer` was dropped); it is expressed by the item's `minimum_concepts`
 * phrases, which describe the refusal and are handed to this grader as context.
 */
export const semanticDeclineVerdictSchema = z.object({
  isDecline: z.boolean(),
  rationale: z.string(),
});
export type SemanticDeclineVerdict = z.infer<typeof semanticDeclineVerdictSchema>;

/**
 * B0-902 — what `gradeSemanticDecline` returns and `response_payload.semanticDeclineGrading`
 * persists: the model's verdict plus which resolved model / provider produced it. The model never
 * sets these two — `DECLINE_GRADER_JSON_SCHEMA` below has no such properties — they are stamped on
 * after the call, so a row always says which model judged it.
 */
export const semanticDeclineGradingSchema = semanticDeclineVerdictSchema.extend({
  gradingModel: z.string().nullable().optional(),
  gradingProvider: z.enum(['openai', 'anthropic']).nullable().optional(),
});
export type SemanticDeclineGrading = z.infer<typeof semanticDeclineGradingSchema>;

/** JSON Schema mirror of `semanticDeclineVerdictSchema` for `client.responses.create({ text: { format } })`. */
export const DECLINE_GRADER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isDecline: {
      type: 'boolean',
      description:
        'true if the response functions as a decline: it does not supply the specific fact/value/approval asked for, and instead says the information is unavailable, unverified, not published, or out of scope, or redirects the user elsewhere for it. false if it substantively states the requested fact/value as if true (correct, fabricated, or otherwise).',
    },
    rationale: {
      type: 'string',
      description:
        'One sentence citing the specific text from the response that makes this a decline or an answer.',
    },
  },
  required: ['isDecline', 'rationale'],
} as const;
