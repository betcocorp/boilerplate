import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import { COMPLETED_RUN_STATUSES } from './types';

/**
 * B0-572 / B0-575 — THE reader for gating-golden-set membership and per-tier rollups.
 *
 * Every tier rollup, tier card, and the verdict strip must consume these functions — no
 * ad-hoc `tests`/`test_items` joins in pages or components. Membership is defined by
 * `public.tests.is_golden = true` (an audited admin toggle, see `setTestGoldenAction`);
 * tier membership is `test_items.priority` (1 | 2 | 3).
 *
 * DATA-ERROR RULE: a golden-set item with a NULL priority is a data error. It is always
 * REPORTED (`membership.missingPriority`) and never silently dropped from a denominator —
 * its graded rows are counted separately (`rollup.resultRowsOnMissingPriorityItems`), never
 * folded into a tier's figures.
 *
 * ## Version → run resolution rule (B0-575)
 * For a given version (and optional window), the run that represents a golden test is the
 * MOST RECENT completed run (`test_results.status` in `COMPLETED_RUN_STATUSES`,
 * `run_mode = 'full'`) of that test whose `app_version` matches:
 *   - `version: string`  — exactly that version;
 *   - `version: null`    — the "unversioned" bucket (`app_version IS NULL`, pre-B0-472 rows;
 *                          NO backfill — these must never be attributed to a real version);
 *   - `version` omitted  — any version (the latest completed run per test, whatever it ran on).
 * One run per golden test. If NO golden test has a matching run, the result is the explicit
 * `{ kind: 'no_golden_run_for_version' }` shape — never 0%, and never another version's rows.
 *
 * ## Golden origin of a non-golden test's items (B0-750)
 * `computeGoldenSetItemOrigins` flags items of ANY test that belong to a golden set, by two
 * rules: **lineage** — `test_items.metadata.derived_from_test_id` (written by "Create new
 * test from prompts") names a golden test; **prompt** — the item's normalized prompt
 * (`trim().toLowerCase()`) exists verbatim in a golden test. Prompt-match exists because
 * origin sets get archived / un-goldened while their prompts live on in curated golden sets,
 * so lineage alone under-counts. Membership is still `tests.is_golden = true` — nothing else.
 *
 * ## Why this folds rows in Node instead of a Postgres RPC
 * Golden sets are a deliberately small, curated subset (hundreds of items, a handful of
 * runs per version), so the scans here are a few pages at most — same reasoning as
 * `~/lib/observability/aggregates.ts`. Documented trigger for change: if the golden-set
 * scans ever exceed `MAX_SCAN_PAGES * SCAN_PAGE_SIZE` rows, or this reader becomes a
 * visible source of latency on /admin/tests, replace the scans with a Postgres RPC
 * following the `admin_latest_failures_*` precedent rather than growing the budget here.
 */

/** PostgREST caps a request at 1000 rows; sweep in pages of that size. */
const SCAN_PAGE_SIZE = 1000;
const MAX_SCAN_PAGES = 20;

export const GOLDEN_TIERS = [1, 2, 3] as const;
export type GoldenTier = (typeof GOLDEN_TIERS)[number];

export function isGoldenTier(value: number | null): value is GoldenTier {
  return value === 1 || value === 2 || value === 3;
}

export type GoldenSetTest = {
  id: string;
  name: string;
  rowCount: number;
};

/** One golden-set item missing its required priority — a visible data error, never dropped. */
export type GoldenSetMissingPriorityItem = {
  testId: string;
  testName: string;
  testItemId: string;
  rowIndex: number;
  prompt: string;
};

export type GoldenSetMembership = {
  goldenTests: GoldenSetTest[];
  /** All items across golden tests, including those missing a priority. */
  totalItems: number;
  itemCountByTier: Record<GoldenTier, number>;
  /** Data errors: golden-set items with NULL priority. Report, never silently exclude. */
  missingPriority: GoldenSetMissingPriorityItem[];
};

export type GoldenSetRollupQuery = {
  /**
   * `string` = that exact app_version; `null` = the unversioned bucket
   * (`app_version IS NULL`); omitted = any version. See the resolution rule above.
   */
  version?: string | null;
  /** ISO timestamps, inclusive, applied to `test_results.created_at`. */
  window?: { from: string; to: string };
};

export type GoldenTierRollup = {
  tier: GoldenTier;
  /** Membership size for the tier (item count), independent of any run. */
  itemCount: number;
  /** Result rows counted for the tier in the resolved runs. */
  gradedCount: number;
  passedCount: number;
  /** `null` when gradedCount is 0 — "no data" is not 0%. */
  passRate: number | null;
};

export type GoldenSetResolvedRun = {
  testId: string;
  runId: string;
  appVersion: string | null;
  createdAt: string;
};

