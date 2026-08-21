import { describe, expect, it, vi } from 'vitest';

const executeProductToolMock = vi.hoisted(() => vi.fn());

vi.mock('~/lib/tools/product-tools', () => ({
  executeProductTool: (...args: unknown[]) => executeProductToolMock(...args),
}));

import { executeToolCall } from '~/lib/tools/execute-tool-call';

const HUGE_BODY = [
  `## Section 1. Identification\n${'a'.repeat(6_000)}`,
  `## Section 12. Ecological information\n${'b'.repeat(9_000)}`,
  `## Section 4. First-aid measures\nIf in eyes: rinse cautiously with water for several minutes.`,
].join('\n\n');

describe('executeToolCall — model vs persisted payload (B0-437)', () => {
  it('returns the FULL payload as `output` and a smaller `modelOutput` for the model', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      sources: [
        {
          documentId: 'doc-1',
          chunkId: 'chunk-1',
          title: 'pH7Q Dual SDS',
          snippet: 'If in eyes: rinse cautiously with water',
          matchedChunkText: 'If in eyes: rinse cautiously with water for several minutes.',
          documentBody: HUGE_BODY,
          documentBodyChars: HUGE_BODY.length,
          documentBodyChunkCount: 3,
          documentBodyTruncated: false,
          documentBodyTokenEstimate: 4_000,
          documentBodyChunkIds: ['chunk-1', 'chunk-2', 'chunk-3'],
          confidence: 0.77,
          documentKind: 'sds',
          productLineKey: 'ph7q-dual',
          productKey: null,
          s3Key: 'sds/betco/ph7q.pdf',
          sourceUri: 's3://betco-sds/sds/betco/ph7q.pdf',
        },
      ],
    });

    const result = await executeToolCall({
      name: 'search_product_docs',
      argumentsJson: JSON.stringify({ freeformQuery: 'pH7Q Dual first aid' }),
      callId: 'call_1',
    });

    // The persisted copy — what the validator and the regulated-claim guardrail read — is untouched.
    const full = JSON.parse(result.output) as {
      sources: Array<Record<string, unknown>>;
    };
    expect(full.sources[0]?.documentBody).toBe(HUGE_BODY);
    expect(full.sources[0]?.snippet).toBe('If in eyes: rinse cautiously with water');
    expect(full.sources[0]?.matchedChunkText).toContain('rinse cautiously');

    // The model's copy is slimmer, keeps citation identity, and never claims to be complete.
    expect(result.modelOutput).toBeDefined();
    expect(result.modelOutput!.length).toBeLessThan(result.output.length);
    const model = JSON.parse(result.modelOutput!) as { sources: Array<Record<string, unknown>> };
    expect(model.sources[0]?.documentId).toBe('doc-1');
    expect('snippet' in (model.sources[0] ?? {})).toBe(false);
    expect('matchedChunkText' in (model.sources[0] ?? {})).toBe(false);
    expect(model.sources[0]?.documentBodyTruncated).toBe(true);
    // The regulated section survives the model-only cap.
    expect(String(model.sources[0]?.documentBody)).toContain('Section 4. First-aid measures');

    // `outputPreview` stays the audit record of the FULL payload; the slim size is recorded alongside.
    expect(result.trace.outputPreview).toBe(result.output.slice(0, 4000));
    expect(result.trace.modelOutputChars).toBe(result.modelOutput!.length);
  });

  it('omits `modelOutput` when there is nothing to slim', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      adapter: 'static_policy_v1',
      policy: { summary: 'Standard product-support escalation.', steps: ['Capture SKU.'] },
    });

    const result = await executeToolCall({
      name: 'get_escalation_policy',
      argumentsJson: JSON.stringify({ issueType: 'safety' }),
      callId: 'call_2',
    });

    expect(result.modelOutput).toBeUndefined();
    expect(result.trace.modelOutputChars).toBeUndefined();
    expect(JSON.parse(result.output)).toMatchObject({ ok: true });
  });

  it('omits `modelOutput` when the slim variant would not actually be smaller', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      sources: [{ documentId: 'doc-1', documentBody: 'short' }],
    });

    const result = await executeToolCall({
      name: 'search_product_docs',
      argumentsJson: '{}',
      callId: 'call_3',
    });

    // The projection adds explicit nulls for missing citation fields, so it is not smaller here.
    expect(result.modelOutput).toBeUndefined();
  });

  it('leaves failures alone — an error payload has no model variant', async () => {
    executeProductToolMock.mockRejectedValueOnce(new Error('embedding provider unavailable'));

    const result = await executeToolCall({
      name: 'search_product_docs',
      argumentsJson: '{"freeformQuery":"x"}',
      callId: 'call_4',
    });

    expect(result.trace.ok).toBe(false);
    expect(result.modelOutput).toBeUndefined();
    expect(JSON.parse(result.output)).toMatchObject({ ok: false });
  });
});

