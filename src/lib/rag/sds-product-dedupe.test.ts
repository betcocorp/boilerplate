import { describe, expect, it } from 'vitest';

import {
  dedupeSdsMatchesByProduct,
  normalizeSdsTitleToProductCode,
  sdsProductDedupeKey,
  type RagSearchMatch,
} from '~/lib/rag/search';

/**
 * B0-16 — "Rag search is still returning duplicate documents".
 *
 * The captured symptom: asking "what cleaner works the best on glass" returned three Sources that
 * were all Betco product code 092 (Clear Image Glass & Surface Cleaner) as three separate SDS
 * documents titled `092CAN`, `092` and `092 CAN`. The old dedupe key mixed `chunk_text` into the
 * key, and the US and Canadian SDS bodies genuinely differ, so nothing collided.
 *
 * The values below are the live corpus shape, verified against the `rag` schema:
 *  - all three documents hang off `rag.document.entity_id` = bbff0541-ed47-4748-a5e5-19c51b00ddcf
 *  - that entity is `entity_type: 'product_line'` with
 *    `product_line_key` = C8E8DCF5-8692-4764-A1FC-0B25BE1B2B56 ("Non-Ammoniated Glass Cleaner and
 *    Surface Cleaner", legacy prod_line_id 092) and a NULL `product_key`/`sku`
 *  - `match_corpus_chunks*` left-joins that entity, so `product_line_key` reaches the app layer
 *
 * Similarity values here are the percentages from the bug report expressed as the raw floats the
 * RPC returns.
 */

const GLASS_CLEANER_LINE_KEY = 'C8E8DCF5-8692-4764-A1FC-0B25BE1B2B56';
const GLASS_CLEANER_ENTITY_ID = 'bbff0541-ed47-4748-a5e5-19c51b00ddcf';

function sdsMatch(overrides: Partial<RagSearchMatch> & { chunk_id: string }): RagSearchMatch {
  return {
    chunk_key: `chunk-key-${overrides.chunk_id}`,
    chunk_index: 0,
    heading: null,
    chunk_text: 'Section 1. Identification',
    section_path: null,
    section_type: null,
    token_count: null,
    document_id: `doc-${overrides.chunk_id}`,
    document_key: `sds:${overrides.chunk_id}`,
    document_title: '092',
    entity_id: GLASS_CLEANER_ENTITY_ID,
    product_key: null,
    sku: null,
    product_line_key: GLASS_CLEANER_LINE_KEY,
    source_pk: `source-${overrides.chunk_id}`,
    document_kind: 'sds',
    similarity: 0.4,
    ...overrides,
  };
}

/** The three rows from the bug report, in the order the search returned them. */
const the092Family: RagSearchMatch[] = [
  sdsMatch({
    chunk_id: '4306e5ac-6642-4449-b37f-ac994eddebb8',
    document_id: '15198577-da4b-48d8-add5-019e21e65fbd',
    document_title: '092CAN',
    // Canadian sheets differ in body text — this is exactly why the old chunk_text-based key missed.
    chunk_text: 'SECTION 2: Hazard identification. GHS product identifier ...',
    similarity: 0.48,
  }),
  sdsMatch({
    chunk_id: '985ee955-2f98-4c8d-aefb-7b20a865ba9c',
    document_id: '47c914a1-7382-4e26-b480-fa38eaeabe76',
    document_title: '092',
    chunk_text: 'SECTION 2: Hazards identification. Product identifier ...',
    similarity: 0.47,
  }),
  sdsMatch({
    chunk_id: '1661a4d3-8155-4aa4-9cd4-b94a425ec1dd',
    document_id: '59e1fc19-3d5d-4c3e-8035-7a67f1905fea',
    document_title: '092 CAN',
    chunk_text: 'SECTION 2: Hazard identification. GHS product identifier ...',
    similarity: 0.47,
  }),
];

describe('normalizeSdsTitleToProductCode (B0-16)', () => {
  it('collapses the whitespace/region-suffix family of one product code', () => {
    expect(normalizeSdsTitleToProductCode('092')).toBe('092');
    expect(normalizeSdsTitleToProductCode('092 CAN')).toBe('092');
    expect(normalizeSdsTitleToProductCode('092CAN')).toBe('092');
    expect(normalizeSdsTitleToProductCode('092_CAN')).toBe('092');
    expect(normalizeSdsTitleToProductCode('  092  can ')).toBe('092');
  });

  it('drops the S3 re-upload marker, alone or in front of a region suffix', () => {
    expect(normalizeSdsTitleToProductCode('092 (2)')).toBe('092');
    expect(normalizeSdsTitleToProductCode('092CAN (2)')).toBe('092');
  });

  it('does NOT strip a suffix that would leave a non-numeric tail', () => {
    // `0925` is a different product, not "092 + a suffix".
    expect(normalizeSdsTitleToProductCode('0925')).toBe('0925');
    expect(normalizeSdsTitleToProductCode('0925')).not.toBe(
      normalizeSdsTitleToProductCode('092'),
    );
  });

  it('leaves non-region qualifiers (concentrate/diluted/private label) intact', () => {
    expect(normalizeSdsTitleToProductCode('192 DIL')).toBe('192 DIL');
    expect(normalizeSdsTitleToProductCode('139 BRI')).toBe('139 BRI');
    expect(normalizeSdsTitleToProductCode('192 DIL')).not.toBe(
      normalizeSdsTitleToProductCode('192'),
    );
  });

  it('leaves a descriptive (non product-code) SDS title alone', () => {
    expect(normalizeSdsTitleToProductCode('F092189 Guest Room Cleaning')).toBe(
      'F092189 GUEST ROOM CLEANING',
    );
  });
});