export type GoldenSetRollupResult =
  | { kind: 'no_golden_sets' }
  | {
      /** No golden test has a completed run matching the version/window — explicit, never 0%. */
      kind: 'no_golden_run_for_version';
      version: string | null | undefined;
      membership: GoldenSetMembership;
    }
  | {
      kind: 'rollup';
      membership: GoldenSetMembership;
      tiers: GoldenTierRollup[];
      resolvedRuns: GoldenSetResolvedRun[];
      /**
       * B0-575 — golden-run result rows with NULL `app_version` inside the query window
       * (pre-B0-472 harness rows). Reported as unattributed; never backfilled and never
       * counted into a specific version's figures.
       */
      unattributedResultItemCount: number;
      /** Graded rows on missing-priority items — surfaced, never folded into a tier. */
      resultRowsOnMissingPriorityItems: number;
    };

// ---------------------------------------------------------------------------
// Pure computation (unit-tested without a database)
// ---------------------------------------------------------------------------

export type GoldenTestRow = { id: string; name: string; row_count: number };
export type GoldenItemRow = {
  id: string;
  test_id: string;
  row_index: number;
  prompt: string;
  priority: number | null;
};
export type GoldenRunRow = {
  id: string;
  test_id: string;
  app_version: string | null;
  created_at: string;
};
export type GoldenResultItemRow = {
  test_result_id: string;
  test_item_id: string;
  passed: boolean;
  app_version: string | null;
};

export function computeGoldenSetMembership(
  tests: GoldenTestRow[],
  items: GoldenItemRow[],
): GoldenSetMembership {
  const testNameById = new Map(tests.map((test) => [test.id, test.name]));
  const itemCountByTier: Record<GoldenTier, number> = { 1: 0, 2: 0, 3: 0 };
  const missingPriority: GoldenSetMissingPriorityItem[] = [];

  for (const item of items) {
    if (isGoldenTier(item.priority)) {
      itemCountByTier[item.priority] += 1;
    } else {
      missingPriority.push({
        testId: item.test_id,
        testName: testNameById.get(item.test_id) ?? 'Unknown test',
        testItemId: item.id,
        rowIndex: item.row_index,
        prompt: item.prompt,
      });
    }
  }

  return {
    goldenTests: tests.map((test) => ({
      id: test.id,
      name: test.name,
      rowCount: test.row_count,
    })),
    totalItems: items.length,
    itemCountByTier,
    missingPriority,
  };
}

/**
 * The resolution rule as code: latest matching completed run per golden test.
 * `runs` must already be completed, `run_mode = 'full'`, and window-filtered;
 * the version filter is applied here.
 */
export function resolveGoldenRunsForVersion(
  runs: GoldenRunRow[],
  version: string | null | undefined,
): Map<string, GoldenRunRow> {
  const latestByTestId = new Map<string, GoldenRunRow>();
  for (const run of runs) {
    if (version === null && run.app_version !== null) continue;
    if (typeof version === 'string' && run.app_version !== version) continue;
    const current = latestByTestId.get(run.test_id);
    if (!current || run.created_at > current.created_at) {
      latestByTestId.set(run.test_id, run);
    }
  }
  return latestByTestId;
}

export function computeGoldenSetRollup(input: {
  tests: GoldenTestRow[];
  items: GoldenItemRow[];
  /** Completed, full-mode, window-filtered candidate runs of the golden tests. */
  runs: GoldenRunRow[];
  /** Result rows belonging to `runs` (all of them, not just the resolved ones). */
  resultItems: GoldenResultItemRow[];
  query: GoldenSetRollupQuery;
}): GoldenSetRollupResult {
  if (input.tests.length === 0) {
    return { kind: 'no_golden_sets' };
  }

  const membership = computeGoldenSetMembership(input.tests, input.items);
  const resolved = resolveGoldenRunsForVersion(input.runs, input.query.version);

  if (resolved.size === 0) {
    return {
      kind: 'no_golden_run_for_version',
      version: input.query.version,
      membership,
    };
  }

  const resolvedRunIds = new Set([...resolved.values()].map((run) => run.id));
  const tierByItemId = new Map<string, GoldenTier | null>(
    input.items.map((item) => [item.id, isGoldenTier(item.priority) ? item.priority : null]),
  );

  const tiers: GoldenTierRollup[] = GOLDEN_TIERS.map((tier) => ({
    tier,
    itemCount: membership.itemCountByTier[tier],
    gradedCount: 0,
    passedCount: 0,
    passRate: null,
  }));
  const tierRollupByTier = new Map(tiers.map((rollup) => [rollup.tier, rollup]));

  let unattributedResultItemCount = 0;
  let resultRowsOnMissingPriorityItems = 0;

  for (const row of input.resultItems) {
    // Unattributed count is over ALL golden runs in the window, not just resolved ones —
    // it reports the size of the pre-versioning blind spot, not a per-version figure.
    if (row.app_version === null) {
      unattributedResultItemCount += 1;
    }

    if (!resolvedRunIds.has(row.test_result_id)) continue;
    if (!tierByItemId.has(row.test_item_id)) continue; // row for an item since deleted

    const tier = tierByItemId.get(row.test_item_id) ?? null;
    if (tier === null) {
      // Missing-priority item: surfaced, never folded into a tier's denominator.
      resultRowsOnMissingPriorityItems += 1;
      continue;
    }

    const rollup = tierRollupByTier.get(tier)!;
    rollup.gradedCount += 1;
    if (row.passed) {
      rollup.passedCount += 1;
    }
  }

  for (const rollup of tiers) {
    rollup.passRate = rollup.gradedCount > 0 ? rollup.passedCount / rollup.gradedCount : null;
  }

  return {
    kind: 'rollup',
    membership,
    tiers,
    resolvedRuns: [...resolved.values()].map((run) => ({
      testId: run.test_id,
      runId: run.id,
      appVersion: run.app_version,
      createdAt: run.created_at,
    })),
    unattributedResultItemCount,
    resultRowsOnMissingPriorityItems,
  };
}

