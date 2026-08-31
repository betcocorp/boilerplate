import { describe, expect, it } from 'vitest';

import {
  SEARCH_RESULT_CLICK_EVENT,
  SEARCH_SUBMIT_EVENT,
  buildSearchResultClickEvent,
  buildSearchSubmitEvent,
} from '~/lib/event-logging/search-events';

describe('buildSearchSubmitEvent', () => {
  it('builds the event with entityType, resultCount, queryLength, and surface', () => {
    const { event, meta } = buildSearchSubmitEvent({
      entityType: 'product',
      resultCount: 12,
      queryLength: 5,
      surface: 'products-rag-list',
    });
    expect(event).toBe(SEARCH_SUBMIT_EVENT);
    expect(meta).toEqual({
      entityType: 'product',
      resultCount: 12,
      queryLength: 5,
      surface: 'products-rag-list',
    });
  });

  it('keeps a zero resultCount (the zero-result metric)', () => {
    const { meta } = buildSearchSubmitEvent({
      entityType: 'document',
      resultCount: 0,
      queryLength: 17,
      surface: 'rag-documents',
    });
    expect(meta.resultCount).toBe(0);
  });

  it('coerces invalid counts to safe integers', () => {
    const { meta } = buildSearchSubmitEvent({
      entityType: 'chunk',
      resultCount: Number.NaN,
      queryLength: 3.9,
      surface: 'rag-chunking',
    });
    expect(meta.resultCount).toBe(0);
    expect(meta.queryLength).toBe(3);
  });

  it('clamps a negative count to zero', () => {
    const { meta } = buildSearchSubmitEvent({
      entityType: 'web',
      resultCount: -5,
      queryLength: -1,
      surface: 'tools-web-search',
    });
    expect(meta.resultCount).toBe(0);
    expect(meta.queryLength).toBe(0);
  });

  it('merges extra context without letting it override the core fields', () => {
    const { meta } = buildSearchSubmitEvent({
      entityType: 'cross_reference',
      resultCount: 4,
      queryLength: 2,
      surface: 'tools-cross-reference',
      extra: { corpusScope: 'betco_us', resultCount: 999 },
    });
    expect(meta.corpusScope).toBe('betco_us');
    expect(meta.resultCount).toBe(4);
  });

  it('never includes raw query text in the built meta (privacy contract)', () => {
    const { meta } = buildSearchSubmitEvent({
      entityType: 'product',
      resultCount: 1,
      queryLength: 'pH7Q dilution ratio'.length,
      surface: 'products-rag-list',
    });
    expect(Object.keys(meta)).not.toContain('query');
    expect(Object.keys(meta)).not.toContain('searchTerm');
    expect(JSON.stringify(meta)).not.toContain('pH7Q');
    expect(meta.queryLength).toBe(19);
  });
});

describe('buildSearchResultClickEvent', () => {
  it('builds the event with a 1-based rank, resultId, and resultCount', () => {
    const { event, meta } = buildSearchResultClickEvent({
      entityType: 'document',
      rank: 3,
      resultId: 'doc-123',
      resultCount: 40,
      surface: 'rag-documents',
    });
    expect(event).toBe(SEARCH_RESULT_CLICK_EVENT);
    expect(meta).toEqual({
      entityType: 'document',
      rank: 3,
      resultId: 'doc-123',
      resultCount: 40,
      surface: 'rag-documents',
    });
  });

  it('clamps rank to a minimum of 1', () => {
    const { meta } = buildSearchResultClickEvent({
      entityType: 'product',
      rank: 0,
      resultId: 'PH7Q',
      resultCount: 10,
      surface: 'products-rag-list',
    });
    expect(meta.rank).toBe(1);
  });

  it('computes absolute rank correctly for paginated lists (call-site contract)', () => {
    // Page 2 (offset 25), first row → absolute rank 26.
    const offset = 25;
    const index = 0;
    const { meta } = buildSearchResultClickEvent({
      entityType: 'chunk',
      rank: offset + index + 1,
      resultId: 'chunk-9',
      resultCount: 60,
      surface: 'rag-chunking',
    });
    expect(meta.rank).toBe(26);
  });

  it('never includes raw query text in the built meta (privacy contract)', () => {
    const { meta } = buildSearchResultClickEvent({
      entityType: 'web',
      rank: 1,
      resultId: 'https://betco.com/example',
      resultCount: 5,
      surface: 'tools-web-search',
    });
    expect(Object.keys(meta)).not.toContain('query');
    expect(Object.keys(meta)).not.toContain('queryText');
  });
});
