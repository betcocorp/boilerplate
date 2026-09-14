import { describe, expect, it } from 'vitest';

import type { RagSearchMatch } from '~/lib/rag/search';
import { selectCuratedMatches } from '~/lib/retrieval/source-selection';

/**
 * B0-974 — SportsZone golden item 6eeebab8, "How often should a wood sport floor be recoated?".
 * The only corpus sentence with "annual" ("Gym Floor Sanding Lifetime Guidelines" chunk 4:
 * "…routine cleaning and annual recoats") replayed at raw rank 2 (0.698) but never reached the
 * model: with `limit 3`, the `product_line_profile` required-kind reservation handed a slot to
 * "Oil-Based Wood Sport Finish" at raw rank 12 and the knowledge chunk fell off the end.
 *
 * The rule under test: for an UNANCHORED question (`productAnchored: false`) a profile slot is not
 * reserved when the best profile ranks below the best knowledge chunk. Every default-path caller is
 * untouched (`productAnchored` omitted → the reservation runs exactly as before).
 */

function match(
  overrides: Partial<RagSearchMatch> & { chunk_id: string; document_id: string },
): RagSearchMatch {
  return {
    chunk_key: `key-${overrides.chunk_id}`,
    chunk_index: 0,
    heading: null,
    chunk_text: `text for ${overrides.chunk_id}`,
    section_path: null,
    section_type: 'knowledge',
    token_count: 20,
    document_key: `dockey-${overrides.document_id}`,
    document_title: `Document ${overrides.document_id}`,
    entity_id: null,
    product_key: null,
    sku: null,
    product_line_key: null,
    source_pk: `pk-${overrides.document_id}`,
    document_kind: 'knowledge',
    similarity: 0.5,
    ...overrides,
  } as RagSearchMatch;
}

const REQUIRED_KINDS = ['product_line_profile', 'sds', 'knowledge', 'label'];

const knowledgeFirst = match({ chunk_id: 'k1', document_id: 'wood-faq', similarity: 0.72 });
const knowledgeSecond = match({ chunk_id: 'k2', document_id: 'gym-reentry', similarity: 0.7 });
const knowledgeTarget = match({
  chunk_id: 'k3',
  document_id: 'gym-sanding-lifetime',
  document_title: 'Gym Floor Sanding Lifetime Guidelines',
  chunk_text: '…routine cleaning and annual recoats',
  similarity: 0.698,
});
const profileBelow = match({
  chunk_id: 'p1',
  document_id: 'oil-based-wood-sport-finish',
  document_kind: 'product_line_profile',
  document_title: 'Oil-Based Wood Sport Finish',
  similarity: 0.55,
});

const pool = [profileBelow, knowledgeTarget, knowledgeFirst, knowledgeSecond];

describe('selectCuratedMatches — B0-974 unanchored profile reservation', () => {
  it('default (anchored) still reserves the lower-ranked profile, displacing the target chunk', () => {
    const selected = selectCuratedMatches(pool, { limit: 3, requiredDocumentKinds: REQUIRED_KINDS });
    expect(selected.map((m) => m.chunk_id)).toEqual(['p1', 'k1', 'k2']);
  });

  it('productAnchored: false lets the knowledge chunks keep the slots the ranking gave them', () => {
    const selected = selectCuratedMatches(pool, {
      limit: 3,
      requiredDocumentKinds: REQUIRED_KINDS,
      productAnchored: false,
    });
    expect(selected.map((m) => m.chunk_id)).toEqual(['k1', 'k2', 'k3']);
  });

  it('productAnchored: false still reserves a profile that outranks every knowledge chunk', () => {
    const profileAbove = { ...profileBelow, similarity: 0.8 };
    const selected = selectCuratedMatches([knowledgeFirst, knowledgeSecond, profileAbove], {
      limit: 2,
      requiredDocumentKinds: REQUIRED_KINDS,
      productAnchored: false,
    });
    expect(selected.map((m) => m.chunk_id)).toEqual(['p1', 'k1']);
  });

  it('productAnchored: false with no knowledge candidate reserves exactly as before', () => {
    const sds = match({ chunk_id: 's1', document_id: 'sds-doc', document_kind: 'sds', similarity: 0.9 });
    const label = match({ chunk_id: 'l1', document_id: 'label-doc', document_kind: 'label', similarity: 0.85 });
    const selected = selectCuratedMatches([sds, label, profileBelow], {
      limit: 2,
      requiredDocumentKinds: REQUIRED_KINDS,
      productAnchored: false,
    });
    // Profile reserved first (array order), then the best remaining by similarity.
    expect(selected.map((m) => m.chunk_id)).toEqual(['p1', 's1']);
  });

  it('a profile skipped by the reservation still competes in the plain similarity pass', () => {
    const selected = selectCuratedMatches(pool, {
      limit: 4,
      requiredDocumentKinds: REQUIRED_KINDS,
      productAnchored: false,
    });
    expect(selected.map((m) => m.chunk_id)).toEqual(['k1', 'k2', 'k3', 'p1']);
  });
});