// --- Golden origin of items in a (possibly non-golden) test (B0-750) ---

export type GoldenOriginRule = 'lineage' | 'prompt';

export type GoldenSetItemOrigin = {
  /** Golden tests this item was matched to, deduped, in `goldenTests` order. */
  goldenTests: Array<{ id: string; name: string }>;
  /** Which rule(s) matched, 'lineage' first. */
  rules: GoldenOriginRule[];
};

export type GoldenOriginCandidateItem = { id: string; prompt: string; metadata: unknown };

export function normalizeGoldenPrompt(prompt: string): string {
  return prompt.trim().toLowerCase();
}

/** Safe read of `test_items.metadata.derived_from_test_id`; any non-object / missing shape is "no lineage". */
export function readDerivedFromTestId(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const raw = (metadata as Record<string, unknown>).derived_from_test_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Keyed by `item.id`; ONLY items that matched at least one rule are present. Callers pass the
 * items of the page's own test — an item whose own test is golden is not special-cased here.
 */
export function computeGoldenSetItemOrigins(
  items: GoldenOriginCandidateItem[],
  goldenTests: GoldenTestRow[],
  goldenItems: GoldenItemRow[],
): Map<string, GoldenSetItemOrigin> {
  const origins = new Map<string, GoldenSetItemOrigin>();
  if (items.length === 0 || goldenTests.length === 0) {
    return origins;
  }

  const goldenTestById = new Map(goldenTests.map((test) => [test.id, test]));
  const goldenTestIdsByPrompt = new Map<string, Set<string>>();
  for (const goldenItem of goldenItems) {
    if (!goldenTestById.has(goldenItem.test_id)) continue;
    const key = normalizeGoldenPrompt(goldenItem.prompt);
    const set = goldenTestIdsByPrompt.get(key);
    if (set) {
      set.add(goldenItem.test_id);
    } else {
      goldenTestIdsByPrompt.set(key, new Set([goldenItem.test_id]));
    }
  }

  for (const item of items) {
    const matchedTestIds = new Set<string>();
    const rules: GoldenOriginRule[] = [];

    const lineageTestId = readDerivedFromTestId(item.metadata);
    if (lineageTestId !== null && goldenTestById.has(lineageTestId)) {
      matchedTestIds.add(lineageTestId);
      rules.push('lineage');
    }

    const promptTestIds = goldenTestIdsByPrompt.get(normalizeGoldenPrompt(item.prompt));
    if (promptTestIds && promptTestIds.size > 0) {
      for (const testId of promptTestIds) matchedTestIds.add(testId);
      rules.push('prompt');
    }

    if (rules.length === 0) continue;

    origins.set(item.id, {
      // Emit in `goldenTests` order so the tooltip is stable across renders.
      goldenTests: goldenTests
        .filter((test) => matchedTestIds.has(test.id))
        .map((test) => ({ id: test.id, name: test.name })),
      rules,
    });
  }

  return origins;
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

async function fetchAllPages<T>(
  fetcher: (from: number, to: number) => PromiseLike<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    const rows = await fetcher(start, start + SCAN_PAGE_SIZE - 1);
    all.push(...rows);
    if (rows.length < SCAN_PAGE_SIZE) break;
  }
  return all;
}

/**
 * Golden-set roster (`is_golden = true`). Archiving a test never clears `is_golden`, so a test
 * can be golden AND archived.
 *
 * - Default (`includeArchived: true`) returns archived and active golden tests alike — this is
 *   the historical behavior every existing caller (membership, tier rollups, trends, the nightly
 *   sweep) relies on; do not change it under them.
 * - `{ includeArchived: false }` (B0-881) is the path bulk-run triggers (B0-883 "Run Golden") use
 *   so an archived-but-golden set never gets a new run burned on it.
 *
 * Naming note: this deliberately differs from `repository.ts`'s `listTests(includeArchived)`,
 * whose `true` means "archived ONLY". Here `true` means "archived too".
 */
export async function listGoldenTests(
  options: { includeArchived?: boolean } = {},
): Promise<GoldenTestRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  let query = supabase.from('tests').select('id, name, row_count').eq('is_golden', true);
  if (options.includeArchived === false) {
    query = query.eq('is_archived', false);
  }
  const result = await query.order('name', { ascending: true });
  return (assertNoError(result) ?? []) as GoldenTestRow[];
}

