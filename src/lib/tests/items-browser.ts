/**
 * B0-762 — the cross-set test-item browser behind `/admin/tests/items`.
 *
 * Until now a test item could only be reached by opening its own set (`/admin/tests/[testId]`) or
 * by knowing words from its prompt (`PromptSearchDialog`). This module is the read side of a
 * browseable, filterable list over EVERY `test_items` row: the pure pieces (searchParams →
 * filters, filters → PostgREST predicates) are kept separate from the Supabase calls so the
 * mapping can be unit-tested without the network.
 *
 * Every predicate is applied in Postgres on the `tests!inner` embed or the row itself — never as a
 * post-fetch filter in JS — so `total` and the page's rows always describe the same set
 * (same reasoning as `listAllReportRuns`, B0-688). PostgREST caps a response at 1000 rows, so
 * the page query is `.range()`-bounded and the option scans are paged.
 */

import { z } from 'zod';

import { SME_AGENT_IDS } from '~/lib/agents/agent-registry';
import { PROMPT_CATEGORY_SLUGS } from '~/lib/constants/prompt-categories';
import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { readSearchParam } from '~/lib/utils/params';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const TEST_ITEMS_BROWSER_ROUTE = '/admin/tests/items';
export const TEST_ITEMS_BROWSER_PAGE_SIZE = 50;
/** Bound on the `q` term so a pathological URL can't build a huge LIKE pattern (mirrors B0-431). */
export const TEST_ITEMS_BROWSER_SEARCH_MAX_CHARS = 200;

export const TEST_ITEMS_CONCEPT_FILTERS = ['all', 'missing'] as const;
export type TestItemsConceptFilter = (typeof TEST_ITEMS_CONCEPT_FILTERS)[number];

/** PostgREST pages for the distinct-value scans (`test_items` is ~1.2k rows today). */
const OPTION_SCAN_PAGE_SIZE = 1000;
const OPTION_SCAN_MAX_PAGES = 20;

/* -------------------------------------------------------------------------- *
 * Contracts
 * -------------------------------------------------------------------------- */

export const testItemsBrowserFiltersSchema = z.object({
  /** Default ON: only items whose set is `is_golden` AND not archived. OFF: every set, archived too. */
  goldenOnly: z.boolean(),
  /** `tests.id` — validated against the option list by the page, shape-checked here. */
  testId: z.uuid().optional(),
  /** `tests.intended_agent`, one of the registry's SME ids. */
  intendedAgent: z.enum(SME_AGENT_IDS).optional(),
  /** `test_items.prompt_category` classifier slug. */
  promptCategory: z.string().min(1).optional(),
  /** Human `input_payload->>question_category`, exact match. */
  questionCategory: z.string().min(1).max(TEST_ITEMS_BROWSER_SEARCH_MAX_CHARS).optional(),
  /** Normalized case-insensitive substring over `prompt`. */
  search: z.string().min(1).max(TEST_ITEMS_BROWSER_SEARCH_MAX_CHARS).optional(),
  /** `missing` = neither `minimum_concepts` nor `expected_concepts` — ungradeable under B0-826. */
  concepts: z.enum(TEST_ITEMS_CONCEPT_FILTERS),
});
export type TestItemsBrowserFilters = z.infer<typeof testItemsBrowserFiltersSchema>;

export const DEFAULT_TEST_ITEMS_BROWSER_FILTERS: TestItemsBrowserFilters = {
  goldenOnly: true,
  concepts: 'all',
};

export const testItemsBrowserRowSchema = z.object({
  id: z.string(),
  testId: z.string(),
  testName: z.string(),
  testIsGolden: z.boolean(),
  testIsArchived: z.boolean(),
  intendedAgent: z.string().nullable(),
  rowIndex: z.number().int(),
  prompt: z.string(),
  promptCategory: z.string().nullable(),
  questionCategory: z.string().nullable(),
  minimumConceptCount: z.number().int().nonnegative(),
  expectedConceptCount: z.number().int().nonnegative(),
  expectedTool: z.string().nullable(),
});
export type TestItemsBrowserRow = z.infer<typeof testItemsBrowserRowSchema>;

export type TestItemsBrowserPage = {
  rows: TestItemsBrowserRow[];
  /** Exact count of items matching the filters across every page. */
  total: number;
  page: number;
  pageSize: number;
};

