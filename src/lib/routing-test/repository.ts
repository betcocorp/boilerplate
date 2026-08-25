import type { SupabaseClient } from '@supabase/supabase-js';

import { createEmbedding } from '~/lib/rag/embeddings';
import { assertSupabaseNoError as assertNoError, withRetry } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { Json } from '~/types/supabase.public';

import type {
  RoutingTestItemRecord,
  RoutingTestRunItemRecord,
  RoutingTestRunRecord,
  RoutingTestRunResult,
} from './types';

/**
 * `public.routing_test_items` (B0-657) and `public.routing_test_runs` /
 * `public.routing_test_run_items` (B0-667) are all newer than the checked-in generated types
 * (`src/types/supabase.public.ts`), so this module narrows the shared service-role client to
 * locally declared table definitions rather than regenerating a shared file. Remove this shim and
 * lean on the generated `Database` type after the next `pnpm run types:supabase:public`.
 */
type RoutingTestDatabase = {
  public: {
    Tables: {
      routing_test_items: {
        Row: RoutingTestItemRecord;
        Insert: {
          id?: string;
          prompt: string;
          expected_agent: string;
          embedding_large?: number[] | string | null;
          embedding_model_large?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          prompt?: string;
          expected_agent?: string;
          embedding_large?: number[] | string | null;
          embedding_model_large?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      routing_test_runs: {
        Row: RoutingTestRunRecord;
        Insert: {
          id?: string;
          router_type: string;
          ran_at: string;
          total_items?: number;
          passed_items?: number;
          degraded_items?: number;
          duration_ms?: number;
          avg_item_duration_ms?: number | null;
          warning?: string | null;
          /** B0-671 — resolved model id an `llm` run called, null otherwise. */
          model?: string | null;
          created_at?: string;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      routing_test_run_items: {
        Row: RoutingTestRunItemRecord;
        Insert: {
          id?: string;
          run_id: string;
          item_id?: string | null;
          row_index: number;
          prompt: string;
          expected_agent: string;
          predicted_agent: string;
          passed: boolean;
          error?: string | null;
          elapsed_ms: number;
          detail?: Json | null;
          created_at?: string;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};

function routingTestClient(): SupabaseClient<
  RoutingTestDatabase,
  'public'
> {
  return getSupabaseServiceRoleClient() as unknown as SupabaseClient<
    RoutingTestDatabase,
    'public'
  >;
}

/** The whole flat list, oldest first — the routing test is a single small singleton set. */
export async function listRoutingTestItems(): Promise<RoutingTestItemRecord[]> {
  const result = await routingTestClient()
    .from('routing_test_items')
    .select('*')
    .order('created_at', { ascending: true });

  return (assertNoError(result) ?? []) as RoutingTestItemRecord[];
}

export async function getRoutingTestItemById(
  id: string,
): Promise<RoutingTestItemRecord | null> {
  const result = await routingTestClient()
    .from('routing_test_items')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  return (assertNoError(result) ?? null) as RoutingTestItemRecord | null;
}

function toVectorLiteral(embedding: number[]) {
  return `[${embedding.join(',')}]`;
}

/**
 * B0-669 — embed a routing-test-item `prompt` via `createEmbedding` (`~/lib/rag/embeddings.ts`),
 * wrapped in `withRetry` the same way the batch chunk path wraps its OpenAI calls. On failure
 * (even after retries) this swallows and structured-logs rather than throwing, so a flaky
 * embeddings call never blocks saving the item — callers get both columns back as `null`, which
 * mirrors the `is distinct from → null` idiom `rag.document_chunk` uses for stale-embedding
 * handling.
 */
async function embedRoutingTestPrompt(
  prompt: string,
): Promise<{ embedding_large: string | null; embedding_model_large: string | null }> {
  try {
    const { embedding, model } = await withRetry(() => createEmbedding(prompt));
    return { embedding_large: toVectorLiteral(embedding), embedding_model_large: model };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'routing_test_item_embedding_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return { embedding_large: null, embedding_model_large: null };
  }
}

/**
 * B0-669 — always embeds the new `prompt` (via `embedRoutingTestPrompt`) and stores
 * `embedding_large`/`embedding_model_large` alongside the row. A failed embedding still lets the
 * item save, with both columns `null`.
 */
export async function insertRoutingTestItem(values: {
  prompt: string;
  expected_agent: string;
}): Promise<RoutingTestItemRecord> {
  const embedding = await embedRoutingTestPrompt(values.prompt);

  const result = await routingTestClient()
    .from('routing_test_items')
    .insert({ ...values, ...embedding })
    .select('*')
    .single();

  return assertNoError(result) as RoutingTestItemRecord;
}

/**
 * `updated_at` is maintained by `trg_routing_test_items_updated_at` (same trigger function as
 * `public.tests`), so callers never set it.
 *
 * B0-669 — reads the current row first (rather than requiring the caller to thread the prior
 * prompt through) so it can tell whether `prompt` actually changed. `embedding_large`/
 * `embedding_model_large` are only ever included in the update payload when the trimmed incoming
 * prompt differs from the stored one; an `expected_agent`-only edit omits both keys entirely, so
 * they are left completely untouched rather than re-written to their existing value.
 */
export async function updateRoutingTestItem(
  id: string,
  values: { prompt: string; expected_agent: string },
): Promise<RoutingTestItemRecord | null> {
  const current = await getRoutingTestItemById(id);
  if (!current) {
    return null;
  }

  const trimmedPrompt = values.prompt.trim();
  const promptChanged = trimmedPrompt !== current.prompt;

  const updateValues: {
    prompt: string;
    expected_agent: string;
    embedding_large?: string | null;
    embedding_model_large?: string | null;
  } = { prompt: values.prompt, expected_agent: values.expected_agent };

  if (promptChanged) {
    const embedding = await embedRoutingTestPrompt(trimmedPrompt);
    updateValues.embedding_large = embedding.embedding_large;
    updateValues.embedding_model_large = embedding.embedding_model_large;
  }

  const result = await routingTestClient()
    .from('routing_test_items')
    .update(updateValues)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  return (assertNoError(result) ?? null) as RoutingTestItemRecord | null;
}

/** `true` when a row was actually removed, `false` when the id did not exist. */
export async function deleteRoutingTestItem(id: string): Promise<boolean> {
  const result = await routingTestClient()
    .from('routing_test_items')
    .delete()
    .eq('id', id)
    .select('id');

  const rows = (assertNoError(result) ?? []) as { id: string }[];
  return rows.length > 0;
}

/**
 * B0-667 — persist one `ok: true` run: the `routing_test_runs` header row, then every item's
 * `routing_test_run_items` snapshot in original order (`row_index` = position in `run.items`,
 * which `runRoutingTest`/`mapWithConcurrency` always preserve). `run.summary` already carries
 * `durationMs`/`avgItemDurationMs` (computed once, in `computeRoutingTestSummary`), so there is no
 * second timing input to reconcile here.
 *
 * Callers (`runRoutingTestAction`) treat this as a best-effort side effect — a thrown error here
 * must not blow up the live, ephemeral result the workbench is waiting on.
 */
export async function insertRoutingTestRun(
  run: RoutingTestRunResult & { ok: true },
): Promise<RoutingTestRunRecord> {
  const client = routingTestClient();

  const runResult = await client
    .from('routing_test_runs')
    .insert({
      router_type: run.routerType,
      ran_at: run.ranAt,
      total_items: run.summary.total,
      passed_items: run.summary.correct,
      degraded_items: run.summary.degraded,
      duration_ms: run.summary.durationMs,
      avg_item_duration_ms: run.summary.avgItemDurationMs,
      warning: run.warning,
      model: run.model,
    })
    .select('*')
    .single();

  const insertedRun = assertNoError(runResult) as RoutingTestRunRecord;

  if (run.items.length > 0) {
    const itemRows = run.items.map((item, index) => ({
      run_id: insertedRun.id,
      item_id: item.itemId,
      row_index: index,
      prompt: item.prompt,
      expected_agent: item.expectedAgent,
      predicted_agent: item.predicted,
      passed: item.passed,
      error: item.error,
      elapsed_ms: item.elapsedMs,
      detail: item.detail as Json | null,
    }));

    const itemsResult = await client
      .from('routing_test_run_items')
      .insert(itemRows);

    assertNoError(itemsResult);
  }

  return insertedRun;
}

/** Run history, newest first — no joins, just the header rows for the history table. */
export async function listRoutingTestRuns(): Promise<RoutingTestRunRecord[]> {
  const result = await routingTestClient()
    .from('routing_test_runs')
    .select('*')
    .order('ran_at', { ascending: false });

  return (assertNoError(result) ?? []) as RoutingTestRunRecord[];
}

/** One run plus its item-level snapshots (`row_index` ascending), or `null` if the id is unknown. */
export async function getRoutingTestRunWithItems(
  runId: string,
): Promise<{ run: RoutingTestRunRecord; items: RoutingTestRunItemRecord[] } | null> {
  const client = routingTestClient();

  const runResult = await client
    .from('routing_test_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle();

  const run = (assertNoError(runResult) ?? null) as RoutingTestRunRecord | null;
  if (!run) {
    return null;
  }

  const itemsResult = await client
    .from('routing_test_run_items')
    .select('*')
    .eq('run_id', runId)
    .order('row_index', { ascending: true });

  const items = (assertNoError(itemsResult) ?? []) as RoutingTestRunItemRecord[];

  return { run, items };
}
