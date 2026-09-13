import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-892 — for `knowledge`-kind sources ranking in the top 3, pass the document's FULL `body_text`
 * as `documentBody` when the whole document is small (under the 8k model body cap, B0-973 — was 4k), instead of the narrower
 * B0-547 neighbour window (or leaving a source that never qualified for the B0-874 single-source
 * sibling expansion at its narrow default).
 *
 * Grounded in run `343c1918` ("how soon can people walk on the VCT floor after the last coat?"):
 * the corpus has two correct knowledge documents for this question — "VCT Reopening to Traffic"
 * (3,281 chars) and "vct finish open to traffic timing" (610 chars), both confirmed live via
 * Supabase and both well under the threshold used here.
 */

vi.mock('~/supabase/clients/service-role', () => ({ getSupabaseServiceRoleClient: vi.fn() }));

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import { expandSmallTopKnowledgeSources, type CuratedSource } from '~/lib/retrieval/product-knowledge';
import { MODEL_DOCUMENT_BODY_MAX_CHARS } from '~/lib/tools/model-tool-payload';

let documentRows: Array<{ id: string; body_text: string | null }> = [];

function fakeSupabase() {
  return {
    schema() {
      return {
        from() {
          return {
            select() {
              return {
                in(_column: string, ids: string[]) {
                  return {
                    limit(n: number) {
                      return Promise.resolve({
                        data: documentRows.filter((r) => ids.includes(r.id)).slice(0, n),
                        error: null,
                      });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function source(overrides: Partial<CuratedSource> & { documentId: string }): CuratedSource {
  return {
    chunkId: `chunk-${overrides.documentId}`,
    title: `Title for ${overrides.documentId}`,
    snippet: 'a short snippet',
    documentBody: 'narrow ±1-chunk window text',
    documentBodyChars: 28,
    documentBodyChunkCount: 1,
    documentBodyTruncated: false,
    documentBodyTokenEstimate: 8,
    documentBodyChunkIds: [`chunk-${overrides.documentId}`],
    similarity: 0.6,
    documentKind: 'knowledge',
    entityId: null,
    productLineKey: null,
    productKey: null,
    ...overrides,
  } as CuratedSource;
}

beforeEach(() => {
  documentRows = [];
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(fakeSupabase() as never);
});

describe('expandSmallTopKnowledgeSources (B0-892)', () => {
  it('replaces the narrow window with the FULL body_text for a small knowledge doc ranking top-3', async () => {
    const fullBody =
      'Reopening a Finished VCT Floor to Traffic. Light foot traffic: 30-60 minutes. Normal foot traffic: 2-4 hours. Heavy traffic / rolling loads: 24 hours.';
    documentRows = [{ id: 'doc-vct-reopen', body_text: fullBody }];

    const sources = [
      source({ documentId: 'doc-vct-reopen', similarity: 0.55 }),
      source({ documentId: 'doc-other', documentKind: 'label', similarity: 0.7 }),
    ];

    const result = await expandSmallTopKnowledgeSources(sources);
    const expanded = result.find((s) => s.documentId === 'doc-vct-reopen');

    expect(expanded?.documentBody).toBe(fullBody);
    expect(expanded?.documentBodyChars).toBe(fullBody.length);
    expect(expanded?.documentBodyTruncated).toBe(false);
    // The non-knowledge source is untouched.
    expect(result.find((s) => s.documentId === 'doc-other')?.documentBody).toBe(
      'narrow ±1-chunk window text',
    );
  });

  it('does not widen a knowledge document over the 8,000-char model body cap (B0-973)', async () => {
    const bigBody = 'x'.repeat(MODEL_DOCUMENT_BODY_MAX_CHARS + 1);
    documentRows = [{ id: 'doc-big', body_text: bigBody }];
    const sources = [source({ documentId: 'doc-big' })];

    const result = await expandSmallTopKnowledgeSources(sources);

    expect(result[0]?.documentBody).toBe('narrow ±1-chunk window text');
  });

  it('widens a 6,060-char knowledge document that the former 4,000-char threshold skipped (B0-973, Dilution 084f0b3a)', async () => {
    const midBody = 'd'.repeat(6060);
    documentRows = [{ id: 'doc-mid', body_text: midBody }];
    const sources = [source({ documentId: 'doc-mid' })];

    const result = await expandSmallTopKnowledgeSources(sources);

    expect(result[0]?.documentBody).toBe(midBody);
    expect(result[0]?.documentBodyChars).toBe(6060);
    expect(result[0]?.documentBodyTruncated).toBe(false);
  });

  it('does not widen a source ranking outside the top 3', async () => {
    documentRows = [{ id: 'doc-4th', body_text: 'a short full document body' }];
    const sources = [
      source({ documentId: 'doc-1', similarity: 0.9, documentKind: 'label' }),
      source({ documentId: 'doc-2', similarity: 0.8, documentKind: 'label' }),
      source({ documentId: 'doc-3', similarity: 0.7, documentKind: 'label' }),
      source({ documentId: 'doc-4th', similarity: 0.6 }),
    ];

    const result = await expandSmallTopKnowledgeSources(sources);

    expect(result.find((s) => s.documentId === 'doc-4th')?.documentBody).toBe(
      'narrow ±1-chunk window text',
    );
  });

  it('leaves a non-knowledge source alone even when small and top-ranked', async () => {
    documentRows = [{ id: 'doc-label', body_text: 'a short label body' }];
    const sources = [source({ documentId: 'doc-label', documentKind: 'label', similarity: 0.9 })];

    const result = await expandSmallTopKnowledgeSources(sources);

    expect(result[0]?.documentBody).toBe('narrow ±1-chunk window text');
  });

  it('never shrinks a source whose current documentBody is already fuller (e.g. B0-874 already expanded it)', async () => {
    const alreadyExpanded = 'a'.repeat(3000);
    documentRows = [{ id: 'doc-already', body_text: 'shorter full body' }];
    const sources = [
      source({
        documentId: 'doc-already',
        documentBody: alreadyExpanded,
        documentBodyChars: alreadyExpanded.length,
      }),
    ];

    const result = await expandSmallTopKnowledgeSources(sources);

    expect(result[0]?.documentBody).toBe(alreadyExpanded);
  });

  it('fails open (returns sources unchanged) when the document lookup errors', async () => {
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
      schema() {
        return {
          from() {
            throw new Error('db unavailable');
          },
        };
      },
    } as never);
    const sources = [source({ documentId: 'doc-x' })];

    const result = await expandSmallTopKnowledgeSources(sources);

    expect(result).toEqual(sources);
  });

  it('is a no-op when there are no knowledge-kind sources at all', async () => {
    const sources = [source({ documentId: 'doc-1', documentKind: 'label' })];

    const result = await expandSmallTopKnowledgeSources(sources);

    expect(result).toEqual(sources);
  });
});
