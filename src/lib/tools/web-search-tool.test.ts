import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-595 — `web_search` as a general-purpose tool for SME agents / the orchestrator.
 *
 * This is deliberately an integration-style test of the SHARED dispatch path, not just the tool's
 * own input schema: `/api/v1/agents/*` (via `runProductSupportWorkflow`'s Responses/AI-SDK tool
 * loop) and `/api/v1/orchestrator`'s `bex-chat` workflow both funnel every model-requested tool
 * call through `executeToolCall` -> `executeProductTool` (see the module doc comments in
 * `~/lib/tools/execute-tool-call.ts` and `~/lib/bex/ai-sdk-runtime.ts`). Proving `web_search` is
 * reachable through THAT boundary — not a mocked stand-in for it — is what confirms no separate
 * per-route wiring was needed, per the ticket's explicit "don't just assume the shared dispatch
 * covers it" instruction.
 *
 * Only the network-facing edges are mocked: `WebSearchService` itself (so no real Tavily/mock
 * provider call happens) and `writeAuditLog` (so no real Supabase insert happens). `product-tools.ts`
 * and `execute-tool-call.ts` run for real.
 */

const searchMock = vi.hoisted(() => vi.fn());
const createWebSearchServiceMock = vi.hoisted(() =>
  vi.fn(async () => ({ search: searchMock, providerName: 'tavily' })),
);
const writeAuditLogMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('~/lib/websearch/web-search-service', () => ({
  createWebSearchService: createWebSearchServiceMock,
}));

vi.mock('~/lib/audit/audit-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/audit/audit-log')>()),
  writeAuditLog: writeAuditLogMock,
}));

import { executeToolCall } from '~/lib/tools/execute-tool-call';
import { productSupportToolsForRoute } from '~/lib/tools/definitions';
import { executeProductTool } from '~/lib/tools/product-tools';
import { PRODUCT_TOOL_NAMES } from '~/lib/tools/tool-schemas';

/** Every specialist route `/api/v1/agents/*` can force via `runProductSupportWorkflow`. */
const SME_AGENT_ROUTES = [
  'product',
  'bathroom',
  'dilution',
  'floor_wood_sport',
  'floor_concrete',
  'floor_stg',
  'floor_vct',
  'recommendations',
] as const;

const SAMPLE_RESPONSE = {
  query: 'Spartan Chemical Company headquarters',
  provider: 'tavily',
  answer: 'Spartan Chemical Company is headquartered in Maumee, Ohio.',
  results: [
    {
      title: 'Spartan Chemical Company',
      url: 'https://example.com/spartan',
      snippet: 'Headquartered in Maumee, OH.',
      score: 0.9,
    },
  ],
  metrics: { latencyMs: 120, resultCount: 1, estimatedCostUsd: 0.008, cached: false },
};

function toolNames(route: string): string[] {
  return productSupportToolsForRoute(route).map((tool) => (tool.type === 'function' ? tool.name : ''));
}

beforeEach(() => {
  searchMock.mockReset();
  createWebSearchServiceMock.mockClear();
  writeAuditLogMock.mockReset();
  searchMock.mockResolvedValue(SAMPLE_RESPONSE);
});

describe('web_search tool wiring (B0-595)', () => {
  it('is a real product tool, registered in PRODUCT_TOOL_NAMES', () => {
    expect(PRODUCT_TOOL_NAMES as readonly string[]).toContain('web_search');
  });

  it('is offered on every /api/v1/agents/* specialist route with no extra per-route wiring', () => {
    for (const route of SME_AGENT_ROUTES) {
      expect(toolNames(route), `${route} should carry web_search`).toContain('web_search');
    }
  });

  it('executeProductTool dispatches to WebSearchService.search with the parsed args', async () => {
    const result = await executeProductTool(
      'web_search',
      { query: 'Spartan Chemical Company headquarters', depth: 'advanced', maxResults: 3 },
      { traceId: 't1', workflowRunId: 'wf1', conversationId: 'c1' },
    );

    expect(createWebSearchServiceMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith({
      query: 'Spartan Chemical Company headquarters',
      depth: 'advanced',
      maxResults: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.adapter).toBe('web_search_v1');
    expect(result.results).toEqual(SAMPLE_RESPONSE.results);
    expect(result.answer).toBe(SAMPLE_RESPONSE.answer);
    expect(result.metrics).toEqual(SAMPLE_RESPONSE.metrics);
  });

  it('audit-logs a model-invoked call the same way /api/v1/tools/web-search\'s route does', async () => {
    await executeProductTool(
      'web_search',
      { query: 'Spartan Chemical Company headquarters' },
      { traceId: 't2', workflowRunId: 'wf2', conversationId: 'c2', specialistId: 'bathroom' },
    );

    expect(writeAuditLogMock).toHaveBeenCalledWith(
      'web_search',
      expect.objectContaining({
        source: 'model_tool',
        specialist_id: 'bathroom',
        query: 'Spartan Chemical Company headquarters',
        provider: 'tavily',
        depth: 'basic',
        result_count: 1,
        latency_ms: 120,
        estimated_cost_usd: 0.008,
      }),
      expect.objectContaining({ traceId: 't2', workflowRunId: 'wf2', toolName: 'web_search' }),
    );
  });

  it('skips the audit log when no auditCtx is supplied', async () => {
    await executeProductTool('web_search', { query: 'no ctx here' });
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('rejects a call with no query', async () => {
    await expect(executeProductTool('web_search', {})).rejects.toThrow();
  });

  /**
   * The actual boundary both `/api/v1/agents/*` and `/api/v1/orchestrator` call for every
   * model-requested tool — see the module doc comment above.
   */
  it('is reachable through the shared executeToolCall boundary the runtimes use', async () => {
    const result = await executeToolCall({
      name: 'web_search',
      argumentsJson: JSON.stringify({ query: 'Spartan Chemical Company headquarters' }),
      callId: 'call_1',
      auditCtx: { traceId: 't3', workflowRunId: 'wf3', conversationId: 'c3' },
    });

    expect(result.trace.ok).toBe(true);
    expect(result.trace.toolName).toBe('web_search');
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.results).toEqual(SAMPLE_RESPONSE.results);
    expect(writeAuditLogMock).toHaveBeenCalled();
  });

  it('an unsupported tool name is still rejected the same way (sanity check on isProductTool)', async () => {
    const result = await executeToolCall({
      name: 'not_a_real_tool',
      argumentsJson: '{}',
      callId: 'call_2',
    });
    expect(result.trace.ok).toBe(false);
  });
});