describe('executeToolCall — retrieval parameters on the trace entry (B0-493)', () => {
  const retrievalPayload = {
    strategy: 'anchored_only',
    cacheSource: 'new-embedding',
    search: {
      model: 'text-embedding-3-large',
      limit: 20,
      scope: 'all',
      productLineKey: 'ph7q-dual',
      productKey: null,
      sectionType: null,
      minSimilarity: null,
      retrievalStrategy: 'hybrid+reranked',
      embeddingSource: 'new-embedding',
      timings: {
        totalMs: 120,
        queryEmbeddingMs: 12,
        queryRewriteMs: 4,
        cacheLookupMs: 2,
        embeddingCreateMs: 50,
        cachePersistMs: 3,
        similaritySearchMs: 40,
        rerankMs: 9,
      },
    },
    selection: {
      limit: 3,
      minSimilarity: 0.2,
      maxPerDocument: 1,
      requiredDocumentKinds: ['product_line_profile', 'sds', 'knowledge', 'label'],
    },
  };

  it('extracts retrieval parameters onto the trace entry from the full payload', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      sources: [{ documentId: 'doc-1', chunkId: 'chunk-1', snippet: 'Use 2 oz per gallon.' }],
      retrieval: retrievalPayload,
    });

    const result = await executeToolCall({
      name: 'search_product_docs',
      argumentsJson: JSON.stringify({ freeformQuery: 'pH7Q Dual dilution' }),
      callId: 'call_retrieval',
    });

    expect(result.trace.retrieval).toEqual({
      model: 'text-embedding-3-large',
      limit: 20,
      scope: 'all',
      productLineKey: 'ph7q-dual',
      productKey: null,
      sectionType: null,
      minSimilarity: null,
      retrievalStrategy: 'hybrid+reranked',
      embeddingSource: 'new-embedding',
      timings: retrievalPayload.search.timings,
      selection: retrievalPayload.selection,
    });
  });

  it('survives outputPreview truncation — the structured field is built from the full payload, not the preview', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      sources: Array.from({ length: 20 }, (_, i) => ({
        documentId: `doc-${i}`,
        chunkId: `chunk-${i}`,
        snippet: 'x'.repeat(500),
        documentBody: 'y'.repeat(2_000),
      })),
      // `retrieval` sits after the large `sources[]` array — exactly the case that gets cut from
      // `outputPreview` (capped at 4,000 chars) if this were reconstructed from the preview string.
      retrieval: retrievalPayload,
    });

    const result = await executeToolCall({
      name: 'search_product_docs',
      argumentsJson: '{}',
      callId: 'call_truncated',
    });

    expect(result.trace.outputTruncated).toBe(true);
    expect(result.trace.outputPreview).not.toContain('"retrieval"');
    expect(result.trace.retrieval?.retrievalStrategy).toBe('hybrid+reranked');
    expect(result.trace.retrieval?.selection.minSimilarity).toBe(0.2);
  });

  it('omits `retrieval` for a tool that never ran a search', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      adapter: 'static_policy_v1',
      policy: { summary: 's', steps: [] },
    });

    const result = await executeToolCall({
      name: 'get_escalation_policy',
      argumentsJson: '{}',
      callId: 'call_no_retrieval',
    });

    expect(result.trace.retrieval).toBeUndefined();
  });

  it('carries productLineResolution onto the trace entry when present (B0-619)', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      sources: [],
      retrieval: {
        ...retrievalPayload,
        productLineResolution: {
          candidates: [
            { productLineKey: 'L1', label: 'MAD Detergent', maxSimilarity: 0.61 },
            { productLineKey: 'L2', label: 'MAD Concentrate', maxSimilarity: 0.6 },
          ],
          lockedProductLineKey: null,
          lockReason: 'skipped_ambiguous',
        },
      },
    });

    const result = await executeToolCall({
      name: 'search_product_docs',
      argumentsJson: '{}',
      callId: 'call_lock',
    });

    expect(result.trace.retrieval?.productLineResolution).toEqual({
      candidates: [
        { productLineKey: 'L1', label: 'MAD Detergent', maxSimilarity: 0.61 },
        { productLineKey: 'L2', label: 'MAD Concentrate', maxSimilarity: 0.6 },
      ],
      lockedProductLineKey: null,
      lockReason: 'skipped_ambiguous',
    });
  });

  it('omits `productLineResolution` (but keeps the rest of `retrieval`) when absent (B0-619)', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      sources: [],
      retrieval: retrievalPayload,
    });

    const result = await executeToolCall({
      name: 'search_product_docs',
      argumentsJson: '{}',
      callId: 'call_no_lock',
    });

    expect(result.trace.retrieval?.productLineResolution).toBeUndefined();
    expect(result.trace.retrieval?.retrievalStrategy).toBe('hybrid+reranked');
  });

  it('omits `retrieval` rather than throwing on a malformed retrieval block', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      sources: [],
      retrieval: { strategy: 'broad_only', search: { model: 'x' } /* missing required fields */ },
    });

    const result = await executeToolCall({
      name: 'search_product_docs',
      argumentsJson: '{}',
      callId: 'call_malformed',
    });

    expect(result.trace.retrieval).toBeUndefined();
  });
});

