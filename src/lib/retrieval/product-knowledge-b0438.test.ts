import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RagSearchMatch } from '~/lib/rag/search';

/**
 * B0-438 — `runProductKnowledgeQuery` ran a double sequential hybrid search and then a
 * strictly stacked tail (broad curation -> anchored search -> anchored curation -> entity
 * context -> facts). The restructure overlaps everything that is genuinely independent and
 * hydrates only the winning pass.
 *
 * The single non-negotiable constraint is that WHICH sources get selected must not change, so
 * the first suite below re-implements the pre-B0-438 pipeline from the same building blocks
 * (`fetchDiscontinuedEntityIds` -> `suppressNearDuplicateMatches` -> `selectCuratedMatches`,
 * then the fallback comparison) and asserts the new implementation returns the identical
 * source ids in the identical order for every retrieval path.
 */

vi.mock('~/lib/rag/search', () => ({ searchProductChunks: vi.fn() }));
vi.mock('~/supabase/clients/service-role', () => ({ getSupabaseServiceRoleClient: vi.fn() }));
vi.mock('~/lib/retrieval/document-assembly', () => ({
  assembleNeighborChunkBodies: vi.fn(),
  chunkWindowKey: (r: { documentId: string; chunkIndex: number }) => `${r.documentId}:${r.chunkIndex}`,
  fetchDocumentSourceRefs: vi.fn(),
}));
vi.mock('~/lib/rag/entity-context', () => ({
  fetchEntityContexts: vi.fn(),
  buildEntityContextBlock: vi.fn(() => null),
}));
vi.mock('~/lib/retrieval/product-facts', () => ({
  fetchProductLineFacts: vi.fn(),
  buildFactsBlock: vi.fn(() => null),
}));

import { searchProductChunks } from '~/lib/rag/search';
import { fetchEntityContexts } from '~/lib/rag/entity-context';
import {
  assembleNeighborChunkBodies,
  fetchDocumentSourceRefs,
} from '~/lib/retrieval/document-assembly';
import { fetchProductLineFacts } from '~/lib/retrieval/product-facts';
import { suppressNearDuplicateMatches } from '~/lib/retrieval/near-duplicate-suppression';
import { selectCuratedMatches } from '~/lib/retrieval/source-selection';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import {
  fetchDiscontinuedEntityIds,
  ragQueryForProductKnowledgeWithMeta,
} from '~/lib/retrieval/product-knowledge';

/** The B0-259 conflict-reconciliation slot orderings, mirrored so a silent reorder fails here. */
const DEFAULT_REQUIRED_DOCUMENT_KINDS = ['product_line_profile', 'sds', 'knowledge', 'label'];
const LABEL_FIRST_REQUIRED_DOCUMENT_KINDS = ['label', 'sds', 'product_line_profile', 'knowledge'];

const LINE = '333';
const OTHER_LINE = '512';

type PairwiseRow = { chunk_id_a: string; chunk_id_b: string; cosine_similarity: number };

const hooks: {
  discontinuedIds: string[];
  discontinuedError: { message: string } | null;
  pairwiseRows: PairwiseRow[];
  onPairwiseCall: ((chunkIds: string[]) => Promise<void> | void) | null;
} = {
  discontinuedIds: [],
  discontinuedError: null,
  pairwiseRows: [],
  onPairwiseCall: null,
};

