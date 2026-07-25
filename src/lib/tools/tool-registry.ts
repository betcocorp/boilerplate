export const V1_TOOL_IDS = ['web-search', 'efficacy'] as const;
export type V1ToolId = (typeof V1_TOOL_IDS)[number];

export const V1_TOOL_REGISTRY = [
  {
    id: 'web-search',
    path: '/api/v1/tools/web-search',
    method: 'POST',
    label: 'Web Search',
    description:
      'Web search exposed as a client-authenticated tool under `/api/v1/tools/*`. Same wrapper as `/api/admin/web-search`, but behind a client token (server-to-server) instead of a NextAuth session. All provider logic, caching, source-trust ranking, and rate-limit/cost guardrails live in WebSearchService — the route only authenticates, validates, and maps errors.',
    schemaRef: 'websearch-schemas.ts#webSearchRequestSchema',
  },
  {
    id: 'efficacy',
    path: '/api/v1/tools/efficacy',
    method: 'POST',
    label: 'Efficacy & Dilution Lookup',
    description:
      'Deterministic lookup of dilution ratios and efficacy data for Betco products from RAG. Queries rag.product_line_fact and other sources. Pure function: same input always returns same output, suitable for caching and orchestrator tool calling.',
    schemaRef: 'efficacy/dilution-tool.ts#dilutionToolRequestSchema',
  },
] as const satisfies ReadonlyArray<{
  id: V1ToolId;
  path: `/api/v1/tools/${V1ToolId}`;
  method: 'GET' | 'POST';
  label: string;
  description: string;
  schemaRef: string;
}>;
