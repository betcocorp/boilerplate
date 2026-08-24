import { describe, expect, it } from 'vitest';

import type { ProductLineLock, ToolRetrievalParams, ToolTraceEntry } from '~/lib/audit/trace';
import {
  collectRetrievedDocumentChunksFromToolOutputs,
  collectSourceMetaFromToolOutputs,
  collectSourcesFromToolOutputs,
  isUnendorsedSpeculativeToolOutput,
} from '~/lib/workflows/product-support/run-product-support-workflow';

/**
 * B0-635 — the speculative (B0-436) pre-fetch searches the raw user message, so it can match on an
 * incidental word. Live repro: run 5b13095f-9eff-4341-ba3a-473a85fe20c3, "how many quarts of end use
 * product can I get from one cartridge of push?", whose persisted `final_output.sources` led with
 * "Quarterpack Chemical Management Program" (0.417), "Betco Cleaning Solutions Guide" (0.413) and a
 * toilet-bowl-cleaner label titled "quart" — all from the speculative call, whose own
 * `retrieval.productLineResolution` was `skipped_low_confidence` with a null `lockedProductLineKey`.
 *
 * These collectors read only `entry.ok` / `entry.output` / `entry.trace`, so plain stubs exercise
 * them directly without the workflow's DB/OpenAI dependencies.
 */

function retrievalParams(productLineResolution?: ProductLineLock): ToolRetrievalParams {
  return {
    model: 'text-embedding-3-large',
    limit: 40,
    scope: 'betco_us',
    productLineKey: null,
    productKey: null,
    sectionType: null,
    minSimilarity: null,
    retrievalStrategy: 'hybrid_rrf',
    embeddingSource: 'fresh',
    timings: {
      totalMs: 480,
      queryEmbeddingMs: 42,
      queryRewriteMs: 0,
      cacheLookupMs: 3,
      embeddingCreateMs: 39,
      cachePersistMs: 2,
      similaritySearchMs: 260,
      rerankMs: 175,
    },
    selection: {
      limit: 8,
      minSimilarity: 0.2,
      maxPerDocument: 2,
      requiredDocumentKinds: [],
    },
    ...(productLineResolution ? { productLineResolution } : {}),
  };
}

function unlockedResolution(
  lockReason: ProductLineLock['lockReason'] = 'skipped_low_confidence',
): ProductLineLock {
  return {
    candidates: [
      {
        productLineKey: 'quarterpack',
        label: 'Quarterpack Chemical Management Program',
        maxSimilarity: 0.417,
      },
    ],
    lockedProductLineKey: null,
    lockReason,
  };
}

function lockedResolution(): ProductLineLock {
  return {
    candidates: [{ productLineKey: 'push', label: 'Push', maxSimilarity: 0.82 }],
    lockedProductLineKey: 'push',
    lockReason: 'high_confidence',
  };
}

function trace(overrides: Partial<ToolTraceEntry> = {}): ToolTraceEntry {
  return {
    toolName: 'search_product_docs',
    callId: 'call_1',
    argumentsPreview: '{}',
    outputPreview: '{}',
    ok: true,
    ...overrides,
  };
}

type StubSource = {
  documentId: string;
  chunkId?: string | null;
  title?: string;
  snippet?: string;
  documentBody?: string;
  documentKind?: string;
  similarity?: number;
  productLineKey?: string;
};

function toolOutput(input: { trace: ToolTraceEntry; sources: StubSource[]; ok?: boolean }) {
  const ok = input.ok ?? input.trace.ok;
  return {
    toolName: input.trace.toolName,
    ok,
    output: JSON.stringify({ ok: true, sources: input.sources }),
    trace: input.trace,
  };
}