function installSupabaseStub() {
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    schema: () => ({
      from: () => ({
        select: () => ({
          in: () => ({
            filter: () =>
              Promise.resolve({
                data: hooks.discontinuedError
                  ? null
                  : hooks.discontinuedIds.map((id) => ({ id })),
                error: hooks.discontinuedError,
              }),
          }),
        }),
      }),
      rpc: async (_fn: string, args: { p_chunk_ids: string[] }) => {
        await hooks.onPairwiseCall?.(args.p_chunk_ids);
        return { data: hooks.pairwiseRows, error: null };
      },
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
}

function match(overrides: Partial<RagSearchMatch> & { chunk_id: string }): RagSearchMatch {
  const id = overrides.chunk_id;
  return {
    chunk_id: id,
    chunk_key: `key-${id}`,
    chunk_index: 0,
    heading: null,
    chunk_text: `text for ${id}`,
    section_path: null,
    section_type: 'label',
    token_count: 20,
    document_id: `doc-${id}`,
    document_key: `dockey-${id}`,
    document_title: `Document ${id}`,
    entity_id: `entity-${id}`,
    product_key: null,
    sku: null,
    product_line_key: LINE,
    source_pk: `pk-${id}`,
    document_kind: 'product_line_profile',
    similarity: 0.5,
    ...overrides,
  };
}

type SearchStub = { matches: RagSearchMatch[]; similaritySearchMs: number };

function searchResult(stub: SearchStub) {
  return {
    matches: stub.matches,
    embeddingSource: 'new-embedding' as const,
    timings: { similaritySearchMs: stub.similaritySearchMs },
  } as unknown as Awaited<ReturnType<typeof searchProductChunks>>;
}

/**
 * Routes the mocked search by what the production code asks for: no product line = the broad
 * pass, a product line = the anchored pass (or the explicit-key pass).
 */
function stubSearches(byPass: { broad: SearchStub; anchored?: SearchStub; line?: SearchStub }) {
  vi.mocked(searchProductChunks).mockImplementation(async (options) => {
    if (!options.productLineKey) return searchResult(byPass.broad);
    if (options.productKey) return searchResult(byPass.anchored ?? byPass.broad);
    return searchResult(byPass.line ?? byPass.anchored ?? byPass.broad);
  });
}

/**
 * Faithful transcription of the pre-B0-438 `curateUniqueDocumentSources` selection stage.
 * Hydration emitted exactly one source per selected match, carrying that match's
 * `document_id` / `chunk_id`, so comparing selected matches to returned sources is a complete
 * parity check on the curated set and its ordering.
 */
async function legacySelect(
  matches: RagSearchMatch[],
  options: { limit: number; requiredDocumentKinds: string[]; maxPerDocument?: number },
): Promise<RagSearchMatch[]> {
  const entityIds = matches.map((m) => m.entity_id).filter((id): id is string => id != null);
  const discontinued = entityIds.length > 0 ? await fetchDiscontinuedEntityIds(entityIds) : new Set<string>();
  const eligible =
    discontinued.size === 0
      ? matches
      : matches.filter((m) => !m.entity_id || !discontinued.has(m.entity_id));
  const deduplicated = await suppressNearDuplicateMatches(eligible);
  return selectCuratedMatches(deduplicated, {
    limit: options.limit,
    maxPerDocument: options.maxPerDocument ?? 1,
    requiredDocumentKinds: options.requiredDocumentKinds,
  });
}

/** Pre-B0-438 broad-vs-anchored resolution, evaluated on fully curated lists. */
async function legacyPipeline(input: {
  broadMatches: RagSearchMatch[];
  anchoredMatches: RagSearchMatch[] | null;
  limit: number;
  requiredDocumentKinds: string[];
}) {
  const broad = await legacySelect(input.broadMatches, {
    limit: input.limit,
    requiredDocumentKinds: input.requiredDocumentKinds,
  });
  if (input.anchoredMatches == null) {
    return { sources: broad, usedBroadFallback: false, strategy: 'broad_only' as const };
  }
  const anchored = await legacySelect(input.anchoredMatches, {
    limit: input.limit,
    requiredDocumentKinds: input.requiredDocumentKinds,
  });
  const minimumAnchoredEvidence = Math.max(2, Math.ceil(input.limit / 2));
  const usedBroadFallback =
    anchored.length === 0 ||
    (anchored.length < minimumAnchoredEvidence && broad.length > anchored.length);
  return {
    sources: usedBroadFallback ? broad : anchored,
    usedBroadFallback,
    strategy: usedBroadFallback
      ? ('anchored_with_broad_fallback' as const)
      : ('anchored_only' as const),
    broadCuratedCount: broad.length,
    anchoredCuratedCount: anchored.length,
  };
}

function identity(sources: { documentId: string; chunkId: string }[]) {
  return sources.map((s) => `${s.documentId}/${s.chunkId}`);
}

function legacyIdentity(matches: RagSearchMatch[]) {
  return matches.map((m) => `${m.document_id}/${m.chunk_id}`);
}

/** Locks onto LINE via the high-confidence absolute threshold (0.64). */
const LOCKING_BROAD_MATCHES = [
  match({ chunk_id: 'b1', similarity: 0.71, document_kind: 'product_line_profile' }),
  match({ chunk_id: 'b2', similarity: 0.66, document_kind: 'sds', section_type: 'hazard' }),
  match({ chunk_id: 'b3', similarity: 0.62, document_kind: 'label' }),
  match({ chunk_id: 'b4', similarity: 0.41, document_kind: 'knowledge', product_line_key: OTHER_LINE }),
];

beforeEach(() => {
  vi.clearAllMocks();
  hooks.discontinuedIds = [];
  hooks.discontinuedError = null;
  hooks.pairwiseRows = [];
  hooks.onPairwiseCall = null;
  installSupabaseStub();
  vi.mocked(assembleNeighborChunkBodies).mockImplementation(
    async (requests: Array<{ documentId: string; chunkIndex: number }>) => {
      return new Map(
        requests.map((r) => [
          `${r.documentId}:${r.chunkIndex}`,
          {
            body: `assembled body for ${r.documentId}`,
            chunkCount: 1,
            truncated: false,
            estimatedTokens: 12,
            chunkIds: [`chunk-of-${r.documentId}`],
          },
        ]),
      );
    },
  );
  vi.mocked(fetchDocumentSourceRefs).mockResolvedValue(new Map());
  vi.mocked(fetchEntityContexts).mockResolvedValue(new Map());
  vi.mocked(fetchProductLineFacts).mockResolvedValue(new Map());
});

describe('B0-438 selection parity — the curated source set and order are unchanged', () => {
  it('anchored pass wins (anchored_only): same sources as the legacy pipeline', async () => {
    const anchoredMatches = [
      match({ chunk_id: 'a1', similarity: 0.9, document_kind: 'label' }),
      match({ chunk_id: 'a2', similarity: 0.8, document_kind: 'sds', section_type: 'hazard' }),
      match({ chunk_id: 'a3', similarity: 0.7, document_kind: 'product_line_profile' }),
    ];
    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 1000 },
      anchored: { matches: anchoredMatches, similaritySearchMs: 2000 },
    });

    const result = await ragQueryForProductKnowledgeWithMeta({ query: 'triforce contact time' });
    const expected = await legacyPipeline({
      broadMatches: LOCKING_BROAD_MATCHES,
      anchoredMatches,
      limit: 3,
      requiredDocumentKinds: LABEL_FIRST_REQUIRED_DOCUMENT_KINDS,
    });

    expect(expected.strategy).toBe('anchored_only');
    expect(identity(result.sources)).toEqual(legacyIdentity(expected.sources));
    expect(result.retrieval.strategy).toBe(expected.strategy);
    expect(result.retrieval.usedBroadFallback).toBe(false);
    expect(result.retrieval.broadCuratedCount).toBe(expected.broadCuratedCount);
    expect(result.retrieval.anchoredCuratedCount).toBe(expected.anchoredCuratedCount);
  });

  it('anchored pass below the evidence minimum falls back to broad: same sources and order', async () => {
    const anchoredMatches = [match({ chunk_id: 'a1', similarity: 0.9, document_kind: 'label' })];
    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 10 },
      anchored: { matches: anchoredMatches, similaritySearchMs: 20 },
    });

    const result = await ragQueryForProductKnowledgeWithMeta({ query: 'triforce contact time' });
    const expected = await legacyPipeline({
      broadMatches: LOCKING_BROAD_MATCHES,
      anchoredMatches,
      limit: 3,
      requiredDocumentKinds: LABEL_FIRST_REQUIRED_DOCUMENT_KINDS,
    });

    expect(expected.strategy).toBe('anchored_with_broad_fallback');
    expect(identity(result.sources)).toEqual(legacyIdentity(expected.sources));
    expect(result.retrieval.usedBroadFallback).toBe(true);
    expect(result.retrieval.strategy).toBe('anchored_with_broad_fallback');
    expect(result.retrieval.broadCuratedCount).toBe(expected.broadCuratedCount);
    expect(result.retrieval.anchoredCuratedCount).toBe(1);
  });

  it('empty anchored pass falls back to broad', async () => {
    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 10 },
      anchored: { matches: [], similaritySearchMs: 20 },
    });

    const result = await ragQueryForProductKnowledgeWithMeta({ query: 'triforce contact time' });
    const expected = await legacyPipeline({
      broadMatches: LOCKING_BROAD_MATCHES,
      anchoredMatches: [],
      limit: 3,
      requiredDocumentKinds: LABEL_FIRST_REQUIRED_DOCUMENT_KINDS,
    });

    expect(identity(result.sources)).toEqual(legacyIdentity(expected.sources));
    expect(result.retrieval.usedBroadFallback).toBe(true);
    expect(result.retrieval.anchoredCuratedCount).toBe(0);
  });

  it('broad_only (no product line locked): same sources as the legacy pipeline', async () => {
    const lowConfidence = [
      match({ chunk_id: 'n1', similarity: 0.45, document_kind: 'product_line_profile' }),
      match({ chunk_id: 'n2', similarity: 0.44, document_kind: 'sds', section_type: 'hazard' }),
      match({ chunk_id: 'n3', similarity: 0.43, document_kind: 'label' }),
    ];
    stubSearches({ broad: { matches: lowConfidence, similaritySearchMs: 30 } });

    const result = await ragQueryForProductKnowledgeWithMeta({ query: 'general floor care advice' });
    const expected = await legacyPipeline({
      broadMatches: lowConfidence,
      anchoredMatches: null,
      limit: 3,
      requiredDocumentKinds: DEFAULT_REQUIRED_DOCUMENT_KINDS,
    });

    expect(result.retrieval.strategy).toBe('broad_only');
    expect(identity(result.sources)).toEqual(legacyIdentity(expected.sources));
    expect(result.retrieval.anchoredSearchMs).toBeNull();
    expect(vi.mocked(searchProductChunks)).toHaveBeenCalledTimes(1);
  });

  it('explicit product line path: same sources, and usedProductKeyFallback is preserved', async () => {
    const lineMatches = [
      match({ chunk_id: 'l1', similarity: 0.8, document_kind: 'label' }),
      match({ chunk_id: 'l2', similarity: 0.7, document_kind: 'sds', section_type: 'hazard' }),
    ];
    // First (product-key scoped) search returns nothing -> B0-250 line-level retry.
    vi.mocked(searchProductChunks).mockImplementation(async (options) =>
      options.productKey
        ? searchResult({ matches: [], similaritySearchMs: 5 })
        : searchResult({ matches: lineMatches, similaritySearchMs: 15 }),
    );

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'triforce contact time',
      productLineKey: LINE,
      productKey: 'SKU-1',
    });
    const expected = await legacySelect(lineMatches, {
      limit: 3,
      requiredDocumentKinds: LABEL_FIRST_REQUIRED_DOCUMENT_KINDS,
    });

    expect(identity(result.sources)).toEqual(legacyIdentity(expected));
    expect(result.retrieval.strategy).toBe('explicit_product_line');
    expect(result.retrieval.usedProductKeyFallback).toBe(true);
    expect(result.retrieval.productLineResolution?.lockReason).toBe('explicit_filter');
  });

  it('skipProductLineResolution path: same sources and strategy', async () => {
    const matches = [
      match({ chunk_id: 's1', similarity: 0.8, document_kind: 'product_line_profile' }),
      match({ chunk_id: 's2', similarity: 0.6, document_kind: 'product_line_profile' }),
    ];
    stubSearches({ broad: { matches, similaritySearchMs: 25 } });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'how do I use this on vinyl',
      skipProductLineResolution: true,
    });
    const expected = await legacySelect(matches, {
      limit: 3,
      requiredDocumentKinds: DEFAULT_REQUIRED_DOCUMENT_KINDS,
    });

    expect(result.retrieval.strategy).toBe('broad_resolution_disabled');
    expect(identity(result.sources)).toEqual(legacyIdentity(expected));
    expect(result.retrieval.anchoredSearchMs).toBeNull();
    expect(result.retrieval.productLineResolution?.lockReason).toBe('resolution_disabled');
  });

  it('keeps the B0-257 discontinued filter and near-duplicate suppression on both passes', async () => {
    // entity-a2 is discontinued; a4/a5 are a near-duplicate pair in the same
    // (product_key, section_type) group, so the lower-authority profile chunk is suppressed.
    hooks.discontinuedIds = ['entity-a2'];
    hooks.pairwiseRows = [{ chunk_id_a: 'a4', chunk_id_b: 'a5', cosine_similarity: 0.97 }];
    const anchoredMatches = [
      match({ chunk_id: 'a1', similarity: 0.9, document_kind: 'label' }),
      match({ chunk_id: 'a2', similarity: 0.89, document_kind: 'sds', section_type: 'hazard' }),
      match({
        chunk_id: 'a4',
        similarity: 0.88,
        document_kind: 'product_line_profile',
        product_key: 'P1',
        section_type: 'hazard',
      }),
      match({
        chunk_id: 'a5',
        similarity: 0.5,
        document_kind: 'sds',
        product_key: 'P1',
        section_type: 'hazard',
      }),
      match({ chunk_id: 'a6', similarity: 0.4, document_kind: 'knowledge' }),
    ];
    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 10 },
      anchored: { matches: anchoredMatches, similaritySearchMs: 20 },
    });

    const result = await ragQueryForProductKnowledgeWithMeta({ query: 'triforce hazard statements' });
    const expected = await legacyPipeline({
      broadMatches: LOCKING_BROAD_MATCHES,
      anchoredMatches,
      limit: 3,
      requiredDocumentKinds: LABEL_FIRST_REQUIRED_DOCUMENT_KINDS,
    });

    expect(identity(result.sources)).toEqual(legacyIdentity(expected.sources));
    // The discontinued SDS chunk and the suppressed near-duplicate never reach the model.
    expect(identity(result.sources)).not.toContain('doc-a2/a2');
    expect(identity(result.sources)).not.toContain('doc-a4/a4');
  });
});

