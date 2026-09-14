import { describe, expect, it } from 'vitest';

import { extractQueryDomainTerms, haveIdenticalDomainTerms } from '~/lib/rag/query-domain-terms';

/**
 * B0-975 — the approximate query-embedding cache (`find_similar_search_embedding`, trigram ≥ 0.9
 * for long queries) may reuse a cached embedding only when both queries name exactly the same
 * domain terms. The failing pair from the ticket sits at trigram 0.9286 and differs by one term.
 */
describe('haveIdenticalDomainTerms — B0-975 approximate cache guard', () => {
  it('rejects the ticket pair: the cached row dropped "VCT"', () => {
    expect(
      haveIdenticalDomainTerms(
        'how soon can people walk on the VCT floor after the last coat?',
        'how soon can people walk on the floor after the last coat?',
      ),
    ).toBe(false);
  });

  it('accepts the same question with punctuation / casing / whitespace noise', () => {
    expect(
      haveIdenticalDomainTerms(
        'how soon can people walk on the VCT floor after the last coat?',
        'How soon can people walk on the vct  floor after the last coat',
      ),
    ).toBe(true);
  });

  it('treats the LLM rewrite\'s acronym expansion as the same term', () => {
    expect(
      haveIdenticalDomainTerms(
        'how soon can people walk on the VCT floor after the last coat?',
        'floor finish vinyl composition tile drying time before walking on floor after last coat',
      ),
      // Both name VCT and finish, but the rewrite ALSO names "finish" — that is a genuine term the
      // raw question does not carry, so the sets differ and the rewritten row is not reused.
    ).toBe(false);
    expect(
      haveIdenticalDomainTerms(
        'walk on the VCT floor after the last coat',
        'walk on the vinyl composition tile floor after the last coat',
      ),
    ).toBe(true);
  });

  it('rejects a floor-type substitution', () => {
    expect(
      haveIdenticalDomainTerms(
        'How often should a wood sport floor be recoated?',
        'How often should a VCT floor be recoated?',
      ),
    ).toBe(false);
  });

  it('rejects a SKU / code change', () => {
    expect(
      haveIdenticalDomainTerms('Kling 07512-00 contact time', 'Kling 07512-01 contact time'),
    ).toBe(false);
    expect(
      haveIdenticalDomainTerms('Kling 07512-00 contact time', 'Kling 07512-00 contact time?'),
    ).toBe(true);
  });

  it('two queries with no domain terms at all are identical (trigram alone decides, as before)', () => {
    expect(haveIdenticalDomainTerms('what should I check first', 'what should I check first?')).toBe(
      true,
    );
  });
});

describe('extractQueryDomainTerms', () => {
  it('collects surfaces, floor types, product forms, acronyms and code-like tokens', () => {
    expect(
      [...extractQueryDomainTerms('Does pH7Q RTU work on VCT and terrazzo? SKU 22604')].sort(),
    ).toEqual(['22604', 'ph7q', 'rtu', 'terrazzo', 'vct'].sort());
  });

  it('normalises simple plurals of known terms', () => {
    expect([...extractQueryDomainTerms('cleaning ceramic tiles and rugs')].sort()).toEqual(
      ['ceramic tile', 'rug'].sort(),
    );
  });
});