/** The three off-topic documents the repro run actually cited, with their real similarities. */
const SPECULATIVE_JUNK: StubSource[] = [
  {
    documentId: '11111111-1111-4111-8111-111111111111',
    chunkId: 'chunk-quarterpack',
    title: 'Quarterpack Chemical Management Program',
    snippet: 'Quarterpack dispensing program overview.',
    documentBody: 'Quarterpack dispensing program overview, full body.',
    documentKind: 'brochure',
    similarity: 0.417,
  },
  {
    documentId: '22222222-2222-4222-8222-222222222222',
    chunkId: 'chunk-solutions-guide',
    title: 'Betco Cleaning Solutions Guide',
    snippet: 'Solutions guide contents.',
    documentBody: 'Solutions guide contents, full body.',
    documentKind: 'brochure',
    similarity: 0.413,
  },
  {
    documentId: '33333333-3333-4333-8333-333333333333',
    chunkId: 'chunk-sp75',
    title: 'quart',
    snippet: 'SP75 toilet bowl cleaner label.',
    documentBody: 'SP75 toilet bowl cleaner label, full body.',
    documentKind: 'label',
    similarity: 0.401,
  },
];

const PUSH_SOURCE: StubSource = {
  documentId: '44444444-4444-4444-8444-444444444444',
  chunkId: 'chunk-push',
  title: 'Push Label',
  snippet: 'Push cartridge yields 32 quarts of end-use product.',
  documentBody: 'Push cartridge yields 32 quarts of end-use product, full body.',
  documentKind: 'label',
  similarity: 0.78,
  productLineKey: 'push',
};

describe('isUnendorsedSpeculativeToolOutput (B0-635)', () => {
  it('flags a speculative call whose product-line resolution skipped for low confidence', () => {
    expect(
      isUnendorsedSpeculativeToolOutput(
        trace({ speculative: true, retrieval: retrievalParams(unlockedResolution()) }),
      ),
    ).toBe(true);
  });

  it('flags a speculative call whose product-line resolution skipped as ambiguous', () => {
    expect(
      isUnendorsedSpeculativeToolOutput(
        trace({
          speculative: true,
          retrieval: retrievalParams(unlockedResolution('skipped_ambiguous')),
        }),
      ),
    ).toBe(true);
  });

  it('does NOT flag a speculative call that locked onto a product line', () => {
    expect(
      isUnendorsedSpeculativeToolOutput(
        trace({ speculative: true, retrieval: retrievalParams(lockedResolution()) }),
      ),
    ).toBe(false);
  });

  it('does NOT flag other skip reasons — only low-confidence and ambiguous', () => {
    for (const lockReason of [
      'skipped_no_product_line',
      'resolution_disabled',
    ] as const) {
      expect(
        isUnendorsedSpeculativeToolOutput(
          trace({
            speculative: true,
            retrieval: retrievalParams({ ...unlockedResolution(), lockReason }),
          }),
        ),
      ).toBe(false);
    }
  });

  it('does NOT flag a speculative call that carried no product-line resolution at all', () => {
    expect(
      isUnendorsedSpeculativeToolOutput(trace({ speculative: true, retrieval: retrievalParams() })),
    ).toBe(false);
    expect(isUnendorsedSpeculativeToolOutput(trace({ speculative: true }))).toBe(false);
  });

  it('does NOT flag a model-chosen call with the identical unlocked resolution', () => {
    expect(
      isUnendorsedSpeculativeToolOutput(
        trace({ origin: 'model_chosen', retrieval: retrievalParams(unlockedResolution()) }),
      ),
    ).toBe(false);
  });

  it('does NOT flag a model call served from the speculative result (reusedSpeculativeResult)', () => {
    // `createSpeculativeReuseExecutor` clears `speculative` and sets `reusedSpeculativeResult`:
    // the model really did ask for that search, so its hits keep citing.
    expect(
      isUnendorsedSpeculativeToolOutput(
        trace({
          speculative: undefined,
          reusedSpeculativeResult: true,
          retrieval: retrievalParams(unlockedResolution()),
        }),
      ),
    ).toBe(false);
  });
});

