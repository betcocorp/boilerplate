/**
 * B0-338 — resolves "who asked?" for a workflow run (epic B0-330, Phase 8).
 *
 * Checked in this order for each run:
 *  1. Test harness — the run is joined to a `test_result_items` row via the indexed
 *     `workflow_run_id` column (the same linkage `~/lib/observability/harness-linkage.ts` uses for
 *     the trace page's verdict band), so it is attributed to the specific test, not a generic
 *     "harness" label.
 *  2. Authenticated user — `workflow_runs.conversation_id` -> `agent_conversations.user_id` ->
 *     `app_user`. `user_id` has no FK (plain text match — see
 *     `~/lib/conversations/conversation-repository.ts`'s `listAllConversations`), so the last hop
 *     is a manual second query rather than a PostgREST embed.
 *  3. API client — `workflow_runs.source = 'orchestrator_api'` with no conversation owner.
 *     `api_request_log` carries `app_id` / `project_id` / `key_id` but no `workflow_run_id`, so a
 *     specific app/project cannot be correlated to a specific run today — explicitly out of scope
 *     for B0-338 (would need a new column on the write path). Labeled distinctly rather than
 *     folded into `unknown` so these runs are never mistaken for a plain unattributed one.
 *  4. Unknown — none of the above (pre-instrumentation runs, a deleted conversation, an
 *     unattributed service-token conversation, etc).
 *
 * Read-only, like the rest of `~/lib/observability/**`, and the batch/lookup functions never
 * throw: a lookup failure degrades to `{ kind: 'unknown' }` rather than taking down the runs list
 * or the trace page (mirrors `getHarnessContextForRun`'s never-throws contract).
 */

import { logWarn } from '~/lib/observability/logger';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { RunAttribution, RunSource } from '~/types/observability';

/** The subset of a `workflow_runs` row this module needs to attribute it. */
export type AttributableRun = {
  id: string;
  conversationId: string;
  source: RunSource | null;
};

type TestAttribution = Extract<RunAttribution, { kind: 'test' }>;

/**
 * PostgREST returns an embedded resource as an object or as a single-element array depending on
 * how it infers the relationship's cardinality. Mirrors `harness-linkage.ts`'s helper of the same
 * name (duplicated rather than imported: that module's version is private, and this one only
 * needs to unwrap `!inner` embeds, not the full trace-page mapping).
 */