/** Lean `tests` row for the set dropdown. */
export type TestFilterOption = {
  id: string;
  name: string;
  isGolden: boolean;
  isArchived: boolean;
};

/* -------------------------------------------------------------------------- *
 * Pure: searchParams → filters
 * -------------------------------------------------------------------------- */

/**
 * Strips the characters that carry meaning inside a PostgREST filter expression so a search term
 * stays a search term — same normalization as `/admin/observability` (B0-431). `%` and `*` are
 * both `ilike` wildcards; `_` is left alone because a single-character wildcard still matches
 * itself.
 */
export function normalizeTestItemsSearchTerm(value: string): string {
  return value
    .trim()
    .slice(0, TEST_ITEMS_BROWSER_SEARCH_MAX_CHARS)
    .replaceAll(',', ' ')
    .replaceAll('%', '')
    .replaceAll('*', '')
    .replaceAll('(', '')
    .replaceAll(')', '')
    .trim();
}

export type TestItemsBrowserSearchParams = Record<string, string | string[] | undefined>;

const PROMPT_CATEGORY_SLUG_SET = new Set<string>(PROMPT_CATEGORY_SLUGS);
const SME_AGENT_ID_SET = new Set<string>(SME_AGENT_IDS);

/**
 * Reads the URL into a validated filter set plus a 1-based page. Unknown or malformed values fall
 * back to "not filtered" rather than erroring, so a stale bookmark still renders a page.
 *
 * `golden` is absent-or-anything-but-`false` = ON, matching `/admin/tests`'s `onlyGolden` reading.
 */
