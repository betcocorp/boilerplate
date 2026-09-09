import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

import { modelProviderFor, type ModelProvider } from '~/lib/constants/models';
import type { AssistantMessageContent, SourceRef } from '~/lib/conversations/conversation-schemas';
import { resolveModel } from '~/lib/llm/resolve-model';
import type { ValidatorResult } from '~/lib/workflows/product-support/product-support-schemas';
import type { ChatMessage } from '~/types/bex';

type UnknownRecord = Record<string, unknown>;

type AiSdkTextPart = {
  type?: string;
  text?: string;
};

type AiSdkToolPart = {
  type?: string;
  toolName?: string;
  state?: string;
  errorText?: string;
};

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * B0-908 — the Anthropic provider, sitting next to the OpenAI one. Both providers read their key
 * lazily (at request time, inside the headers builder), so a missing `ANTHROPIC_API_KEY` fails the
 * first Claude call, not this module's import — an OpenAI-only deploy keeps working untouched.
 */
const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * B0-908 — which AI SDK provider serves a resolved model id. Thin alias over `modelProviderFor` so
 * the runtime and the resolver agree by construction: the `claude-` prefix, never a flag, decides.
 */
export function aiSdkProviderFor(model: string): ModelProvider {
  return modelProviderFor(model);
}

/**
 * Resolves a UI/API model tag to an AI SDK language model. The tag → id mapping (env pins, the
 * per-vendor `preview` default rows, B0-899) lives in `resolveModel`; only the provider choice lives here.
 */
export async function resolveAiSdkLanguageModel(modelTag: string | undefined) {
  const model = await resolveModel(modelTag);
  return aiSdkProviderFor(model) === 'anthropic' ? anthropic(model) : openai(model);
}

export function extractTextFromAiSdkParts(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return '';
  }

  return parts
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }
      const candidate = part as AiSdkTextPart;
      if (candidate.type !== 'text' || typeof candidate.text !== 'string') {
        return '';
      }
      return candidate.text;
    })
    .filter(Boolean)
    .join('');
}

export function extractToolSummaryFromAiSdkParts(
  parts: unknown,
): Array<{ name: string; ok: boolean }> | undefined {
  if (!Array.isArray(parts)) {
    return undefined;
  }

  const summary = parts
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return null;
      }

      const candidate = part as AiSdkToolPart;
      if (
        typeof candidate.type !== 'string' ||
        !candidate.type.startsWith('tool-') ||
        typeof candidate.toolName !== 'string'
      ) {
        return null;
      }

      const ok = candidate.state === 'output-available' && !candidate.errorText;
      return {
        name: candidate.toolName,
        ok,
      };
    })
    .filter((item): item is { name: string; ok: boolean } => Boolean(item));

  return summary.length > 0 ? summary : undefined;
}

export function mapValidatorToAssistantValidation(validation: ValidatorResult) {
  return {
    approved: validation.approved,
    issues: validation.issues,
    requiresHumanReview: validation.requires_human_review,
  };
}

export function buildAssistantMessageContent(input: {
  text: string;
  model?: string;
  sources?: SourceRef[];
  confidence?: number;
  workflowRunId?: string;
  validation?: ValidatorResult;
  toolSummary?: Array<{ name: string; ok: boolean }>;
  routingHint?: {
    decision: string;
    rationale?: string;
  };
}): AssistantMessageContent {
  return {
    kind: 'assistant_turn',
    text: input.text,
    model: input.model,
    sources: input.sources,
    confidence: input.confidence,
    workflowRunId: input.workflowRunId,
    routingHint: input.routingHint,
    validation: input.validation
      ? mapValidatorToAssistantValidation(input.validation)
      : undefined,
    toolSummary: input.toolSummary,
  };
}

export function mapAiSdkAssistantPartsToChatMessage(input: {
  id: string;
  createdAt: number;
  parts: unknown;
  data?: UnknownRecord;
}): ChatMessage {
  const text = extractTextFromAiSdkParts(input.parts);
  const toolSummary = extractToolSummaryFromAiSdkParts(input.parts);

  const sourcesRaw = input.data?.sources;
  const sources = Array.isArray(sourcesRaw) ? (sourcesRaw as SourceRef[]) : undefined;

  const validationRaw = input.data?.validation as
    | { approved?: unknown; requiresHumanReview?: unknown; issues?: unknown }
    | undefined;

  return {
    id: input.id,
    role: 'assistant',
    content: text,
    createdAt: input.createdAt,
    workflowRunId:
      typeof input.data?.workflowRunId === 'string'
        ? input.data.workflowRunId
        : undefined,
    meta: {
      model: typeof input.data?.model === 'string' ? input.data.model : undefined,
      confidence:
        typeof input.data?.confidence === 'number' ? input.data.confidence : undefined,
      sources,
      toolSummary,
      validation:
        validationRaw &&
        typeof validationRaw.approved === 'boolean' &&
        typeof validationRaw.requiresHumanReview === 'boolean'
          ? {
              approved: validationRaw.approved,
              requiresHumanReview: validationRaw.requiresHumanReview,
              issues: Array.isArray(validationRaw.issues)
                ? (validationRaw.issues.filter(
                    (issue): issue is string => typeof issue === 'string',
                  ) as string[])
                : undefined,
            }
          : undefined,
    },
  };
}