function firstEmbedded(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Harness attribution for a page of run ids, in one batched query against the indexed
 * `test_result_items.workflow_run_id` column. Mirrors `getHarnessContextForRun` in
 * `harness-linkage.ts` but resolves many runs at once instead of one; when two result items
 * somehow point at the same run, the first one read wins (same tolerance that module documents).
 */
export async function indexHarnessAttributionByRunIds(
  runIds: readonly string[],
): Promise<Map<string, TestAttribution>> {
  const index = new Map<string, TestAttribution>();
  if (runIds.length === 0) {
    return index;
  }

  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('test_result_items')
      .select(
        'workflow_run_id, test_item_id, test_result_id, test_results!inner(id, test_id, tests!inner(id, name))',
      )
      .in('workflow_run_id', [...runIds]);

    if (error) {
      logWarn('run_attribution_harness_lookup_failed', { message: error.message });
      return index;
    }

    for (const row of (data ?? []) as unknown[]) {
      const record = row as Record<string, unknown>;
      const workflowRunId = readString(record, 'workflow_run_id');
      const testItemId = readString(record, 'test_item_id');
      const testResultId = readString(record, 'test_result_id');
      const testResult = firstEmbedded(record.test_results);
      const test = firstEmbedded(testResult?.tests);
      const testId = readString(test, 'id') ?? readString(testResult, 'test_id');
      const testName = readString(test, 'name');

      if (!workflowRunId || !testItemId || !testResultId || !testId || !testName) {
        continue;
      }
      if (!index.has(workflowRunId)) {
        index.set(workflowRunId, { kind: 'test', testId, testName, testResultId, testItemId });
      }
    }
  } catch (error) {
    logWarn('run_attribution_harness_lookup_threw', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return index;
}

/** `agent_conversations.id -> user_id`, for the runs whose owner needs resolving. */
async function indexConversationOwners(
  conversationIds: readonly string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  if (conversationIds.length === 0) {
    return index;
  }

  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('agent_conversations')
      .select('id, user_id')
      .in('id', [...conversationIds]);

    if (error) {
      logWarn('run_attribution_conversation_lookup_failed', { message: error.message });
      return index;
    }

    for (const row of data ?? []) {
      if (row.user_id) {
        index.set(row.id, row.user_id);
      }
    }
  } catch (error) {
    logWarn('run_attribution_conversation_lookup_threw', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return index;
}

/**
 * `app_user.user_id -> { displayName, email }`. `user_id` is a plain text match (no FK), same as
 * `conversation-repository.ts`'s owner joins, so this is a second query rather than an embed.
 */
async function indexUserProfiles(
  userIds: readonly string[],
): Promise<Map<string, { displayName: string | null; email: string | null }>> {
  const index = new Map<string, { displayName: string | null; email: string | null }>();
  if (userIds.length === 0) {
    return index;
  }

  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('app_user')
      .select('user_id, user_name, name, email')
      .in('user_id', [...userIds]);

    if (error) {
      logWarn('run_attribution_user_lookup_failed', { message: error.message });
      return index;
    }

    for (const row of data ?? []) {
      index.set(row.user_id, {
        displayName: row.user_name ?? row.name ?? null,
        email: row.email ?? null,
      });
    }
  } catch (error) {
    logWarn('run_attribution_user_lookup_threw', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return index;
}

/**
 * Resolves `RunAttribution` for a batch of runs in a bounded number of queries — three total
 * (harness index, conversation owners, user profiles), regardless of page size.
 */
export async function resolveRunAttributions(
  runs: readonly AttributableRun[],
): Promise<Map<string, RunAttribution>> {
  const result = new Map<string, RunAttribution>();
  if (runs.length === 0) {
    return result;
  }

  const runIds = runs.map((run) => run.id);
  const conversationIds = [...new Set(runs.map((run) => run.conversationId).filter(Boolean))];

  const [harnessIndex, ownerIndex] = await Promise.all([
    indexHarnessAttributionByRunIds(runIds),
    indexConversationOwners(conversationIds),
  ]);

  const profileIndex = await indexUserProfiles([...new Set(ownerIndex.values())]);

  for (const run of runs) {
    const harness = harnessIndex.get(run.id);
    if (harness) {
      result.set(run.id, harness);
      continue;
    }

    const userId = ownerIndex.get(run.conversationId);
    if (userId) {
      const profile = profileIndex.get(userId);
      result.set(run.id, {
        kind: 'user',
        userId,
        displayName: profile?.displayName ?? null,
        email: profile?.email ?? null,
      });
      continue;
    }

    if (run.source === 'orchestrator_api') {
      result.set(run.id, { kind: 'api_client' });
      continue;
    }

    result.set(run.id, { kind: 'unknown' });
  }

  return result;
}

/** Single-run convenience for the trace page — same resolution, wrapped for one id. */
export async function getRunAttribution(run: AttributableRun): Promise<RunAttribution> {
  const index = await resolveRunAttributions([run]);
  return index.get(run.id) ?? { kind: 'unknown' };
}

/**
 * B0-338 — the runs list "Asked by" filter accepts either an `app_user.user_id` or an email
 * address (friendlier to type than the raw id), so a value containing `@` is resolved to a
 * `user_id` first. Returns `null` when an email is given but matches no `app_user` row, so the
 * caller can render "no runs match" rather than silently filtering by a stale/typo'd id.
 */
export async function resolveUserFilterInput(input: string): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.includes('@')) {
    return trimmed;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('app_user')
    .select('user_id')
    .ilike('email', trimmed)
    .limit(1)
    .maybeSingle();

  if (error) {
    logWarn('run_attribution_user_filter_email_lookup_failed', { message: error.message });
    return null;
  }

  return data?.user_id ?? null;
}

/**
 * `agent_conversations.id`s owned by a given user, for the runs list's "single user" filter.
 * `user_id` carries no index guarantee beyond the plain column, but the table is in the low tens
 * of thousands of rows and this is a single-user equality scan on an internal admin tool.
 */
export async function resolveConversationIdsForUser(userId: string): Promise<string[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_conversations')
    .select('id')
    .eq('user_id', userId);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => row.id);
}

/**
 * `workflow_runs.id`s belonging to one test's runs, for the runs list's "single test" filter. Two
 * bounded queries (`test_results` for the test's runs, `test_result_items` for their workflow run
 * ids) — `tests` has a couple dozen rows and `test_results` under a hundred, so this never
 * approaches PostgREST's page cap.
 */
export async function resolveWorkflowRunIdsForTest(testId: string): Promise<string[]> {
  const supabase = getSupabaseServiceRoleClient();

  const { data: testResults, error: testResultsError } = await supabase
    .from('test_results')
    .select('id')
    .eq('test_id', testId);

  if (testResultsError) {
    throw new Error(testResultsError.message);
  }

  const testResultIds = (testResults ?? []).map((row) => row.id);
  if (testResultIds.length === 0) {
    return [];
  }

  const { data: items, error: itemsError } = await supabase
    .from('test_result_items')
    .select('workflow_run_id')
    .in('test_result_id', testResultIds)
    .not('workflow_run_id', 'is', null);

  if (itemsError) {
    throw new Error(itemsError.message);
  }

  return [
    ...new Set(
      (items ?? [])
        .map((row) => row.workflow_run_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}
