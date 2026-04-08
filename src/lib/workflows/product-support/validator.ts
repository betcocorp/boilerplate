import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';

import {
  validatorResultSchema,
  type ValidatorResult,
} from '~/lib/workflows/product-support/product-support-schemas';
import { VALIDATOR_SYSTEM_PROMPT } from '~/lib/workflows/product-support/product-support-prompts';

const VALIDATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    approved: { type: 'boolean' },
    confidence: { type: 'number' },
    issues: { type: 'array', items: { type: 'string' } },
    requires_human_review: { type: 'boolean' },
  },
  required: ['approved', 'confidence', 'issues', 'requires_human_review'],
} as const;

export async function runValidatorPass(input: {
  draftAnswer: string;
  evidenceSummary: string;
  modelTag?: string;
}): Promise<ValidatorResult> {
  const client = getOpenAIClient();
  const model =
    process.env.BEX_VALIDATOR_MODEL?.trim() ||
    resolveResponsesModel(input.modelTag ?? 'preview');

  const payload = {
    draft: input.draftAnswer,
    evidence_summary: input.evidenceSummary,
  };

  const res = await client.responses.create({
    model,
    instructions: VALIDATOR_SYSTEM_PROMPT,
    input: [
      {
        role: 'user',
        content: JSON.stringify(payload),
        type: 'message',
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'validation_result',
        strict: true,
        schema: VALIDATION_JSON_SCHEMA,
      },
    },
    store: false,
    stream: false,
    temperature: 0,
  });

  try {
    const text = extractAssistantText(res);
    const parsed = JSON.parse(text) as unknown;
    return validatorResultSchema.parse(parsed);
  } catch {
    return {
      approved: false,
      confidence: 0,
      issues: ['validator_output_parse_failed'],
      requires_human_review: true,
    };
  }
}

export async function runRevisionPass(input: {
  draftAnswer: string;
  validatorIssues: string[];
  evidenceSummary: string;
  modelTag?: string;
}): Promise<string> {
  const client = getOpenAIClient();
  const model = resolveResponsesModel(input.modelTag ?? 'preview');

  const res = await client.responses.create({
    model,
    instructions: [
      'Revise the draft answer to fix validator issues.',
      'Do not add new factual claims beyond the evidence summary.',
      'If you cannot fix safely, reply with a short clarification request only.',
    ].join('\n'),
    input: [
      {
        role: 'user',
        content: JSON.stringify({
          draft: input.draftAnswer,
          issues: input.validatorIssues,
          evidence_summary: input.evidenceSummary,
        }),
        type: 'message',
      },
    ],
    store: false,
    stream: false,
    temperature: 0.2,
  });

  return extractAssistantText(res);
}