describe('B0-438 — B0-259 document-kind precedence is untouched', () => {
  const mixedKinds = [
    match({ chunk_id: 'k1', similarity: 0.9, document_kind: 'knowledge' }),
    match({ chunk_id: 'k2', similarity: 0.88, document_kind: 'product_line_profile' }),
    match({ chunk_id: 'k3', similarity: 0.3, document_kind: 'label' }),
    match({ chunk_id: 'k4', similarity: 0.25, document_kind: 'sds', section_type: 'hazard' }),
  ];

  it('a claim-like query gives the label the first guaranteed slot even at low similarity', async () => {
    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 10 },
      anchored: { matches: mixedKinds, similaritySearchMs: 20 },
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'what is the dilution ratio in oz/gal',
    });

    expect(result.sources[0]?.documentKind).toBe('label');
    expect(identity(result.sources)).toEqual(
      legacyIdentity(
        await legacySelect(mixedKinds, {
          limit: 3,
          requiredDocumentKinds: LABEL_FIRST_REQUIRED_DOCUMENT_KINDS,
        }),
      ),
    );
  });

  it('a descriptive query keeps the default profile-first ordering', async () => {
    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 10 },
      anchored: { matches: mixedKinds, similaritySearchMs: 20 },
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'tell me about this product family',
    });

    expect(result.sources[0]?.documentKind).toBe('product_line_profile');
    expect(identity(result.sources)).toEqual(
      legacyIdentity(
        await legacySelect(mixedKinds, {
          limit: 3,
          requiredDocumentKinds: DEFAULT_REQUIRED_DOCUMENT_KINDS,
        }),
      ),
    );
  });

  /**
   * B0-443: `CLAIM_LIKE_QUERY_PATTERN` used to end in a single `\b` applied to the whole
   * alternation, so bare stems only matched when followed by a non-word character. "dilution" /
   * "dilute" (`dilut`), "hazards" (`hazard`), "epa registered" (`epa\s*reg`), and "oz per gallon"
   * therefore did NOT register as claim-like, and those queries missed the B0-259 label-first
   * slot ordering -- exactly the regulated-data phrasing the policy exists for. Fixed by giving
   * each alternative its own boundaries. This test is inverted from the old pinned-gap version:
   * it now asserts the label DOES win the first slot for a plain "dilution ratio" query.
   */
  it('B0-443 fix: "dilution ratio" now triggers label-first ordering', async () => {
    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 10 },
      anchored: { matches: mixedKinds, similaritySearchMs: 20 },
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'what is the dilution ratio for this product',
    });

    expect(result.sources[0]?.documentKind).toBe('label');
    expect(identity(result.sources)).toEqual(
      legacyIdentity(
        await legacySelect(mixedKinds, {
          limit: 3,
          requiredDocumentKinds: LABEL_FIRST_REQUIRED_DOCUMENT_KINDS,
        }),
      ),
    );
  });
});

