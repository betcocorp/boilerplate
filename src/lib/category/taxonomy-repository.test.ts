import { describe, expect, it } from 'vitest';

import { collectDescendantKeys } from '~/lib/category/taxonomy-repository';
import type { TaxonomyNode } from '~/lib/category/category-resolver';

const NODES: TaxonomyNode[] = [
  { key: 'floor-care', name: 'Floor Care', parentKey: null, path: ['Floor Care'] },
  { key: 'floor-care__finishes', name: 'Finishes', parentKey: 'floor-care', path: ['Floor Care', 'Finishes'] },
  { key: 'floor-care__finishes__resilient', name: 'Resilient', parentKey: 'floor-care__finishes', path: ['Floor Care', 'Finishes', 'Resilient'] },
  { key: 'floor-care__strippers', name: 'Strippers', parentKey: 'floor-care', path: ['Floor Care', 'Strippers'] },
  { key: 'disinfectants', name: 'Disinfectants', parentKey: null, path: ['Disinfectants'] },
];

describe('collectDescendantKeys', () => {
  it('returns the node plus all transitive descendants', () => {
    expect(new Set(collectDescendantKeys(NODES, 'floor-care'))).toEqual(
      new Set([
        'floor-care',
        'floor-care__finishes',
        'floor-care__finishes__resilient',
        'floor-care__strippers',
      ]),
    );
  });

  it('returns just the node for a leaf', () => {
    expect(collectDescendantKeys(NODES, 'floor-care__strippers')).toEqual([
      'floor-care__strippers',
    ]);
  });

  it('does not cross into unrelated subtrees', () => {
    expect(collectDescendantKeys(NODES, 'disinfectants')).toEqual(['disinfectants']);
  });
});
