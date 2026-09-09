import { completeStructuredWithUsage } from '~/lib/llm/structured-completion';
import {
  resolveOpenAiRequestTimeoutMs,
  retryTransportFaults,
} from '~/lib/openai/transport-retry';
import { resolveMaxOutputTokens } from '~/lib/workflows/product-support/max-output-tokens';

import {
  DECLINE_GRADER_JSON_SCHEMA,
  semanticDeclineVerdictSchema,
  type SemanticDeclineGrading,
} from './decline-schemas';
import { resolveItemGradingConfig } from './item-grading-model';

/**
 * B0-755 — LLM semantic-decline grader, called only as a fallback (see `gradeChatTestResponseAsync`
 * in `./grading.ts`) when a negative-expectation row's response matched neither the app's own
 * canonical decline copy nor the phrase/regex heuristics. B0-902 — same model resolution as the
 * criteria grader: the shared `TEST_ITEM_GRADING_MODEL` row (`./item-grading-model.ts`), which by
 * default follows the run's own model tag. The former `BEX_GRADER_MODEL` env override is gone.
 */
export async function resolveDeclineGraderModel(modelTag?: string): Promise<string> {
  return (await resolveItemGradingConfig(modelTag)).model;
}

const DECLINE_GRADER_SYSTEM_PROMPT = `You are grading whether an AI assistant's response is a "decline" — the correct outcome for a question this assistant is not supposed to answer directly (e.g. pricing, or a state-by-state regulatory approval it cannot verify).

A response counts as a decline (isDecline: true) when, in substance, it does NOT supply the specific fact, number, or approval the user asked for, and instead does one or more of:
- says the information is not available, not verified, not confirmed, or not published in its sources
- explains the answer varies (e.g. by distributor, region, or state) and so cannot be stated reliably
- redirects the user to a person, team, or channel (a distributor, Betco Customer Service, Betco Regulatory Affairs, a sales rep) to get the real answer
- declines for scope, safety, or policy reasons

A response is NOT a decline (isDecline: false) when it states the specific requested fact, value, or approval as if it were true — whether that fact is correct, fabricated, or hallucinated — or otherwise substantively answers the question asked.

Judge the substance, not the vocabulary: the wording does not need to match any fixed phrase, and a bulleted, multi-sentence, or hedged response that never actually gives the requested answer and points elsewhere is still a decline. When given the item's own expected/ideal answer, use it only to understand what a decline looks like for this question — do not require the wording to match it. Ground your rationale in specific text from the response.`;

function buildUserMessage(params: {
  prompt: string;
  responseText: string;
  idealResponse: string | null;
  expectedConcepts: string | null;
  minimumConcepts: string | null;
}): string {
  const lines = [`Original prompt (expected to be declined, not answered):\n${params.prompt}`];

  if (params.idealResponse) {
    lines.push(`What a correct decline looks like for this question:\n${params.idealResponse}`);
  }
  if (params.minimumConcepts) {
    lines.push(`Minimum concepts a correct decline should cover:\n${params.minimumConcepts}`);
  }
  if (params.expectedConcepts) {
    lines.push(`Full expected concepts:\n${params.expectedConcepts}`);
  }

  lines.push(`Assistant response to grade:\n${params.responseText}`);

  return lines.join('\n\n');
}

export type SemanticDeclineCheckInput = {
  prompt: string;
  responseText: string;
  idealResponse: string | null;
  expectedConcepts: string | null;
  minimumConcepts: string | null;
  modelTag?: string;
};

/**
 * One structured-output call through `completeStructuredWithUsage` (B0-908: routes by provider on
 * the resolved model id) judging whether `responseText` is substantively a
 * decline. Throws on transport/parse failure (a truncated or refused answer throws too) — the one
 * caller, `gradeChatTestResponseAsync`, turns that into an explicit "could not be evaluated" on the
 * row (B0-902) rather than this function guessing a verdict. The verdict carries the resolved model
 * id and provider that produced it, which the runner persists as `semanticDeclineGrading`.
 */
export async function gradeSemanticDecline(
  input: SemanticDeclineCheckInput,
): Promise<SemanticDeclineGrading> {
  const grading = await resolveItemGradingConfig(input.modelTag);

  const { text } = await retryTransportFaults(
    () =>
      completeStructuredWithUsage({
        model: grading.model,
        effort: grading.effort,
        system: DECLINE_GRADER_SYSTEM_PROMPT,
        user: buildUserMessage({
          prompt: input.prompt,
          responseText: input.responseText,
          idealResponse: input.idealResponse,
          expectedConcepts: input.expectedConcepts,
          minimumConcepts: input.minimumConcepts,
        }),
        schemaName: 'semantic_decline_grading_result',
        schema: DECLINE_GRADER_JSON_SCHEMA,
        maxOutputTokens: resolveMaxOutputTokens(),
        temperature: 0,
        requestOptions: { maxRetries: 0, timeoutMs: resolveOpenAiRequestTimeoutMs() },
      }),
    { runtime: 'responses', label: 'decline-grader.create' },
  );

  const parsedJson = JSON.parse(text) as unknown;
  return {
    ...semanticDeclineVerdictSchema.parse(parsedJson),
    gradingModel: grading.model,
    gradingProvider: grading.provider,
  };
}
