import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-441 — server-backed typeahead source for the recommendation queue's Betco product picker.
 *
 * Backed by `rag.entity` where `entity_type = 'product'` (9,237 rows, 100% have `product_key` and
 * `sku`, already Betco-scoped) — deliberately NOT `legacy.products` (13,750 rows, includes
 * competitor products, `Title` empty on all but one row). This is the same table B0-442's
 * line-representative resolution and the rest of the RAG pipeline already treat as the
 * canonical Betco product identity surface.
 *
 * Read-only; no schema migration. Two separate ILIKE queries (title, sku) are merged client-side
 * rather than a single `.or(...)` filter — PostgREST's `or=` filter syntax is comma/paren-delimited
 * and free-text reviewer input could contain either, which would corrupt the filter rather than
 * just fail to match.
 */

export type BetcoProductOption = {
  productKey: string;
  sku: string | null;
  title: string;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

type LooseRow = { product_key: string | null; sku: string | null; title: string | null };

/** Escape ILIKE wildcard metacharacters so a literal `%` or `_` in the query searches literally. */
function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function toOption(row: LooseRow): BetcoProductOption | null {
  if (!row.product_key || !row.title) return null;
  return { productKey: row.product_key, sku: row.sku ?? null, title: row.title };
}

/**
 * Search Betco products by title or SKU substring (case-insensitive). Empty/whitespace-only
 * queries return `[]` rather than the first N products alphabetically — the picker should show
 * "type to search", not an arbitrary default list from 9,237 rows.
 */
export async function searchBetcoProducts(
  rawQuery: string,
  limit = DEFAULT_LIMIT,
): Promise<BetcoProductOption[]> {
  const trimmed = rawQuery.trim();
  if (!trimmed) return [];

  const cappedLimit = Math.min(Math.max(Math.floor(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const pattern = `%${escapeIlikePattern(trimmed)}%`;

  const supabase = getSupabaseServiceRoleClient();
  const entityTable = () =>
    supabase.schema('rag').from('entity').select('product_key, sku, title').eq('entity_type', 'product');

  const [titleRes, skuRes] = await Promise.all([
    entityTable().ilike('title', pattern).order('title', { ascending: true }).limit(cappedLimit),
    entityTable().ilike('sku', pattern).order('title', { ascending: true }).limit(cappedLimit),
  ]);

  const byKey = new Map<string, BetcoProductOption>();
  for (const row of [...(titleRes.data ?? []), ...(skuRes.data ?? [])] as LooseRow[]) {
    const option = toOption(row);
    if (option && !byKey.has(option.productKey)) byKey.set(option.productKey, option);
  }

  return [...byKey.values()].slice(0, cappedLimit);
}
