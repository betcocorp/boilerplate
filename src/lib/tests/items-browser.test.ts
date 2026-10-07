import { describe, expect, it } from 'vitest';

import {
  buildTestItemsBrowserHref,
  buildTestItemsBrowserPredicates,
  buildTestItemsScopePredicates,
  DEFAULT_TEST_ITEMS_BROWSER_FILTERS,
  normalizeTestItemsSearchTerm,
  readTestItemsBrowserFilters,
  TEST_ITEMS_BROWSER_SEARCH_MAX_CHARS,
} from '~/lib/tests/items-browser';

const TEST_ID = '0b7c1a2e-5f3d-4e8a-9c1b-2d3e4f5a6b7c';

/**
 * B0-762 — the URL → filters → PostgREST-predicate mapping behind `/admin/tests/items`. Pure, so
 * the default golden scope, every fallback, and the exact predicate columns are pinned without a
 * database.
 */
describe('readTestItemsBrowserFilters', () => {
  it('defaults to golden-only, every other filter off, page 1', () => {
    expect(readTestItemsBrowserFilters({})).toEqual({
      filters: DEFAULT_TEST_ITEMS_BROWSER_FILTERS,
      page: 1,
    });
  });

  it('reads golden=false as "all sets" and anything else as the default ON', () => {
    expect(readTestItemsBrowserFilters({ golden: 'false' }).filters.goldenOnly).toBe(false);
    expect(readTestItemsBrowserFilters({ golden: 'true' }).filters.goldenOnly).toBe(true);
    expect(readTestItemsBrowserFilters({ golden: 'no' }).filters.goldenOnly).toBe(true);
  });

  it('accepts every valid filter and parses the page', () => {
    const { filters, page } = readTestItemsBrowserFilters({
      golden: 'false',
      test: TEST_ID,
      agent: 'dilution',
      category: 'recommendation',
      qcat: ' VCT ',
      q: ' neutral  cleaner ',
      concepts: 'missing',
      page: '3',
    });

    expect(filters).toEqual({
      goldenOnly: false,
      testId: TEST_ID,
      intendedAgent: 'dilution',
      promptCategory: 'recommendation',
      questionCategory: 'VCT',
      search: 'neutral  cleaner',
      concepts: 'missing',
    });
    expect(page).toBe(3);
  });

  it('drops malformed or unknown values instead of erroring', () => {
    const { filters, page } = readTestItemsBrowserFilters({
      test: 'not-a-uuid',
      agent: 'floor',
      category: 'not-a-slug',
      concepts: 'everything',
      page: '-4',
    });

    expect(filters).toEqual(DEFAULT_TEST_ITEMS_BROWSER_FILTERS);
    expect(page).toBe(1);
  });

  it('uses the first value when a key repeats', () => {
    expect(readTestItemsBrowserFilters({ agent: ['product', 'dilution'] }).filters.intendedAgent).toBe(
      'product',
    );
  });
});

describe('normalizeTestItemsSearchTerm', () => {
  it('strips PostgREST wildcard and grouping characters and caps the length', () => {
    expect(normalizeTestItemsSearchTerm(' 50% (dilution) *ratio*, oz/gal ')).toBe(
      '50 dilution ratio  oz/gal',
    );
    expect(normalizeTestItemsSearchTerm('a_b')).toBe('a_b');
    expect(normalizeTestItemsSearchTerm('x'.repeat(500))).toHaveLength(
      TEST_ITEMS_BROWSER_SEARCH_MAX_CHARS,
    );
  });
});

describe('buildTestItemsBrowserPredicates', () => {
  it('scopes the default to non-archived golden sets via the tests!inner embed', () => {
    expect(buildTestItemsBrowserPredicates(DEFAULT_TEST_ITEMS_BROWSER_FILTERS)).toEqual([
      { op: 'eq', column: 'tests.is_golden', value: true },
      { op: 'eq', column: 'tests.is_archived', value: false },
    ]);
  });

  it('applies no scope predicate when golden is off', () => {
    expect(
      buildTestItemsBrowserPredicates({ ...DEFAULT_TEST_ITEMS_BROWSER_FILTERS, goldenOnly: false }),
    ).toEqual([]);
  });

  it('maps every filter to its column, including the JSON path and empty-array literals', () => {
    expect(
      buildTestItemsBrowserPredicates({
        goldenOnly: false,
        testId: TEST_ID,
        intendedAgent: 'product',
        promptCategory: 'safety-ppe',
        questionCategory: 'dilution',
        search: 'ph7q',
        concepts: 'missing',
      }),
    ).toEqual([
      { op: 'eq', column: 'test_id', value: TEST_ID },
      { op: 'eq', column: 'tests.intended_agent', value: 'product' },
      { op: 'eq', column: 'prompt_category', value: 'safety-ppe' },
      { op: 'eq', column: 'input_payload->>question_category', value: 'dilution' },
      { op: 'ilike', column: 'prompt', pattern: '%ph7q%' },
      { op: 'eq', column: 'minimum_concepts', value: '{}' },
      { op: 'eq', column: 'expected_concepts', value: '{}' },
    ]);
  });

  it('scope predicates carry only the golden half of the filters', () => {
    expect(buildTestItemsScopePredicates({ goldenOnly: true })).toEqual(
      buildTestItemsBrowserPredicates(DEFAULT_TEST_ITEMS_BROWSER_FILTERS),
    );
    expect(buildTestItemsScopePredicates({ goldenOnly: false })).toEqual([]);
  });
});

describe('buildTestItemsBrowserHref', () => {
  it('emits the bare route for the defaults and only non-default params otherwise', () => {
    expect(buildTestItemsBrowserHref(DEFAULT_TEST_ITEMS_BROWSER_FILTERS)).toBe('/admin/tests/items');
    expect(
      buildTestItemsBrowserHref(
        { goldenOnly: false, concepts: 'missing', search: 'floor finish', intendedAgent: 'floor_vct' },
        2,
      ),
    ).toBe('/admin/tests/items?golden=false&agent=floor_vct&q=floor+finish&concepts=missing&page=2');
  });

  it('round-trips through readTestItemsBrowserFilters', () => {
    const filters = {
      goldenOnly: false,
      testId: TEST_ID,
      promptCategory: 'competitor',
      questionCategory: 'Restroom (daily)',
      concepts: 'all' as const,
    };
    const href = buildTestItemsBrowserHref(filters, 4);
    const params = Object.fromEntries(new URL(href, 'http://localhost').searchParams);
    expect(readTestItemsBrowserFilters(params)).toEqual({ filters, page: 4 });
  });
});