describe('B0-438 — only the winning pass is hydrated', () => {
  it('assembles chunk-window bodies once, for the anchored winner', async () => {
    const anchoredMatches = [
      match({ chunk_id: 'a1', similarity: 0.9, document_kind: 'label' }),
      match({ chunk_id: 'a2', similarity: 0.8, document_kind: 'sds', section_type: 'hazard' }),
      match({ chunk_id: 'a3', similarity: 0.7, document_kind: 'product_line_profile' }),
    ];
    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 10 },
      anchored: { matches: anchoredMatches, similaritySearchMs: 20 },
    });

    await ragQueryForProductKnowledgeWithMeta({ query: 'triforce contact time' });

    expect(vi.mocked(assembleNeighborChunkBodies)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchDocumentSourceRefs)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(assembleNeighborChunkBodies).mock.calls[0]?.[0]).toEqual([
      { documentId: 'doc-a1', chunkIndex: 0 },
      { documentId: 'doc-a2', chunkIndex: 0 },
      { documentId: 'doc-a3', chunkIndex: 0 },
    ]);
  });

  it('assembles chunk-window bodies once, for the broad winner', async () => {
    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 10 },
      anchored: { matches: [], similaritySearchMs: 20 },
    });

    await ragQueryForProductKnowledgeWithMeta({ query: 'triforce contact time' });

    expect(vi.mocked(assembleNeighborChunkBodies)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(assembleNeighborChunkBodies).mock.calls[0]?.[0]).toEqual([
      { documentId: 'doc-b3', chunkIndex: 0 },
      { documentId: 'doc-b2', chunkIndex: 0 },
      { documentId: 'doc-b1', chunkIndex: 0 },
    ]);
  });
});

