import { describe, expect, it } from 'vitest';

import { classifyCategoryRoute } from '~/lib/category/category-router';
import type { CategoryMatch } from '~/lib/category/category-resolver';

function match(key: string, confidence: number, matchType: CategoryMatch['matchType']): CategoryMatch {
  return { node: { key, name: key, path: [key] }, confidence, matchType };
}

describe('classifyCategoryRoute (B0-29)', () => {
  it('routes to category when the top candidate clears the threshold', () => {
    const result = classifyCategoryRoute([match('floor-care__strippers', 0.95, 'alias')], 0.8);
    expect(result.decision).toBe('category');
    if (result.decision === 'category') {
      expect(result.match.node.key).toBe('floor-care__strippers');
    }
  });

  it('falls back to semantic when the top candidate is below threshold', () => {
    const result = classifyCategoryRoute([match('disinfectants', 0.72, 'fuzzy')], 0.8);
    expect(result.decision).toBe('semantic');
    if (result.decision === 'semantic') {
      expect(result.reason).toBe('below_threshold');
      expect(result.top?.confidence).toBe(0.72);
    }
  });

  it('falls back to semantic when there is no candidate', () => {
    const result = classifyCategoryRoute([], 0.8);
    expect(result.decision).toBe('semantic');
    if (result.decision === 'semantic') {
      expect(result.reason).toBe('no_match');
      expect(result.top).toBeNull();
    }
  });

  it('treats confidence exactly at the threshold as a category match', () => {
    const result = classifyCategoryRoute([match('warewashing', 0.8, 'normalized')], 0.8);
    expect(result.decision).toBe('category');
  });

  it('uses the top (first) candidate, which the resolver returns ranked', () => {
    const result = classifyCategoryRoute(
      [match('a', 0.9, 'alias'), match('b', 0.85, 'normalized')],
      0.8,
    );
    expect(result.decision).toBe('category');
    if (result.decision === 'category') {
      expect(result.match.node.key).toBe('a');
    }
  });
});
