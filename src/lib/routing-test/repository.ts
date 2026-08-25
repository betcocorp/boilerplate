import type { SupabaseClient } from '@supabase/supabase-js';

import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { RoutingTestItemRecord } from './types';

/**
 * `public.routing_test_items` (B0-657) is newer than the checked-in generated types
 * (`src/types/supabase.public.ts`), so this module narrows the shared service-role client to a
 * locally declared table definition rather than regenerating a shared file. Remove this shim and
 * lean on the generated `Database` type after the next `pnpm run types:supabase:public`.
 */
type RoutingTestItemsDatabase = {
  public: {
    Tables: {
      routing_test_items: {
        Row: RoutingTestItemRecord;
        Insert: {
          id?: string;
          prompt: string;
          expected_agent: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          prompt?: string;
          expected_agent?: string;
          updated_at?: string;
        };
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
  RoutingTestItemsDatabase,
  'public'
> {
  return getSupabaseServiceRoleClient() as unknown as SupabaseClient<
    RoutingTestItemsDatabase,
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

export async function insertRoutingTestItem(values: {
  prompt: string;
  expected_agent: string;
}): Promise<RoutingTestItemRecord> {
  const result = await routingTestClient()
    .from('routing_test_items')
    .insert(values)
    .select('*')
    .single();

  return assertNoError(result) as RoutingTestItemRecord;
}

/**
 * `updated_at` is maintained by `trg_routing_test_items_updated_at` (same trigger function as
 * `public.tests`), so callers never set it.
 */
export async function updateRoutingTestItem(
  id: string,
  values: { prompt: string; expected_agent: string },
): Promise<RoutingTestItemRecord | null> {
  const result = await routingTestClient()
    .from('routing_test_items')
    .update(values)
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
