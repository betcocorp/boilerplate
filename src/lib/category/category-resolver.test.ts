import { describe, expect, it } from 'vitest';

import { resolveCategory, type TaxonomyNode } from '~/lib/category/category-resolver';

// Fixture modeled on real legacy.prod_line MetaKeyWords categories.
const NODES: TaxonomyNode[] = [
  { key: 'disinfectants', name: 'Disinfectants', aliases: ['disinfectant', 'sanitizers'] },
  {
    key: 'disinfectant-concentrates',
    name: 'Disinfectant Concentrates',
    parentKey: 'disinfectants',
    aliases: ['concentrated disinfectant'],
  },
  { key: 'floor-finishes', name: 'Floor Finishes', aliases: ['floor finish', 'floor wax'] },
  { key: 'floor-machines', name: 'Floor Machines', aliases: ['floor scrubber', 'burnisher'] },
  { key: 'bowl-cleaners', name: 'Bowl Cleaner', aliases: ['toilet bowl cleaner'] },
];

describe('resolveCategory (B0-27)', () => {
  it('returns the exact node as top candidate at confidence 1', () => {
    const [top] = resolveCategory('Disinfectants', NODES);
    expect(top?.node.key).toBe('disinfectants');
    expect(top?.confidence).toBe(1);
    expect(top?.matchType).toBe('exact');
  });

  it('matches a known alias', () => {
    const [top] = resolveCategory('sanitizers', NODES);
    expect(top?.node.key).toBe('disinfectants');
    expect(top?.matchType).toBe('alias');
    expect(top?.confidence).toBe(0.95);
  });

  it('matches a category named inside a natural-language query (containment)', () => {
    const [top] = resolveCategory('what bowl cleaners do you have?', NODES);
    expect(top?.node.key).toBe('bowl-cleaners');
    expect(top?.matchType).toBe('normalized');
  });

  it('returns multiple ranked candidates for an ambiguous query', () => {
    const matches = resolveCategory('floor', NODES);
    const keys = matches.map((m) => m.node.key);
    expect(keys).toContain('floor-finishes');
    expect(keys).toContain('floor-machines');
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // every candidate carries a 0–1 confidence + a match type
    for (const m of matches) {
      expect(m.confidence).toBeGreaterThan(0);
      expect(m.confidence).toBeLessThanOrEqual(1);
      expect(['exact', 'alias', 'normalized', 'fuzzy']).toContain(m.matchType);
    }
  });

  it('returns nothing for a junk query', () => {
    expect(resolveCategory('xyzzy quux', NODES)).toEqual([]);
    expect(resolveCategory('   ', NODES)).toEqual([]);
  });

  it('honors minConfidence and limit', () => {
    expect(resolveCategory('floor', NODES, { minConfidence: 0.99 })).toEqual([]);
    expect(resolveCategory('floor', NODES, { limit: 1 })).toHaveLength(1);
  });
});