describe('B0-438 — independent work now overlaps', () => {
  it('issues the anchored search while broad candidate selection is still in flight', async () => {
    let releaseBroadSelection: (() => void) | null = null;
    const broadSelectionHeld = new Promise<void>((resolve) => {
      releaseBroadSelection = resolve;
    });
    let pairwiseCalls = 0;
    hooks.pairwiseRows = [];
    hooks.onPairwiseCall = async () => {
      pairwiseCalls += 1;
      if (pairwiseCalls === 1) await broadSelectionHeld;
    };

    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 10 },
      anchored: {
        matches: [match({ chunk_id: 'a1', similarity: 0.9, document_kind: 'label' })],
        similaritySearchMs: 20,
      },
    });

    const pending = ragQueryForProductKnowledgeWithMeta({ query: 'triforce contact time' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Pre-B0-438 the anchored search could not have been issued yet: broad curation had to
    // finish first, and it is still blocked on the near-duplicate similarity RPC.
    const anchoredCall = vi
      .mocked(searchProductChunks)
      .mock.calls.find(([options]) => options.productLineKey === LINE);
    expect(pairwiseCalls).toBe(1);
    expect(anchoredCall).toBeDefined();

    releaseBroadSelection?.();
    await expect(pending).resolves.toBeDefined();
  });

  it('runs entity-context and product-facts enrichment concurrently', async () => {
    let factsStarted: (() => void) | null = null;
    const factsWasCalled = new Promise<void>((resolve) => {
      factsStarted = resolve;
    });
    vi.mocked(fetchProductLineFacts).mockImplementation(async () => {
      factsStarted?.();
      return new Map();
    });
    vi.mocked(fetchEntityContexts).mockImplementation(async () => {
      // Deadlocks unless facts retrieval has already been started alongside this call.
      await factsWasCalled;
      return new Map();
    });

    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 10 },
      anchored: {
        matches: [
          match({ chunk_id: 'a1', similarity: 0.9, document_kind: 'label' }),
          match({ chunk_id: 'a2', similarity: 0.8, document_kind: 'sds', section_type: 'hazard' }),
        ],
        similaritySearchMs: 20,
      },
    });

    const result = await Promise.race([
      ragQueryForProductKnowledgeWithMeta({ query: 'triforce contact time' }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('entity context and facts did not run concurrently')),
          1_000,
        ),
      ),
    ]);

    expect(result).toBeDefined();
    expect(vi.mocked(fetchEntityContexts)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchProductLineFacts)).toHaveBeenCalledTimes(1);
  });
});

