import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { samplingParamsFor } from '~/lib/openai/model-capabilities';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';
import {
  resolveOpenAiRequestTimeoutMs,
  retryTransportFaults,
} from '~/lib/openai/transport-retry';
import { resolveMaxOutputTokens } from '~/lib/workflows/product-support/max-output-tokens';

import {
  DECLINE_GRADER_JSON_SCHEMA,
  semanticDeclineVerdictSchema,
  type SemanticDeclineVerdict,
} from './decline-schemas';

/**
 * B0-755 — LLM semantic-decline grader, called only as a fallback (see `gradeChatTestResponseAsync`
 * in `./grading.ts`) when a negative-expectation row's response matched neither the app's own
 * canonical decline copy nor the phrase/regex heuristics. Same model-resolution convention as the
 * criteria grader (`~/lib/tests/criteria-grader.ts`): a dedicated env var wins, otherwise the
 * standard Responses model resolution.
 */
export async function resolveDeclineGraderModel(modelTag?: string): Promise<string> {
  return (
    process.env.BEX_GRADER_MODEL?.trim() || resolveResponsesModel(modelTag ?? 'preview')
  );
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
 * One structured-output Responses API call judging whether `responseText` is substantively a
 * decline. Throws on transport/parse failure — callers (`gradeChatTestResponseAsync`) decide how
 * to fall back, rather than this function silently guessing a verdict.
 */
export async function gradeSemanticDecline(
  input: SemanticDeclineCheckInput,
): Promise<SemanticDeclineVerdict> {
  const client = getOpenAIClient();
  const model = await resolveDeclineGraderModel(input.modelTag);

  const res = await retryTransportFaults(
    () =>
      client.responses.create(
        {
          model,
          instructions: DECLINE_GRADER_SYSTEM_PROMPT,
          input: [
            {
              role: 'user',
              type: 'message',
              content: buildUserMessage({
                prompt: input.prompt,
                responseText: input.responseText,
                idealResponse: input.idealResponse,
                expectedConcepts: input.expectedConcepts,
                minimumConcepts: input.minimumConcepts,
              }),
            },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'semantic_decline_grading_result',
              strict: true,
              schema: DECLINE_GRADER_JSON_SCHEMA,
            },
          },
          store: false,
          stream: false,
          ...samplingParamsFor(model, { temperature: 0 }),
          max_output_tokens: resolveMaxOutputTokens(),
        },
        { maxRetries: 0, timeout: resolveOpenAiRequestTimeoutMs() },
      ),
    { runtime: 'responses', label: 'decline-grader.create' },
  );

  const text = extractAssistantText(res);
  const parsedJson = JSON.parse(text) as unknown;
  return semanticDeclineVerdictSchema.parse(parsedJson);
}