export async function listGoldenItems(testIds: string[]): Promise<GoldenItemRow[]> {
  if (testIds.length === 0) return [];
  const supabase = getSupabaseServiceRoleClient();
  return fetchAllPages<GoldenItemRow>((from, to) =>
    supabase
      .from('test_items')
      .select('id, test_id, row_index, prompt, priority')
      .in('test_id', testIds)
      .order('id', { ascending: true })
      .range(from, to)
      .then((r) => (assertNoError(r) ?? []) as GoldenItemRow[]),
  );
}

/** Completed full-mode runs of the golden tests, optionally window-filtered. */
export async function listGoldenCandidateRuns(
  testIds: string[],
  window?: { from: string; to: string },
): Promise<GoldenRunRow[]> {
  if (testIds.length === 0) return [];
  const supabase = getSupabaseServiceRoleClient();
  return fetchAllPages<GoldenRunRow>((from, to) => {
    let query = supabase
      .from('test_results')
      .select('id, test_id, app_version, created_at')
      .in('test_id', testIds)
      .eq('run_mode', 'full')
      .in('status', [...COMPLETED_RUN_STATUSES])
      .order('created_at', { ascending: false });
    if (window) {
      query = query.gte('created_at', window.from).lte('created_at', window.to);
    }
    return query
      .range(from, to)
      .then((r) => (assertNoError(r) ?? []) as GoldenRunRow[]);
  });
}

/** Exported (B0-466) so `~/lib/tests/golden-set-run-series.ts` reads result rows through this reader. */
export async function listResultItemsForRuns(runIds: string[]): Promise<GoldenResultItemRow[]> {
  if (runIds.length === 0) return [];
  const supabase = getSupabaseServiceRoleClient();
  return fetchAllPages<GoldenResultItemRow>((from, to) =>
    supabase
      .from('test_result_items')
      .select('test_result_id, test_item_id, passed, app_version')
      .in('test_result_id', runIds)
      .order('id', { ascending: true })
      .range(from, to)
      .then((r) => (assertNoError(r) ?? []) as GoldenResultItemRow[]),
  );
}

/** Membership only (no runs): the /admin/tests validation surface and tier cards' item counts. */
export async function getGoldenSetMembership(): Promise<GoldenSetMembership> {
  const tests = await listGoldenTests();
  const items = await listGoldenItems(tests.map((test) => test.id));
  return computeGoldenSetMembership(tests, items);
}

/**
 * B0-750 — golden origin for the items of one (possibly non-golden) test; see the module doc
 * for the two rules. Empty Map when there are no items or no golden tests.
 */
export async function resolveGoldenSetItemOrigins(
  items: GoldenOriginCandidateItem[],
): Promise<Map<string, GoldenSetItemOrigin>> {
  if (items.length === 0) {
    return new Map();
  }
  const tests = await listGoldenTests();
  if (tests.length === 0) {
    return new Map();
  }
  const goldenItems = await listGoldenItems(tests.map((test) => test.id));
  return computeGoldenSetItemOrigins(items, tests, goldenItems);
}

/**
 * THE single rollup entry point (B0-572 AC): golden-set membership, per-tier item counts,
 * and per-tier pass rates for a given version/window, plus the missing-priority validation
 * list and the unattributed (NULL app_version) row count. See the module doc for the
 * version → run resolution rule and the empty-state shapes.
 */
export async function getGoldenSetTierRollup(
  query: GoldenSetRollupQuery = {},
): Promise<GoldenSetRollupResult> {
  const tests = await listGoldenTests();
  if (tests.length === 0) {
    return { kind: 'no_golden_sets' };
  }

  const testIds = tests.map((test) => test.id);
  const [items, runs] = await Promise.all([
    listGoldenItems(testIds),
    listGoldenCandidateRuns(testIds, query.window),
  ]);
  const resultItems = await listResultItemsForRuns(runs.map((run) => run.id));

  return computeGoldenSetRollup({ tests, items, runs, resultItems, query });
}
