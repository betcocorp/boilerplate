import { describe, expect, it } from 'vitest';

import {
  buildCategoryLinks,
  skuMatchesStem,
  stemForSku,
  LINK_SOURCE_SITE_SCRAPE,
  type LinkableProduct,
  type ScrapedNode,
} from '~/lib/category/product-linker';

describe('skuMatchesStem / stemForSku', () => {
  it('matches web SKUs against their site stem (base + 2-char pack code)', () => {
    expect(skuMatchesStem('104B5-00', '104')).toBe(true);
    expect(skuMatchesStem('10404-00', '104')).toBe(true);
    expect(skuMatchesStem('09923-00', '099')).toBe(true);
    expect(skuMatchesStem('167804-00', '1678')).toBe(true);
    // case-insensitive (URL stems are lowercased, SKUs upper)
    expect(skuMatchesStem('355C04-00', '355c')).toBe(true);
  });

  it('does not over-match a shorter stem prefix', () => {
    // "10" must not swallow "104B5-00" — the stem must be followed by exactly the pack code + dash
    expect(skuMatchesStem('104B5-00', '10')).toBe(false);
    expect(skuMatchesStem('104B5-00', '105')).toBe(false);
  });

  it('yields no stem for internal / malformed SKUs', () => {
    expect(stemForSku('PL683C0D69B47B4')).toBe('pl683c0d69b47'); // derivable but never a site stem
    expect(stemForSku('AB')).toBeNull();
    expect(stemForSku(null)).toBeNull();
    expect(stemForSku('167804-00')).toBe('1678');
  });
});

const NODES: ScrapedNode[] = [
  { nodeKey: 'floor-care', depth: 0, stems: ['104', '10455'] }, // parent repeats descendant stems
  { nodeKey: 'floor-care__strippers', depth: 1, stems: ['104'] },
  { nodeKey: 'chem__disinfectants', depth: 1, stems: ['311', '333'] },
];

describe('buildCategoryLinks', () => {
  it('places a product at the deepest node and links its prod-line confidently', () => {
    const products: LinkableProduct[] = [
      { productKey: 'p1', sku: '104B5-00', prodLineKey: 'PL-STRIP' },
      { productKey: 'p2', sku: '10404-00', prodLineKey: 'PL-STRIP' },
    ];
    const { links, needsClassifier, placedProducts } = buildCategoryLinks(NODES, products);
    expect(placedProducts).toBe(2);
    expect(needsClassifier).toHaveLength(0);
    expect(links).toHaveLength(1);
    // "104" appears on both floor-care (depth 0) and strippers (depth 1) → deepest wins
    expect(links[0]).toEqual({
      prodLineKey: 'PL-STRIP',
      categoryKey: 'floor-care__strippers',
      confidence: 1,
      source: LINK_SOURCE_SITE_SCRAPE,
    });
  });

  it('sends a prod-line with no site placement to needs-classifier', () => {
    const products: LinkableProduct[] = [
      { productKey: 'x', sku: 'PL683C0D69B47B4', prodLineKey: 'PL-INTERNAL' },
    ];
    const { links, needsClassifier } = buildCategoryLinks(NODES, products);
    expect(links).toHaveLength(0);
    expect(needsClassifier).toEqual([{ prodLineKey: 'PL-INTERNAL', reason: 'no_site_placement' }]);
  });

  it('links a 1-1 split at exactly the agreement floor (0.5) to the first-seen node', () => {
    const products: LinkableProduct[] = [
      { productKey: 'a', sku: '104B5-00', prodLineKey: 'PL-MIX' }, // strippers
      { productKey: 'b', sku: '31104-00', prodLineKey: 'PL-MIX' }, // disinfectants
    ];
    const { links, needsClassifier } = buildCategoryLinks(NODES, products);
    // top share = 1/2 = 0.5 (>= floor) → links to whichever node counted first (both count 1)
    expect(links).toHaveLength(1);
    expect(links[0].confidence).toBe(0.5);
    expect(needsClassifier).toHaveLength(0);
  });

  it('marks a genuinely split prod-line (top share < 0.5) as ambiguous', () => {
    const nodes: ScrapedNode[] = [
      { nodeKey: 'a', depth: 1, stems: ['100'] },
      { nodeKey: 'b', depth: 1, stems: ['200'] },
      { nodeKey: 'c', depth: 1, stems: ['300'] },
    ];
    const products: LinkableProduct[] = [
      { productKey: '1', sku: '10001-00', prodLineKey: 'PL-SPLIT' },
      { productKey: '2', sku: '20001-00', prodLineKey: 'PL-SPLIT' },
      { productKey: '3', sku: '30001-00', prodLineKey: 'PL-SPLIT' },
    ];
    const { links, needsClassifier } = buildCategoryLinks(nodes, products);
    expect(links).toHaveLength(0);
    expect(needsClassifier).toEqual([{ prodLineKey: 'PL-SPLIT', reason: 'ambiguous' }]);
  });
});