describe('sdsProductDedupeKey (B0-16)', () => {
  it('keys on the product_line_key the RPC returns, not the document title alone', () => {
    const [canA, us, canB] = the092Family;
    expect(sdsProductDedupeKey(canA)).toBe(`${GLASS_CLEANER_LINE_KEY}|092`);
    expect(sdsProductDedupeKey(us)).toBe(sdsProductDedupeKey(canA));
    expect(sdsProductDedupeKey(canB)).toBe(sdsProductDedupeKey(canA));
  });

  it('falls back to the title-derived code when the document has no entity link', () => {
    // 1,110 of 3,159 SDS documents in the live corpus have a NULL entity_id.
    const orphan = sdsMatch({
      chunk_id: 'orphan',
      document_title: '092FR',
      entity_id: null,
      product_line_key: null,
    });
    expect(sdsProductDedupeKey(orphan)).toBe('|092');
  });

  it('does not merge two SKUs that share a product line', () => {
    const concentrate = sdsMatch({ chunk_id: 'c', document_title: '192' });
    const diluted = sdsMatch({ chunk_id: 'd', document_title: '192 DIL' });
    expect(sdsProductDedupeKey(concentrate)).not.toBe(sdsProductDedupeKey(diluted));
  });
});

describe('dedupeSdsMatchesByProduct (B0-16)', () => {
  it('collapses the three 092 documents to one row, keeping the highest similarity', () => {
    const deduped = dedupeSdsMatchesByProduct(the092Family);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].similarity).toBe(0.48);
    expect(deduped[0].document_title).toBe('092CAN');
    expect(deduped[0].document_id).toBe('15198577-da4b-48d8-add5-019e21e65fbd');
  });

  it('promotes the highest-similarity sheet even when it arrives after a lower-scoring sibling', () => {
    const usFirst = [the092Family[1], the092Family[0], the092Family[2]];
    const deduped = dedupeSdsMatchesByProduct(usFirst);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].similarity).toBe(0.48);
    expect(deduped[0].document_title).toBe('092CAN');
  });

  it('keeps the surviving product at the group’s best rank position', () => {
    const other = sdsMatch({
      chunk_id: 'other',
      document_title: '1681',
      product_line_key: '07a73e43-2a10-490f-b1b1-f6a901c8dd00',
      entity_id: '07a73e43-2a10-490f-b1b1-f6a901c8dd00',
      similarity: 0.475,
    });
    // 092CAN (0.48), 1681 (0.475), 092 (0.47) -> 092 must not jump ahead of 1681.
    const deduped = dedupeSdsMatchesByProduct([the092Family[0], other, the092Family[1]]);

    expect(deduped.map((m) => m.document_title)).toEqual(['092CAN', '1681']);
  });

  it('does NOT collapse two genuinely different products', () => {
    const glass = the092Family[0];
    const floorFinish = sdsMatch({
      chunk_id: 'floor',
      document_title: '1681',
      document_id: 'doc-1681',
      product_line_key: '07a73e43-2a10-490f-b1b1-f6a901c8dd00',
      entity_id: '07a73e43-2a10-490f-b1b1-f6a901c8dd00',
      similarity: 0.44,
    });
    const nearMissCode = sdsMatch({
      chunk_id: 'nearmiss',
      document_title: '0925',
      document_id: 'doc-0925',
      product_line_key: 'A1111111-1111-1111-1111-111111111111',
      entity_id: 'A1111111-1111-1111-1111-111111111111',
      similarity: 0.43,
    });

    const deduped = dedupeSdsMatchesByProduct([glass, floorFinish, nearMissCode]);

    expect(deduped).toHaveLength(3);
    expect(deduped.map((m) => m.document_title)).toEqual(['092CAN', '1681', '0925']);
  });

  it('never mutates the similarity of a surviving row', () => {
    const input = [...the092Family];
    const snapshot = input.map((m) => ({ chunk_id: m.chunk_id, similarity: m.similarity }));

    const deduped = dedupeSdsMatchesByProduct(input);

    // Survivor carries its own RPC similarity through, byte for byte.
    expect(deduped[0].similarity).toBe(0.48);
    // And the inputs are untouched.
    expect(input.map((m) => ({ chunk_id: m.chunk_id, similarity: m.similarity }))).toEqual(
      snapshot,
    );
  });

  it('leaves label and efficacy documents alone (regional variants carry different EPA/DIN data)', () => {
    // A US label and a Canadian label for the same product are NOT interchangeable.
    const usLabel = sdsMatch({
      chunk_id: 'label-us',
      document_kind: 'label',
      document_title: 'Clear Image',
      similarity: 0.51,
    });
    const canLabel = sdsMatch({
      chunk_id: 'label-can',
      document_kind: 'label',
      document_title: 'Clear Image CAN',
      similarity: 0.5,
    });
    const efficacyA = sdsMatch({
      chunk_id: 'eff-a',
      document_kind: 'efficacy',
      document_title: '311',
      similarity: 0.49,
    });
    const efficacyB = sdsMatch({
      chunk_id: 'eff-b',
      document_kind: 'efficacy',
      document_title: '311 CAN',
      similarity: 0.48,
    });

    const deduped = dedupeSdsMatchesByProduct([usLabel, canLabel, efficacyA, efficacyB]);

    expect(deduped).toHaveLength(4);
  });

  it('is a no-op for a corpus slice with no SDS rows', () => {
    const profile = sdsMatch({
      chunk_id: 'profile',
      document_kind: 'product_line_profile',
      document_title: 'Non-Ammoniated Glass Cleaner and Surface Cleaner',
    });

    expect(dedupeSdsMatchesByProduct([profile])).toEqual([profile]);
  });
});
