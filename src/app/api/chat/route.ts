import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { convertToModelMessages, streamText, type UIMessage } from 'ai';

import { modelProviderFor } from '~/lib/constants/models';
import { resolveModel } from '~/lib/llm/resolve-model';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Minimal AI SDK streaming chat route example. `resolveModel` (`~/lib/llm/resolve-model`) resolves
 * a vendor-neutral tag (e.g. "gpt-4.1", "claude-sonnet-5", or omitted for the settings-table
 * default) to a concrete model id; `modelProviderFor` decides which provider SDK wraps it. Swap in
 * retrieval, tool-calling, or a different provider as your app needs.
 */
export async function POST(req: Request) {
  const { messages, model }: { messages: UIMessage[]; model?: string } = await req.json();

  const modelId = await resolveModel(model);
  const languageModel =
    modelProviderFor(modelId) === 'anthropic' ? anthropic(modelId) : openai(modelId);

  const result = streamText({
    model: languageModel,
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
