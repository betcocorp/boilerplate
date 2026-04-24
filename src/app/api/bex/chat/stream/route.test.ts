import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '~/app/api/bex/chat/stream/route';
import { canPostBexChat } from '~/lib/api/bex-api-auth';
import { runBexChatTurn } from '~/lib/bex/run-chat-turn';

vi.mock('~/lib/api/bex-api-auth', () => ({
  canPostBexChat: vi.fn(),
}));

vi.mock('~/lib/bex/run-chat-turn', () => ({
  runBexChatTurn: vi.fn(),
}));

vi.mock('~/lib/observability/logger', () => ({
  logInfo: vi.fn(),
}));

vi.mock('~/lib/observability/correlation-id', () => ({
  newCorrelationId: () => 'trace-test-1',
}));

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/bex/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readResponseBody(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

describe('POST /api/bex/chat/stream', () => {
  beforeEach(() => {
    process.env.BEX_AI_SDK_STREAMING_ENABLED = 'true';
    vi.mocked(canPostBexChat).mockReset();
    vi.mocked(runBexChatTurn).mockReset();
  });

  afterEach(() => {
    delete process.env.BEX_AI_SDK_STREAMING_ENABLED;
  });

  it('returns 404 when streaming is disabled', async () => {
    process.env.BEX_AI_SDK_STREAMING_ENABLED = 'false';
    vi.mocked(canPostBexChat).mockReturnValue(true);

    const response = await POST(makeRequest({ message: 'Hi there' }));

    expect(response.status).toBe(404);
  });

  it('returns 401 when auth fails', async () => {
    vi.mocked(canPostBexChat).mockReturnValue(false);

    const response = await POST(makeRequest({ message: 'Hi there' }));

    expect(response.status).toBe(401);
  });

  it('returns 400 when request body is invalid', async () => {
    vi.mocked(canPostBexChat).mockReturnValue(true);

    const response = await POST(makeRequest({}));

    expect(response.status).toBe(400);
  });

  it('returns a UI message stream response when valid', async () => {
    vi.mocked(canPostBexChat).mockReturnValue(true);
    vi.mocked(runBexChatTurn).mockResolvedValue({
      traceId: 'trace-test-1',
      conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      answerText: 'Hello from stream output.',
      workflowRunId: 'f9dc4fb8-a4ce-4b81-8ce8-f4f7f9f16dea',
      latestOpenaiResponseId: 'resp_123',
      validation: {
        approved: true,
        confidence: 0.92,
        issues: [],
        requires_human_review: false,
      },
      routingDecision: 'orchestrator',
      timingBreakdown: {
        toolRounds: 1,
        cacheSource: null,
        searchMs: null,
      },
      confidence: 0.92,
      sources: [],
    });

    const response = await POST(
      makeRequest({
        message: 'Hello',
        conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      }),
    );

    const body = await readResponseBody(response);

    expect(response.status).toBe(200);
    expect(body).toContain('"type":"data-bex-meta"');
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain('Hello from stream output.');
  });
});