export function readTestItemsBrowserFilters(params: TestItemsBrowserSearchParams): {
  filters: TestItemsBrowserFilters;
  page: number;
} {
  const goldenOnly = readSearchParam(params.golden) !== 'false';

  const testIdParam = readSearchParam(params.test).trim();
  const testId = z.uuid().safeParse(testIdParam).success ? testIdParam : undefined;

  const agentParam = readSearchParam(params.agent).trim();
  const intendedAgent = SME_AGENT_ID_SET.has(agentParam)
    ? (agentParam as TestItemsBrowserFilters['intendedAgent'])
    : undefined;

  const categoryParam = readSearchParam(params.category).trim();
  const promptCategory = PROMPT_CATEGORY_SLUG_SET.has(categoryParam) ? categoryParam : undefined;

  // Exact match on a free-text value: only trimmed and capped, never wildcard-stripped — a
  // question_category containing `(` must still be selectable.
  const qcatParam = readSearchParam(params.qcat).trim().slice(0, TEST_ITEMS_BROWSER_SEARCH_MAX_CHARS);
  const questionCategory = qcatParam || undefined;

  const search = normalizeTestItemsSearchTerm(readSearchParam(params.q)) || undefined;

  const conceptsParam = readSearchParam(params.concepts).trim();
  const concepts: TestItemsConceptFilter = conceptsParam === 'missing' ? 'missing' : 'all';

  const requestedPage = Number.parseInt(readSearchParam(params.page, '1'), 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const filters = testItemsBrowserFiltersSchema.parse({
    goldenOnly,
    testId,
    intendedAgent,
    promptCategory,
    questionCategory,
    search,
    concepts,
  });

  return { filters, page };
}

/** Inverse of `readTestItemsBrowserFilters`: a linkable URL carrying only the non-default values. */
export function buildTestItemsBrowserHref(filters: TestItemsBrowserFilters, page = 1): string {
  const params = new URLSearchParams();
  if (!filters.goldenOnly) params.set('golden', 'false');
  if (filters.testId) params.set('test', filters.testId);
  if (filters.intendedAgent) params.set('agent', filters.intendedAgent);
  if (filters.promptCategory) params.set('category', filters.promptCategory);
  if (filters.questionCategory) params.set('qcat', filters.questionCategory);
  if (filters.search) params.set('q', filters.search);
  if (filters.concepts !== 'all') params.set('concepts', filters.concepts);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `${TEST_ITEMS_BROWSER_ROUTE}?${qs}` : TEST_ITEMS_BROWSER_ROUTE;
}

/* -------------------------------------------------------------------------- *
 * Pure: filters → PostgREST predicates
 * -------------------------------------------------------------------------- */

export type TestItemsBrowserPredicate =
  | { op: 'eq'; column: string; value: string | boolean }
  | { op: 'ilike'; column: string; pattern: string };

/**
 * The predicates a filter set applies to a `test_items` query that embeds `tests!inner(...)`.
 * Columns on the embed are addressed as `tests.<column>` so PostgREST applies them as join
 * predicates. The `'{}'` literal is Postgres's empty-array text form, which is what an `eq` on a
 * `text[]` column needs to say "no elements".
 */
export function buildTestItemsBrowserPredicates(
  filters: TestItemsBrowserFilters,
): TestItemsBrowserPredicate[] {
  const predicates: TestItemsBrowserPredicate[] = [];

  if (filters.goldenOnly) {
    predicates.push({ op: 'eq', column: 'tests.is_golden', value: true });
    predicates.push({ op: 'eq', column: 'tests.is_archived', value: false });
  }
  if (filters.testId) {
    predicates.push({ op: 'eq', column: 'test_id', value: filters.testId });
  }
  if (filters.intendedAgent) {
    predicates.push({ op: 'eq', column: 'tests.intended_agent', value: filters.intendedAgent });
  }
  if (filters.promptCategory) {
    predicates.push({ op: 'eq', column: 'prompt_category', value: filters.promptCategory });
  }
  if (filters.questionCategory) {
    predicates.push({
      op: 'eq',
      column: 'input_payload->>question_category',
      value: filters.questionCategory,
    });
  }
  if (filters.search) {
    predicates.push({ op: 'ilike', column: 'prompt', pattern: `%${filters.search}%` });
  }
  if (filters.concepts === 'missing') {
    predicates.push({ op: 'eq', column: 'minimum_concepts', value: '{}' });
    predicates.push({ op: 'eq', column: 'expected_concepts', value: '{}' });
  }

  return predicates;
}

/** Only the scope half of the predicates — what the distinct-value option scans share with the page. */
export function buildTestItemsScopePredicates(
  filters: Pick<TestItemsBrowserFilters, 'goldenOnly'>,
): TestItemsBrowserPredicate[] {
  return buildTestItemsBrowserPredicates({
    ...DEFAULT_TEST_ITEMS_BROWSER_FILTERS,
    goldenOnly: filters.goldenOnly,
  });
}

/* -------------------------------------------------------------------------- *
 * Supabase wiring
 * -------------------------------------------------------------------------- */

/** Minimal structural type for the PostgREST builder methods the predicates need. */
type FilterableQuery<Q> = {
  eq: (column: string, value: string | boolean) => Q;
  ilike: (column: string, pattern: string) => Q;
};

function applyPredicates<Q extends FilterableQuery<Q>>(
  query: Q,
  predicates: readonly TestItemsBrowserPredicate[],
): Q {
  return predicates.reduce((acc, predicate) => {
    return predicate.op === 'eq'
      ? acc.eq(predicate.column, predicate.value)
      : acc.ilike(predicate.column, predicate.pattern);
  }, query);
}

const embeddedTestSchema = z.object({
  id: z.string(),
  name: z.string(),
  is_golden: z.boolean(),
  is_archived: z.boolean(),
  intended_agent: z.string().nullable(),
});

/** What the embedded select returns per row; `tests` is an object for a many-to-one `!inner`. */
const rawBrowserRowSchema = z.object({
  id: z.string(),
  test_id: z.string(),
  row_index: z.number().int(),
  prompt: z.string(),
  prompt_category: z.string().nullable(),
  expected_tool: z.string().nullable(),
  minimum_concepts: z.array(z.string()),
  expected_concepts: z.array(z.string()),
  question_category: z.string().nullable(),
  tests: z.union([embeddedTestSchema, z.array(embeddedTestSchema)]),
});

const BROWSER_SELECT =
  'id, test_id, row_index, prompt, prompt_category, expected_tool, minimum_concepts, expected_concepts, ' +
  'question_category:input_payload->>question_category, ' +
  'tests!inner(id, name, is_golden, is_archived, intended_agent)';

function toBrowserRow(raw: z.infer<typeof rawBrowserRowSchema>): TestItemsBrowserRow {
  const test = Array.isArray(raw.tests) ? raw.tests[0] : raw.tests;
  if (!test) {
    throw new Error(`test_items.${raw.id} returned without its tests!inner embed`);
  }
  return testItemsBrowserRowSchema.parse({
    id: raw.id,
    testId: raw.test_id,
    testName: test.name,
    testIsGolden: test.is_golden,
    testIsArchived: test.is_archived,
    intendedAgent: test.intended_agent,
    rowIndex: raw.row_index,
    prompt: raw.prompt,
    promptCategory: raw.prompt_category,
    questionCategory: raw.question_category,
    minimumConceptCount: raw.minimum_concepts.length,
    expectedConceptCount: raw.expected_concepts.length,
    expectedTool: raw.expected_tool,
  });
}

/**
 * One page of items across every test set, plus the exact total for the same filters.
 *
 * Counts first (a `head` request) and clamps the requested page to the last one: PostgREST
 * answers a `.range()` that starts past the end with 416, so a stale `?page=` would otherwise
 * surface as a load error instead of the last page.
 *
 * Ordered by `test_id` then `row_index` — PostgREST cannot order a top-level result by an
 * embedded column (`tests.name`), and this keeps a set's rows together in CSV order.
 */
export async function listTestItemsAcrossTests(
  filters: TestItemsBrowserFilters,
  paging: { page: number; pageSize?: number },
): Promise<TestItemsBrowserPage> {
  const supabase = getSupabaseServiceRoleClient();
  const pageSize = Math.max(1, Math.min(paging.pageSize ?? TEST_ITEMS_BROWSER_PAGE_SIZE, 1000));
  const predicates = buildTestItemsBrowserPredicates(filters);

  const countResult = await applyPredicates(
    supabase.from('test_items').select('id, tests!inner(id)', { count: 'exact', head: true }),
    predicates,
  );
  if (countResult.error) {
    throw new Error(countResult.error.message);
  }
  const total = countResult.count ?? 0;

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, paging.page), lastPage);
  if (total === 0) {
    return { rows: [], total, page, pageSize };
  }

  const from = (page - 1) * pageSize;
  const result = await applyPredicates(supabase.from('test_items').select(BROWSER_SELECT), predicates)
    .order('test_id', { ascending: true })
    .order('row_index', { ascending: true })
    .range(from, from + pageSize - 1);

  if (result.error) {
    throw new Error(result.error.message);
  }

  const rows = z.array(rawBrowserRowSchema).parse(result.data ?? []).map(toBrowserRow);

  return { rows, total, page, pageSize };
}

