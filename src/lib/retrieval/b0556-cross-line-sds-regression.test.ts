import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RagSearchMatch } from '~/lib/rag/search';

/**
 * B0-556 — "hazards and signal word for SKU 07512-00" was answered with flammable-aerosol hazard
 * language ("Danger", "extremely flammable aerosol", "gas under pressure") cited to SDS document
 * `c12f83fb-…`, which belongs to the **Baseboard Stripper** line — not the Kling / 9% Thickened HCl
 * Toilet Bowl Cleaner line the SKU resolves to.
 *
 * Verified against the live database while diagnosing this: the alias resolves correctly
 * (`alias_norm = '07512-00'`, `verified = true` → `product_line_key = 110F65B0-…`) and the SQL
 * eligibility predicate in `rag.match_corpus_chunks_hybrid` provably excludes `c12f83fb-…` for that
 * line key. So the leak is neither alias resolution nor the line filter — it is the retrieval paths
 * that search the corpus with NO line filter and hand the result straight to the model:
 *
 *  - `broad_only` — nothing resolved, so any SDS present belongs to an arbitrary line;
 *  - `anchored_with_broad_fallback` — a line WAS resolved, but thin anchored evidence lost to the
 *    unfiltered broad pass, so cross-line SDS content reached the model anyway.
 *
 * Fix under test: SDS-kind sources survive those paths only when provably on the resolved product
 * line. Non-SDS content is untouched — cross-line label/profile prose is a relevance problem, not a
 * regulated-data one.
 */