describe('B0-438 — retrieval timing semantics', () => {
  /**
   * `searchMs` keeps its pre-B0-438 sum semantics on purpose: it feeds
   * `timingBreakdown.searchMs`, which the golden-set harness and /admin/observability aggregate,
   * and which B0-434 / B0-435 state their acceptance criteria against. The wall-clock number
   * lives alongside it as `retrievalPhaseMs` instead of replacing it.
   */
  it('searchMs stays the sum of the similarity searches, so the epic can measure itself', async () => {
    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 1_000 },
      anchored: {
        matches: [
          match({ chunk_id: 'a1', similarity: 0.9, document_kind: 'label' }),
          match({ chunk_id: 'a2', similarity: 0.8, document_kind: 'sds', section_type: 'hazard' }),
        ],
        similaritySearchMs: 2_000,
      },
    });

    const { retrieval } = await ragQueryForProductKnowledgeWithMeta({
      query: 'triforce contact time',
    });

    expect(retrieval.initialSearchMs).toBe(1_000);
    expect(retrieval.anchoredSearchMs).toBe(2_000);
    expect(retrieval.searchMs).toBe(3_000);
  });

  it('retrievalPhaseMs is wall clock for the whole phase, independent of the stubbed search times', async () => {
    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 1_000 },
      anchored: {
        matches: [
          match({ chunk_id: 'a1', similarity: 0.9, document_kind: 'label' }),
          match({ chunk_id: 'a2', similarity: 0.8, document_kind: 'sds', section_type: 'hazard' }),
        ],
        similaritySearchMs: 2_000,
      },
    });

    const { retrieval } = await ragQueryForProductKnowledgeWithMeta({
      query: 'triforce contact time',
    });

    // The stubs resolve immediately, so real elapsed time is tiny and cannot be the 3,000ms sum.
    expect(retrieval.retrievalPhaseMs).toBeGreaterThanOrEqual(0);
    expect(retrieval.retrievalPhaseMs).toBeLessThan(3_000);
  });

  it('anchoredSearchMs stays null when no anchored search ran', async () => {
    stubSearches({
      broad: {
        matches: [match({ chunk_id: 'n1', similarity: 0.45 })],
        similaritySearchMs: 40,
      },
    });

    const { retrieval } = await ragQueryForProductKnowledgeWithMeta({ query: 'floor care basics' });

    expect(retrieval.anchoredSearchMs).toBeNull();
    expect(retrieval.initialSearchMs).toBe(40);
    expect(retrieval.searchMs).toBe(40);
    expect(typeof retrieval.retrievalPhaseMs).toBe('number');
  });
});