/**
 * Distinct `input_payload->>question_category` values within the golden/all scope, sorted
 * case-insensitively. The value is free text written by whoever authored the CSV (58 distinct
 * values across 114 golden items today), so the options come from the data, not a constant.
 */
export async function listQuestionCategoryOptions(
  filters: Pick<TestItemsBrowserFilters, 'goldenOnly'>,
): Promise<string[]> {
  const supabase = getSupabaseServiceRoleClient();
  const predicates = buildTestItemsScopePredicates(filters);
  const rowSchema = z.object({ question_category: z.string().nullable() });

  const values = new Set<string>();
  for (let pageIndex = 0; pageIndex < OPTION_SCAN_MAX_PAGES; pageIndex += 1) {
    const from = pageIndex * OPTION_SCAN_PAGE_SIZE;
    const result = await applyPredicates(
      supabase
        .from('test_items')
        .select('question_category:input_payload->>question_category, tests!inner(id)'),
      predicates,
    )
      .order('id', { ascending: true })
      .range(from, from + OPTION_SCAN_PAGE_SIZE - 1);

    const rows = z.array(rowSchema).parse(assertNoError(result) ?? []);
    for (const row of rows) {
      const value = row.question_category?.trim();
      if (value) {
        values.add(value);
      }
    }
    if (rows.length < OPTION_SCAN_PAGE_SIZE) {
      break;
    }
  }

  return [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/**
 * Sets for the "Test set" dropdown, A→Z. Golden scope lists only non-archived golden sets so the
 * dropdown never offers a set the page's default predicates would hide.
 */
export async function listTestFilterOptions(
  filters: Pick<TestItemsBrowserFilters, 'goldenOnly'>,
): Promise<TestFilterOption[]> {
  const supabase = getSupabaseServiceRoleClient();
  let query = supabase.from('tests').select('id, name, is_golden, is_archived');
  if (filters.goldenOnly) {
    query = query.eq('is_golden', true).eq('is_archived', false);
  }
  const result = await query.order('name', { ascending: true });
  const rows = z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        is_golden: z.boolean(),
        is_archived: z.boolean(),
      }),
    )
    .parse(assertNoError(result) ?? []);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    isGolden: row.is_golden,
    isArchived: row.is_archived,
  }));
}
