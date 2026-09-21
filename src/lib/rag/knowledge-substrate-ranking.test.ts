import { describe, expect, it } from 'vitest';

import {
  rankBySubstratePreference,
  resolveSubstratePreference,
  scoreSubstrateRelevance,
} from '~/lib/rag/knowledge-substrate-ranking';

/**
 * B0-1032 — `get_floor_asset` ranked the substrate-agnostic "floor maintenance frequency guide"
 * over the VCT-specific cadence document.
 *
 * The fixture below is the REAL candidate set observed live for the failing golden call (run
 * 35573e48-a043-49bf-9325-d16ccf4a7b41, `{ surfaceType: "VCT", procedure: "top scrub and stripping
 * frequency" }`): the titles and `similarity` values are exactly what the knowledge search returned,
 * in the order it returned them. No regulated value appears here — this fixture is about WHICH
 * document wins, never about what any document says.
 */
const WANTED = '75dfcf42-35a2-4273-905c-507e73ef6cc6';
const GENERIC = 'eea7a5bb-ab02-4c4b-96f5-09c3578d5f73';

const LIVE_CANDIDATES = [
  { document_id: GENERIC, document_title: 'floor maintenance frequency guide', similarity: 0.6978 },
  {
    document_id: '77a6c544-5b21-4423-9574-32effef162c0',
    document_title: '06 VCT Coverage Yield and Product Estimating',
    similarity: 0.6789,
  },
  {
    document_id: '34acdf43-fcba-4a1e-92cc-b3171a0e6a83',
    document_title: 'VCT Green Certified',
    similarity: 0.6773,
  },
  {
    document_id: '1d904b83-6f7d-49ea-a568-1e5992f048bd',
    document_title: '02 VCT Finish Application Coats Drying Curing',
    similarity: 0.6768,
  },
  {
    document_id: 'e18e2c65-0533-41dc-9438-71ab2d9a7f02',
    document_title: 'betco life cycle of floor care training',
    similarity: 0.6607,
  },
  {
    document_id: 'd4e68877-0ebe-4522-8c0e-2d26bc7f1fb0',
    document_title: 'VCT Recoat Standard Top Scrub',
    similarity: 0.6558,
  },
  {
    document_id: '85dfddb3-af4a-4beb-bb11-722ed7483864',
    document_title: 'VCT New Install Prep',
    similarity: 0.6484,
  },
  {
    document_id: '02924849-61c6-4c3c-8ad0-e8c04fa756f1',
    document_title: 'VCT Maintenance Program',
    similarity: 0.6384,
  },
  {
    document_id: WANTED,
    document_title: 'vct floor maintenance frequency betco standard',
    similarity: 0.6334,
  },
  {
    document_id: '91fb6641-402a-4723-8bbd-f2cda0d370fb',
    document_title: '01 VCT Stripping Failures and Best Practices',
    similarity: 0.6255,
  },
  {
    document_id: '6ad7ae25-9ffb-491c-b470-f394a12b7f60',
    document_title: 'vat top scrub recoat full procedure',
    similarity: 0.6284,
  },
];

const GOLDEN_PREFERENCE = {
  surfaceType: 'VCT',
  topic: 'top scrub and stripping frequency',
};

describe('resolveSubstratePreference (B0-1032)', () => {
  it('expands an abbreviation to its substrate family so title wording can differ from the caller', () => {
    const resolved = resolveSubstratePreference(GOLDEN_PREFERENCE);
    expect(resolved?.surfaceTerms).toContain('vct');
    expect(resolved?.surfaceTerms).toContain('vinyl composition tile');
    expect(resolved?.topicTerms).toEqual(
      expect.arrayContaining(['top', 'scrub', 'stripping', 'frequency']),
    );
    // "and" is too generic to distinguish one procedure document from another.
    expect(resolved?.topicTerms).not.toContain('and');
  });

  it('resolves the caller wording of the other substrates', () => {
    expect(resolveSubstratePreference({ surfaceType: 'wood gym floor' })?.surfaceTerms).toEqual(
      expect.arrayContaining(['wood', 'gym', 'maple', 'sportszone']),
    );
    expect(resolveSubstratePreference({ surfaceType: 'sealed concrete' })?.surfaceTerms).toEqual(
      expect.arrayContaining(['concrete']),
    );
    expect(resolveSubstratePreference({ surfaceType: 'terrazzo' })?.surfaceTerms).toEqual([
      'terrazzo',
    ]);
  });

  it('does not treat VAT (vinyl asbestos tile) as VCT', () => {
    const resolved = resolveSubstratePreference(GOLDEN_PREFERENCE);
    expect(resolved?.surfaceTerms).not.toContain('vat');
    expect(scoreSubstrateRelevance('vat top scrub recoat full procedure', resolved!)).toBe(0);
  });

  it('returns null when there is no usable substrate signal', () => {
    expect(resolveSubstratePreference(undefined)).toBeNull();
    expect(resolveSubstratePreference({ surfaceType: '   ' })).toBeNull();
    // Nothing but generic words — no substrate to prefer.
    expect(resolveSubstratePreference({ surfaceType: 'the floor surface' })).toBeNull();
  });
});

