import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isRerankerConfigured } from '~/lib/rag/rerank';
import { resolveRerankPlan } from '~/lib/rag/search';

/**
 * B0-440 — `PRODUCT_SUPPORT_RERANK_ENABLED` defaults true while `rerankChunks` bails out
 * immediately without `COHERE_API_KEY`, so every product-support search paid for a 5x
 * candidate over-fetch (50 chunk rows instead of 20) and was labelled `hybrid+reranked`
 * for a rerank that never ran. These tests pin the resolved gating in both env states.
 */

const originalKey = process.env.COHERE_API_KEY;

beforeEach(() => {
  delete process.env.COHERE_API_KEY;
});

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.COHERE_API_KEY;
  } else {
    process.env.COHERE_API_KEY = originalKey;
  }
});

describe('isRerankerConfigured', () => {
  it('is false when COHERE_API_KEY is absent', () => {
    expect(isRerankerConfigured()).toBe(false);
  });

  it('is false when COHERE_API_KEY is present but empty', () => {
    process.env.COHERE_API_KEY = '';
    expect(isRerankerConfigured()).toBe(false);
  });

  it('is true when COHERE_API_KEY is set', () => {
    process.env.COHERE_API_KEY = 'test-cohere-key';
    expect(isRerankerConfigured()).toBe(true);
  });

  it('is read at call time, not cached at module load', () => {
    expect(isRerankerConfigured()).toBe(false);
    process.env.COHERE_API_KEY = 'test-cohere-key';
    expect(isRerankerConfigured()).toBe(true);
    delete process.env.COHERE_API_KEY;
    expect(isRerankerConfigured()).toBe(false);
  });
});

describe('resolveRerankPlan — COHERE_API_KEY unset (this environment today)', () => {
  it('does not over-fetch and does not activate the rerank phase even when requested', () => {
    expect(
      resolveRerankPlan({ requestedReranker: true, limit: 20, documentKindFilter: null }),
    ).toEqual({ rerankerActive: false, rpcLimit: 20 });
  });

  it('matches the useReranker:false plan exactly', () => {
    const requested = resolveRerankPlan({
      requestedReranker: true,
      limit: 20,
      documentKindFilter: null,
    });
    const notRequested = resolveRerankPlan({
      requestedReranker: false,
      limit: 20,
      documentKindFilter: null,
    });
    expect(requested).toEqual(notRequested);
  });

  it('leaves the document_kind over-fetch untouched (it is not a reranking over-fetch)', () => {
    expect(
      resolveRerankPlan({ requestedReranker: true, limit: 20, documentKindFilter: 'label' }),
    ).toEqual({ rerankerActive: false, rpcLimit: 200 });
    expect(
      resolveRerankPlan({ requestedReranker: false, limit: 8, documentKindFilter: 'knowledge' }),
    ).toEqual({ rerankerActive: false, rpcLimit: 100 });
  });
});

describe('resolveRerankPlan — COHERE_API_KEY set (B0-280 intent)', () => {
  beforeEach(() => {
    process.env.COHERE_API_KEY = 'test-cohere-key';
  });

  it('over-fetches 5x (capped at 50) and activates the rerank phase', () => {
    expect(
      resolveRerankPlan({ requestedReranker: true, limit: 20, documentKindFilter: null }),
    ).toEqual({ rerankerActive: true, rpcLimit: 50 });
    expect(
      resolveRerankPlan({ requestedReranker: true, limit: 8, documentKindFilter: null }),
    ).toEqual({ rerankerActive: true, rpcLimit: 40 });
  });

  it('still respects an explicit useReranker:false request', () => {
    expect(
      resolveRerankPlan({ requestedReranker: false, limit: 20, documentKindFilter: null }),
    ).toEqual({ rerankerActive: false, rpcLimit: 20 });
  });

  it('keeps the document_kind over-fetch in precedence but still reranks', () => {
    expect(
      resolveRerankPlan({ requestedReranker: true, limit: 20, documentKindFilter: 'label' }),
    ).toEqual({ rerankerActive: true, rpcLimit: 200 });
  });
});