describe('collectSourcesFromToolOutputs — speculative citation filter (B0-635)', () => {
  it('drops the repro run’s off-topic sources contributed by the unlocked speculative call', () => {
    const sources = collectSourcesFromToolOutputs([
      toolOutput({
        trace: trace({
          callId: 'speculative-search-run_1',
          speculative: true,
          origin: 'workflow_injected',
          retrieval: retrievalParams(unlockedResolution()),
        }),
        sources: SPECULATIVE_JUNK,
      }),
    ]);

    expect(sources).toEqual([]);
  });

  it('keeps the model’s own hits while dropping the unlocked speculative ones', () => {
    const sources = collectSourcesFromToolOutputs([
      toolOutput({
        trace: trace({
          callId: 'speculative-search-run_1',
          speculative: true,
          retrieval: retrievalParams(unlockedResolution()),
        }),
        sources: SPECULATIVE_JUNK,
      }),
      toolOutput({
        trace: trace({
          callId: 'call_model_1',
          origin: 'model_chosen',
          retrieval: retrievalParams(lockedResolution()),
        }),
        sources: [PUSH_SOURCE],
      }),
    ]);

    expect(sources.map((s) => s.title)).toEqual(['Push Label']);
    expect(sources[0]?.similarity).toBe(0.78);
  });

  it('keeps a LOCKED speculative call’s sources — a strong pre-fetch still cites', () => {
    const sources = collectSourcesFromToolOutputs([
      toolOutput({
        trace: trace({
          callId: 'speculative-search-run_1',
          speculative: true,
          retrieval: retrievalParams(lockedResolution()),
        }),
        sources: [PUSH_SOURCE],
      }),
    ]);

    expect(sources.map((s) => s.documentId)).toEqual([PUSH_SOURCE.documentId]);
  });

  it('keeps a MODEL-CHOSEN ambiguous call’s sources — the model deliberately asked for it', () => {
    for (const lockReason of ['skipped_low_confidence', 'skipped_ambiguous'] as const) {
      const sources = collectSourcesFromToolOutputs([
        toolOutput({
          trace: trace({
            callId: 'call_model_1',
            origin: 'model_chosen',
            retrieval: retrievalParams(unlockedResolution(lockReason)),
          }),
          sources: SPECULATIVE_JUNK,
        }),
      ]);

      expect(sources.map((s) => s.title)).toEqual([
        'Quarterpack Chemical Management Program',
        'Betco Cleaning Solutions Guide',
        'quart',
      ]);
    }
  });

  it('keeps a speculative call’s sources when no product-line resolution was recorded', () => {
    const sources = collectSourcesFromToolOutputs([
      toolOutput({
        trace: trace({ speculative: true, retrieval: retrievalParams() }),
        sources: [PUSH_SOURCE],
      }),
    ]);

    expect(sources).toHaveLength(1);
  });
});

describe('regulated-claim guardrail evidence path is unaffected (B0-635)', () => {
  const toolOutputs = [
    toolOutput({
      trace: trace({
        callId: 'speculative-search-run_1',
        speculative: true,
        retrieval: retrievalParams(unlockedResolution()),
      }),
      sources: SPECULATIVE_JUNK,
    }),
    toolOutput({
      trace: trace({
        callId: 'call_model_1',
        origin: 'model_chosen',
        retrieval: retrievalParams(lockedResolution()),
      }),
      sources: [PUSH_SOURCE],
    }),
  ];

  it('collectSourceMetaFromToolOutputs still returns the COMPLETE evidence set with bodies', () => {
    const meta = collectSourceMetaFromToolOutputs(toolOutputs);

    // All four documents, speculative ones included: the guardrail verifies dilution ratios,
    // contact times and EPA numbers verbatim, so it must never be handed a filtered subset.
    expect(meta.map((m) => m.documentId).sort()).toEqual(
      [...SPECULATIVE_JUNK.map((s) => s.documentId), PUSH_SOURCE.documentId].sort(),
    );
    for (const entry of meta) {
      expect(entry.documentBody).toContain('full body');
    }
  });

  it('collectRetrievedDocumentChunksFromToolOutputs still records every retrieved chunk', () => {
    const chunks = collectRetrievedDocumentChunksFromToolOutputs(toolOutputs);

    expect(chunks.map((c) => c.chunk_id).sort()).toEqual(
      [
        'chunk-push',
        'chunk-quarterpack',
        'chunk-solutions-guide',
        'chunk-sp75',
      ].sort(),
    );
  });
});
