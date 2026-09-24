import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { hasBexSession } from '~/lib/api/bex-api-auth';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'GET /api/admin/tests/prompt-search';

/** Rows handed back to the search dialog. */
const RESULT_LIMIT = 20;
/** Candidate pool from `test_items` before the golden filter (when applied) trims it down. */
const CANDIDATE_LIMIT = 60;

const promptSearchParamsSchema = z.object({
  q: z.string().min(2).max(120),
  goldenOnly: z.coerce.boolean().default(true),
});

type TestItemRow = {
  id: string;
  prompt: string;
  test_id: string;
};

type TestRow = {
  id: string;
  name: string;
  is_golden: boolean;
};

type ResultRow = {
  testItemId: string;
  prompt: string;
  testId: string;
  testName: string;
  isGolden: boolean;
  latestRunId: string | null;
};

/**
 * PostgREST parses `ilike.(…)` filter values through the same comma/paren/quote-sensitive grammar
 * as `or=(…)`, so a comma, parenthesis, quote or backslash in the typed text would change the
 * filter rather than be searched for. They are stripped instead of escaped — this is a search box,
 * not stored data. Copied from `~/app/api/admin/rag/document-search/route.ts`.
 */
function likePattern(raw: string): string {
  const cleaned = raw.replace(/[,()"\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? `%${cleaned}%` : '';
}

/**
 * GET /api/admin/tests/prompt-search
 *
 * B0-1080 — search across every prompt ever entered into `public.test_items`, not scoped to the
 * currently viewed test set, and resolve each match to its latest associated trace run so the
 * admin can jump straight to `/admin/observability/[runId]`.
 *
 * Auth is the same Bex UI pattern as the rest of `/admin/tests` and its sibling
 * `document-search` route: the NextAuth session (`hasBexSession`) plus the sidebar-tests
 * permission gate.
 */
export async function GET(request: NextRequest) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(PERMISSIONS.NAVIGATION_SIDEBAR_TESTS, ROUTE);
  if (denied) return denied;

  const rawQuery = request.nextUrl.searchParams.get('q');
  const rawGoldenOnly = request.nextUrl.searchParams.get('goldenOnly');

  const parsed = promptSearchParamsSchema.safeParse({
    q: rawQuery === null ? undefined : rawQuery,
    goldenOnly: rawGoldenOnly === null ? undefined : rawGoldenOnly,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid search parameters', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const pattern = likePattern(parsed.data.q);
  if (!pattern) {
    return NextResponse.json({ results: [] });
  }

  const supabase = getSupabaseServiceRoleClient();

  try {
    const { data: itemRows, error: itemsError } = await supabase
      .from('test_items')
      .select('id, prompt, test_id')
      .ilike('prompt', pattern)
      .limit(CANDIDATE_LIMIT);

    if (itemsError) {
      throw new Error(itemsError.message);
    }

    const items = (itemRows ?? []) as TestItemRow[];
    if (items.length === 0) {
      return NextResponse.json({ results: [] });
    }

    const testIds = [...new Set(items.map((item) => item.test_id))];
    const { data: testRowsData, error: testsError } = await supabase
      .from('tests')
      .select('id, name, is_golden')
      .in('id', testIds);

    if (testsError) {
      throw new Error(testsError.message);
    }

    const testsById = new Map(
      ((testRowsData ?? []) as TestRow[]).map((test) => [test.id, test]),
    );

    const eligibleItems = items
      .map((item) => ({ item, test: testsById.get(item.test_id) }))
      .filter(
        (
          entry,
        ): entry is { item: TestItemRow; test: TestRow } =>
          entry.test !== undefined &&
          (!parsed.data.goldenOnly || entry.test.is_golden),
      )
      .slice(0, RESULT_LIMIT);

    if (eligibleItems.length === 0) {
      return NextResponse.json({ results: [] });
    }

    const eligibleItemIds = eligibleItems.map((entry) => entry.item.id);

    // Single batched query for the latest run per matched prompt, instead of an N+1 lookup per
    // item — mirrors `getPromptHistoryForItem` (`~/lib/observability/prompt-history.ts`), but that
    // helper is scoped to one `test_item_id` at a time, so its query shape is replicated here
    // rather than reused in a loop.
    const { data: resultItemRows, error: resultItemsError } = await supabase
      .from('test_result_items')
      .select('test_item_id, workflow_run_id, created_at')
      .in('test_item_id', eligibleItemIds)
      .order('created_at', { ascending: false });

    // Null-safe like `getPromptHistoryForItem`: a failed lookup degrades every row to "no trace
    // yet" instead of failing the whole search.
    const latestRunByItemId = new Map<string, string>();
    if (!resultItemsError) {
      for (const row of (resultItemRows ?? []) as {
        test_item_id: string;
        workflow_run_id: string | null;
        created_at: string;
      }[]) {
        if (
          row.workflow_run_id &&
          !latestRunByItemId.has(row.test_item_id)
        ) {
          latestRunByItemId.set(row.test_item_id, row.workflow_run_id);
        }
      }
    }

    const results: ResultRow[] = eligibleItems.map(({ item, test }) => ({
      testItemId: item.id,
      prompt: item.prompt,
      testId: item.test_id,
      testName: test.name,
      isGolden: test.is_golden,
      latestRunId: latestRunByItemId.get(item.id) ?? null,
    }));

    return NextResponse.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Prompt search failed', details: message },
      { status: 500 },
    );
  }
}