vi.mock('~/lib/rag/search', () => ({ searchProductChunks: vi.fn() }));
vi.mock('~/supabase/clients/service-role', () => ({ getSupabaseServiceRoleClient: vi.fn() }));
vi.mock('~/lib/retrieval/document-assembly', () => ({
  assembleNeighborChunkBodies: vi.fn(),
  chunkWindowKey: (r: { documentId: string; chunkIndex: number }) =>
    `${r.documentId}:${r.chunkIndex}`,
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
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import { ragQueryForProductKnowledgeWithMeta } from '~/lib/retrieval/product-knowledge';

/** Real values from the B0-556 report, so this test fails on the actual reported case. */
const KLING_LINE = '110F65B0-FE92-412A-9A03-654586617F2C';
const BASEBOARD_STRIPPER_LINE = '8DF7CD42-D443-4948-953E-7FB9BE4808ED';
const WRONG_SDS_DOC = 'c12f83fb-5244-4764-abf2-a1c9c1aea8cb';
const CORRECT_SDS_DOC = 'f929de91-7c81-4273-990f-32b76ad53b2a';

const SAFETY_QUERY = '07512-00 safety hazards PPE SDS precautions first aid';

function installSupabaseStub() {
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    schema: () => ({
      from: () => ({
        select: () => ({
          in: () => ({
            // No discontinued entities in these scenarios.
            filter: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
      // No near-duplicate pairs.
      rpc: async () => ({ data: [], error: null }),
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
}

function match(
  overrides: Partial<RagSearchMatch> & { chunk_id: string; document_id: string },
): RagSearchMatch {
  return {
    chunk_key: `key-${overrides.chunk_id}`,
    chunk_index: 0,
    heading: null,
    chunk_text: `text for ${overrides.chunk_id}`,
    section_path: null,
    section_type: 'label',
    token_count: 20,
    document_key: `dockey-${overrides.document_id}`,
    document_title: `Document ${overrides.document_id}`,
    entity_id: `entity-${overrides.document_id}`,
    product_key: null,
    sku: null,
    product_line_key: KLING_LINE,
    source_pk: `pk-${overrides.document_id}`,
    document_kind: 'product_line_profile',
    similarity: 0.5,
    ...overrides,
  } as RagSearchMatch;
}

/** The offending document: an SDS whose entity sits on a completely unrelated product line. */
const wrongLineSds = match({
  chunk_id: 'chunk-wrong-sds',
  document_id: WRONG_SDS_DOC,
  document_kind: 'sds',
  product_line_key: BASEBOARD_STRIPPER_LINE,
  document_title: 'Baseboard Stripper SDS',
  chunk_text: 'Danger. Extremely flammable aerosol. Contains gas under pressure.',
  similarity: 0.92,
});

/** The SDS that should ground the answer. */
const correctLineSds = match({
  chunk_id: 'chunk-correct-sds',
  document_id: CORRECT_SDS_DOC,
  document_kind: 'sds',
  product_line_key: KLING_LINE,
  document_title: '9% Thickened HCl Toilet Bowl Cleaner SDS',
  similarity: 0.61,
});

function searchResult(matches: RagSearchMatch[]) {
  return {
    matches,
    embeddingSource: 'new-embedding' as const,
    timings: { similaritySearchMs: 1 },
  } as unknown as Awaited<ReturnType<typeof searchProductChunks>>;
}

/** Broad pass = no productLineKey; anchored/explicit pass = productLineKey supplied. */
function stubSearches(byPass: { broad: RagSearchMatch[]; anchored?: RagSearchMatch[] }) {
  vi.mocked(searchProductChunks).mockImplementation(async (options) =>
    searchResult(options.productLineKey ? (byPass.anchored ?? []) : byPass.broad),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  installSupabaseStub();
  vi.mocked(assembleNeighborChunkBodies).mockImplementation(
    async (requests: Array<{ documentId: string; chunkIndex: number }>) =>
      new Map(
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
      ),
  );
  vi.mocked(fetchDocumentSourceRefs).mockResolvedValue(new Map());
  vi.mocked(fetchEntityContexts).mockResolvedValue(new Map());
  vi.mocked(fetchProductLineFacts).mockResolvedValue(new Map());
});

describe('B0-556 — cross-product-line SDS must never ground a safety answer', () => {
  it('withholds every SDS when no line could be resolved (broad_only)', async () => {
    /*
     * Two candidate lines inside the ambiguous band — above MIN_LOCK_SIMILARITY (0.5) but below
     * HIGH_CONFIDENCE_ABSOLUTE (0.64), with a spread under MIN_LOCK_MARGIN (0.06) — so resolution
     * returns `skipped_ambiguous` and the strategy really is broad_only. This is the
     * "we cannot tell which product this is" case.
     */
    stubSearches({
      broad: [
        match({
          chunk_id: 'chunk-wrong-sds',
          document_id: WRONG_SDS_DOC,
          document_kind: 'sds',
          product_line_key: BASEBOARD_STRIPPER_LINE,
          document_title: 'Baseboard Stripper SDS',
          chunk_text: 'Danger. Extremely flammable aerosol. Contains gas under pressure.',
          similarity: 0.6,
        }),
        match({
          chunk_id: 'chunk-third-sds',
          document_id: 'doc-third-line-sds',
          document_kind: 'sds',
          product_line_key: 'C0FFEE00-0000-0000-0000-000000000000',
          similarity: 0.58,
        }),
      ],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({ query: SAFETY_QUERY });

    expect(result.retrieval.strategy).toBe('broad_only');
    expect(result.retrieval.productLineResolution?.lockReason).toBe('skipped_ambiguous');
    expect(result.retrieval.productLineResolution?.lockedProductLineKey).toBeNull();
    // The reported defect: this document must not reach the model.
    expect(result.sources.map((s) => s.documentId)).not.toContain(WRONG_SDS_DOC);
    expect(result.sources).toHaveLength(0);
    expect(result.retrieval.withheldUnanchoredSdsCount).toBe(2);
  });

  it('withholds a cross-line SDS that arrives via the broad fallback, keeping the resolved line', async () => {
    // A line resolves off the broad pass, but the anchored pass comes back empty, so the
    // pre-fix code returned the unfiltered broad set — including the Baseboard Stripper SDS.
    stubSearches({
      broad: [
        match({
          chunk_id: 'chunk-kling-profile',
          document_id: 'doc-kling-profile',
          product_line_key: KLING_LINE,
          similarity: 0.95,
        }),
        wrongLineSds,
      ],
      anchored: [],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({ query: SAFETY_QUERY });

    expect(result.retrieval.strategy).toBe('anchored_with_broad_fallback');
    expect(result.retrieval.productLineResolution?.lockedProductLineKey).toBe(KLING_LINE);
    expect(result.sources.map((s) => s.documentId)).not.toContain(WRONG_SDS_DOC);
    expect(result.retrieval.withheldUnanchoredSdsCount).toBe(1);
    // The correctly-anchored non-SDS source is untouched.
    expect(result.sources.map((s) => s.documentId)).toContain('doc-kling-profile');
  });

  it('keeps an SDS that is on the resolved line even when it arrives via the broad fallback', async () => {
    stubSearches({
      broad: [
        match({
          chunk_id: 'chunk-kling-profile',
          document_id: 'doc-kling-profile',
          product_line_key: KLING_LINE,
          similarity: 0.95,
        }),
        correctLineSds,
      ],
      anchored: [],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({ query: SAFETY_QUERY });

    expect(result.retrieval.strategy).toBe('anchored_with_broad_fallback');
    expect(result.sources.map((s) => s.documentId)).toContain(CORRECT_SDS_DOC);
    expect(result.retrieval.withheldUnanchoredSdsCount).toBe(0);
  });

  it('leaves non-SDS cross-line sources alone — this guard is only for regulated safety data', async () => {
    stubSearches({
      broad: [
        match({
          chunk_id: 'chunk-other-label',
          document_id: 'doc-other-label',
          document_kind: 'label',
          product_line_key: BASEBOARD_STRIPPER_LINE,
          similarity: 0.6,
        }),
        // Second line inside the same ambiguous band so nothing locks — keeps this on broad_only.
        match({
          chunk_id: 'chunk-third-label',
          document_id: 'doc-third-label',
          document_kind: 'label',
          product_line_key: 'C0FFEE00-0000-0000-0000-000000000000',
          similarity: 0.58,
        }),
      ],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({ query: SAFETY_QUERY });

    expect(result.retrieval.strategy).toBe('broad_only');
    expect(result.sources.map((s) => s.documentId)).toContain('doc-other-label');
    expect(result.retrieval.withheldUnanchoredSdsCount).toBe(0);
  });

  it('does not touch the explicit-key path, which is already line-filtered in SQL', async () => {
    // A source whose entity line key is null still belongs here: the RPC also matches on
    // `source_record.source_pk`, so withholding it would drop correctly-anchored evidence.
    stubSearches({
      broad: [],
      anchored: [
        match({
          chunk_id: 'chunk-sds-null-line',
          document_id: CORRECT_SDS_DOC,
          document_kind: 'sds',
          product_line_key: null,
          source_pk: KLING_LINE,
          similarity: 0.8,
        }),
      ],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: SAFETY_QUERY,
      productLineKey: KLING_LINE,
    });

    expect(result.retrieval.strategy).toBe('explicit_product_line');
    expect(result.sources.map((s) => s.documentId)).toContain(CORRECT_SDS_DOC);
    expect(result.retrieval.withheldUnanchoredSdsCount).toBe(0);
  });
});