describe('B0-438 — degrade-rather-than-block posture is preserved', () => {
  it('still returns sources when the discontinued-status lookup fails', async () => {
    hooks.discontinuedError = { message: 'status lookup exploded' };
    stubSearches({
      broad: { matches: LOCKING_BROAD_MATCHES, similaritySearchMs: 10 },
      anchored: {
        matches: [
          match({ chunk_id: 'a1', similarity: 0.9, document_kind: 'label' }),
          match({ chunk_id: 'a2', similarity: 0.8, document_kind: 'sds', section_type: 'hazard' }),
        ],
        similaritySearchMs: 20,
      },
    });

    const result = await ragQueryForProductKnowledgeWithMeta({ query: 'triforce contact time' });

    expect(result.sources.length).toBeGreaterThan(0);
  });
});

/**
 * B0-438 asked whether the anchored pass can be skipped when it is "guaranteed to be
 * discarded". It cannot, and this encodes why so the finding is not silently re-litigated.
 *
 * With A = anchoredCount, B = broadCount, M = max(2, ceil(limit/2)):
 *   discard(A, B) = A === 0 || (A < M && B > A)
 * A is unknown until the anchored search has run and been curated. For a skip to be safe,
 * discard(A, B) would have to hold for EVERY reachable A given the known B — but A = min(M, limit)
 * always falsifies it (A >= M), and in the only case where M > limit (limit = 1) the surviving
 * requirement B > A cannot hold because B <= limit = 1. So for every limit and every already-known
 * broad count there is a reachable anchored count that wins, and skipping would change which
 * sources ground the answer.
 */
describe('B0-438 — anchored-skip condition (documented negative result)', () => {
  it('has no (limit, broadCount) pair for which the anchored result is always discarded', () => {
    for (let limit = 1; limit <= 20; limit += 1) {
      const minimumAnchoredEvidence = Math.max(2, Math.ceil(limit / 2));
      const discard = (anchored: number, broad: number) =>
        anchored === 0 || (anchored < minimumAnchoredEvidence && broad > anchored);

      for (let broad = 0; broad <= limit; broad += 1) {
        const anchoredCountsThatWin: number[] = [];
        for (let anchored = 0; anchored <= limit; anchored += 1) {
          if (!discard(anchored, broad)) anchoredCountsThatWin.push(anchored);
        }
        expect(anchoredCountsThatWin.length).toBeGreaterThan(0);
      }
    }
  });
});