describe('scoreSubstrateRelevance (B0-1032)', () => {
  const preference = resolveSubstratePreference(GOLDEN_PREFERENCE)!;

  it('scores a substrate-agnostic title zero even when it matches every topic term', () => {
    expect(scoreSubstrateRelevance('floor maintenance frequency guide', preference)).toBe(0);
  });

  it('scores substrate + topic above substrate alone', () => {
    const specific = scoreSubstrateRelevance(
      'vct floor maintenance frequency betco standard',
      preference,
    );
    const substrateOnly = scoreSubstrateRelevance('VCT Green Certified', preference);
    expect(substrateOnly).toBe(1);
    expect(specific).toBeGreaterThan(substrateOnly);
  });

  it('matches a term on a word-start prefix so "scrub" finds "scrubbing"', () => {
    expect(scoreSubstrateRelevance('VCT Top Scrubbing Standard', preference)).toBeGreaterThan(1);
  });
});

describe('rankBySubstratePreference (B0-1032)', () => {
  it('puts the VCT-specific cadence document ahead of the generic frequency guide', () => {
    const preference = resolveSubstratePreference(GOLDEN_PREFERENCE);
    const { ranked, boostedCount } = rankBySubstratePreference(LIVE_CANDIDATES, preference);

    const ids = ranked.map((m) => m.document_id);
    expect(ids.indexOf(WANTED)).toBeLessThan(ids.indexOf(GENERIC));
    // The whole point: the generic document no longer takes a slot in a 3-document result.
    expect(ids.slice(0, 3)).toContain(WANTED);
    expect(ids.slice(0, 3)).not.toContain(GENERIC);
    expect(boostedCount).toBeGreaterThan(0);
  });

  it('is ORDER-ONLY — no similarity is rewritten and the same objects come back', () => {
    const before = LIVE_CANDIDATES.map((m) => ({ ...m }));
    const { ranked } = rankBySubstratePreference(
      LIVE_CANDIDATES,
      resolveSubstratePreference(GOLDEN_PREFERENCE),
    );

    expect(LIVE_CANDIDATES).toEqual(before);
    for (const match of ranked) {
      expect(LIVE_CANDIDATES).toContain(match);
      const original = before.find((m) => m.document_id === match.document_id)!;
      expect(match.similarity).toBe(original.similarity);
    }
  });

  it('keeps the incoming order within a score tier', () => {
    const { ranked } = rankBySubstratePreference(
      LIVE_CANDIDATES,
      resolveSubstratePreference({ surfaceType: 'VCT' }),
    );
    // With no topic terms every VCT title scores 1, so the incoming (similarity) order survives.
    const vctTitles = ranked
      .filter((m) => m.document_title.toLowerCase().includes('vct'))
      .map((m) => m.document_id);
    const incomingVct = LIVE_CANDIDATES.filter((m) =>
      m.document_title.toLowerCase().includes('vct'),
    ).map((m) => m.document_id);
    expect(vctTitles).toEqual(incomingVct);
  });

  it('is a no-op when no preference resolved or nothing matches the substrate', () => {
    expect(rankBySubstratePreference(LIVE_CANDIDATES, null).ranked).toBe(LIVE_CANDIDATES);
    const concrete = rankBySubstratePreference(
      LIVE_CANDIDATES,
      resolveSubstratePreference({ surfaceType: 'sealed concrete', topic: 'sealer coverage' }),
    );
    expect(concrete.ranked).toBe(LIVE_CANDIDATES);
    expect(concrete.boostedCount).toBe(0);
  });

  it('never drops a candidate — this is a preference, not a filter', () => {
    const { ranked } = rankBySubstratePreference(
      LIVE_CANDIDATES,
      resolveSubstratePreference(GOLDEN_PREFERENCE),
    );
    expect(ranked).toHaveLength(LIVE_CANDIDATES.length);
    expect([...ranked].map((m) => m.document_id).sort()).toEqual(
      LIVE_CANDIDATES.map((m) => m.document_id).sort(),
    );
  });
});