describe('executeToolCall — web search results on the trace entry (B0-292)', () => {
  it('extracts the web search query/results/telemetry onto the trace entry from the full payload', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      adapter: 'cross_reference_recommendation_v1',
      source: 'web',
      answered: true,
      status: 'answered',
      candidates: [],
      evidence: {
        source: 'web',
        webSearch: { searchesUsed: 2, estimatedCostUsd: 0.024, escalated: true, budgetExceeded: false },
        webSearchResults: {
          query: 'Spartan Xtreme Blue product specifications disinfectant OR cleaner',
          results: [
            {
              url: 'https://spartanchemical.com/xtreme-blue',
              title: 'Xtreme Blue Glass Cleaner',
              snippet: 'A concentrated glass and surface cleaner.',
            },
            {
              url: 'https://spartanchemical.com/sds/xtreme-blue.pdf',
              title: 'Xtreme Blue SDS',
              snippet: null,
            },
          ],
        },
      },
    });

    const result = await executeToolCall({
      name: 'recommend_cross_reference',
      argumentsJson: JSON.stringify({ competitorProduct: 'Xtreme Blue', competitorBrand: 'Spartan' }),
      callId: 'call_websearch',
    });

    expect(result.trace.webSearch).toEqual({
      query: 'Spartan Xtreme Blue product specifications disinfectant OR cleaner',
      results: [
        {
          url: 'https://spartanchemical.com/xtreme-blue',
          title: 'Xtreme Blue Glass Cleaner',
          snippet: 'A concentrated glass and surface cleaner.',
        },
        {
          url: 'https://spartanchemical.com/sds/xtreme-blue.pdf',
          title: 'Xtreme Blue SDS',
          snippet: null,
        },
      ],
      searchesUsed: 2,
      escalated: true,
    });
  });

  it('survives outputPreview truncation — the structured field is built from the full payload, not the preview', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      candidates: Array.from({ length: 30 }, (_, i) => ({
        betcoProductKey: `key-${i}`,
        betcoTitle: `Product ${i}`,
        rationale: 'x'.repeat(200),
      })),
      evidence: {
        webSearch: { searchesUsed: 1, estimatedCostUsd: 0.008, escalated: false, budgetExceeded: false },
        webSearchResults: {
          query: 'Acme Cleaner X product specifications disinfectant OR cleaner',
          results: [{ url: 'https://acme.example/cleaner-x', title: 'Cleaner X', snippet: 'y'.repeat(500) }],
        },
      },
    });

    const result = await executeToolCall({
      name: 'recommend_cross_reference',
      argumentsJson: '{}',
      callId: 'call_websearch_truncated',
    });

    expect(result.trace.outputTruncated).toBe(true);
    expect(result.trace.outputPreview).not.toContain('"webSearchResults"');
    expect(result.trace.webSearch?.results[0]?.url).toBe('https://acme.example/cleaner-x');
  });

  it('omits `webSearch` for a call whose engine served a confident legacy match (no search run)', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      adapter: 'cross_reference_recommendation_v1',
      source: 'legacy',
      answered: true,
      status: 'answered',
      candidates: [],
      evidence: { source: 'legacy', normalizedInput: null, totalCandidates: 1 },
    });

    const result = await executeToolCall({
      name: 'recommend_cross_reference',
      argumentsJson: '{}',
      callId: 'call_no_websearch',
    });

    expect(result.trace.webSearch).toBeUndefined();
  });

  it('omits `webSearch` for a tool that never ran one', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      adapter: 'static_policy_v1',
      policy: { summary: 's', steps: [] },
    });

    const result = await executeToolCall({
      name: 'get_escalation_policy',
      argumentsJson: '{}',
      callId: 'call_no_websearch_2',
    });

    expect(result.trace.webSearch).toBeUndefined();
  });

  it('omits `webSearch` rather than throwing on a malformed block', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      candidates: [],
      evidence: {
        webSearch: { searchesUsed: 1, escalated: false },
        webSearchResults: { query: 'x' /* missing required `results` array */ },
      },
    });

    const result = await executeToolCall({
      name: 'recommend_cross_reference',
      argumentsJson: '{}',
      callId: 'call_websearch_malformed',
    });

    expect(result.trace.webSearch).toBeUndefined();
  });
});
