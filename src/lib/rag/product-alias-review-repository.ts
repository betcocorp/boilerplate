import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import {
  editProductAliasInputSchema,
  listUnverifiedProductAliasesInputSchema,
  productAliasReviewRowSchema,
  type ConflictingProductLine,
  type EditProductAliasInput,
  type ListUnverifiedProductAliasesInput,
  type ProductAliasReviewRow,
} from '~/lib/rag/product-alias-review-schemas';

/**
 * B0-487 — data access for the admin alias review queue.
 *
 * Every read here hits `rag.product_alias` / `rag.product_alias_conflicts` directly with no
 * caching layer (same as `resolveProductEntityByName` in `~/lib/rag/entity-context.ts`), so an
 * approve/edit/reject write is visible to the very next resolution call. Callers that render this
 * data in a page (the review queue itself) must call `revalidatePath` after any mutation rather
 * than relying on RSC caching to pick up the change.
 *
 * Row volume here is admin-scale, not user-facing traffic (mirrors the reasoning in
 * `~/lib/recommendations/repository.ts`'s `getRecommendationMetrics`): a single unfiltered read of
 * the unverified rows, sorted in JS so conflict rows sort first, is the simplest correct
 * implementation. `MAX_UNVERIFIED_FETCH` is a safety valve, not an expected ceiling.
 */

type LooseRow = Record<string, unknown>;

const MAX_UNVERIFIED_FETCH = 5000;
const MAX_CONFLICT_FETCH = 5000;

/** Loose accessor for `rag.product_alias` — same shape as `ragTable` in the recommendations
 *  repository; the merged (public+legacy+rag) Supabase `Database` type doesn't reliably resolve
 *  `.schema('rag').from(...)` chains for every table, so this repo's own convention is a narrow,
 *  hand-typed accessor per table rather than fighting the generated types. */
function productAliasTable() {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: 'rag') => {
      from: (t: 'product_alias') => {
        select: (cols?: string) => {
          eq: (
            c: string,
            v: unknown,
          ) => PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;
          in: (
            c: string,
            v: unknown[],
          ) => PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;
        };
        update: (row: LooseRow) => {
          eq: (
            c: string,
            v: unknown,
          ) => {
            select: (cols?: string) => {
              single: () => Promise<{ data: LooseRow | null; error: { message: string } | null }>;
            };
          };
        };
        delete: () => {
          eq: (c: string, v: unknown) => Promise<{ error: { message: string } | null }>;
        };
      };
    };
  };
  return sb.schema('rag').from('product_alias');
}

/** Loose accessor for the `rag.product_alias_conflicts` view (read-only). */
function productAliasConflictsView() {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: 'rag') => {
      from: (t: 'product_alias_conflicts') => {
        select: (cols: string) => {
          limit: (
            n: number,
          ) => PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;
        };
      };
    };
  };
  return sb.schema('rag').from('product_alias_conflicts');
}

/** Loose accessor for `rag.entity` (product-line title lookups only — no writes here). */
function entityTable() {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: 'rag') => {
      from: (t: 'entity') => {
        select: (cols: string) => {
          eq: (
            c: string,
            v: unknown,
          ) => {
            in: (
              c: string,
              v: unknown[],
            ) => PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };
  return sb.schema('rag').from('entity');
}

const numOrZero = (v: unknown): number => (typeof v === 'number' ? v : v == null ? 0 : Number(v));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Pure mapper — DB row + review-queue context to the domain shape. Unit-tested. */
export function fromProductAliasRow(
  row: LooseRow,
  context: {
    isConflict: boolean;
    productLineTitle: string | null;
    conflictingProductLines: ConflictingProductLine[];
  },
): ProductAliasReviewRow {
  return productAliasReviewRowSchema.parse({
    id: row.id,
    aliasNorm: String(row.alias_norm ?? ''),
    alias: String(row.alias ?? ''),
    entityId: strOrNull(row.entity_id),
    productLineKey: String(row.product_line_key ?? ''),
    productLineTitle: context.productLineTitle,
    source: String(row.source ?? ''),
    confidence: numOrZero(row.confidence),
    aliasType: row.alias_type,
    verified: Boolean(row.verified),
    reviewedBy: strOrNull(row.reviewed_by),
    reviewedAt: strOrNull(row.reviewed_at),
    createdAt: String(row.created_at ?? ''),
    isConflict: context.isConflict,
    conflictingProductLines: context.conflictingProductLines,
  });
}

/**
 * B0-487 — every distinct `product_line_key` per `alias_norm` currently in
 * `rag.product_alias_conflicts` (every alias_norm with >1 distinct product_line_key, per view
 * definition). Capped at `MAX_CONFLICT_FETCH` rows as a safety valve — genuine cross-product-line
 * aliases are expected to be a small minority of the table.
 */
async function getConflictGroups(): Promise<Map<string, string[]>> {
  const { data, error } = await productAliasConflictsView()
    .select('alias_norm, product_line_key')
    .limit(MAX_CONFLICT_FETCH);
  if (error) throw new Error(`getConflictGroups failed: ${error.message}`);

  const groups = new Map<string, Set<string>>();
  for (const row of data ?? []) {
    const aliasNorm = strOrNull(row.alias_norm);
    const productLineKey = strOrNull(row.product_line_key);
    if (!aliasNorm || !productLineKey) continue;
    const set = groups.get(aliasNorm) ?? new Set<string>();
    set.add(productLineKey);
    groups.set(aliasNorm, set);
  }

  return new Map([...groups].map(([aliasNorm, set]) => [aliasNorm, [...set]]));
}

/** Resolve `entity.title` for a batch of product-line keys (best-effort — missing keys map to null). */
async function resolveProductLineTitles(
  productLineKeys: string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(productLineKeys.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const { data, error } = await entityTable()
    .select('product_line_key, title')
    .eq('entity_type', 'product_line')
    .in('product_line_key', unique);
  if (error) throw new Error(`resolveProductLineTitles failed: ${error.message}`);

  const map = new Map<string, string | null>();
  for (const row of data ?? []) {
    const key = strOrNull(row.product_line_key);
    if (key) map.set(key, strOrNull(row.title));
  }
  return map;
}

export type ListUnverifiedProductAliasesResult = {
  items: ProductAliasReviewRow[];
  page: number;
  pageSize: number;
  total: number;
  /** true when the unfiltered unverified set exceeded `MAX_UNVERIFIED_FETCH` and was truncated. */
  truncated: boolean;
};

/**
 * B0-487 — the review queue's list query. Conflict rows (this row's `alias_norm` appears in
 * `rag.product_alias_conflicts`) always sort first, then the remainder oldest-first so the
 * longest-unreviewed rows surface before newer ones.
 */
export async function listUnverifiedProductAliasesForReview(
  rawInput: ListUnverifiedProductAliasesInput = { page: 1, pageSize: 25 },
): Promise<ListUnverifiedProductAliasesResult> {
  const input = listUnverifiedProductAliasesInputSchema.parse(rawInput);

  const [{ data, error }, conflictGroups] = await Promise.all([
    productAliasTable().select('*').eq('verified', false),
    getConflictGroups(),
  ]);
  if (error) throw new Error(`listUnverifiedProductAliasesForReview failed: ${error.message}`);

  const rows = data ?? [];
  const truncated = rows.length > MAX_UNVERIFIED_FETCH;
  const capped = truncated ? rows.slice(0, MAX_UNVERIFIED_FETCH) : rows;

  const productLineKeys = capped.map((r) => String(r.product_line_key ?? ''));
  const conflictProductLineKeys = [...conflictGroups.values()].flat();
  const titleMap = await resolveProductLineTitles([...productLineKeys, ...conflictProductLineKeys]);

  const enriched = capped
    .map((row) => {
      const aliasNorm = String(row.alias_norm ?? '');
      const productLineKey = String(row.product_line_key ?? '');
      const group = conflictGroups.get(aliasNorm) ?? [];
      const isConflict = group.length > 1;
      const conflictingProductLines: ConflictingProductLine[] = isConflict
        ? group
            .filter((key) => key !== productLineKey)
            .map((key) => ({ productLineKey: key, title: titleMap.get(key) ?? null }))
        : [];

      return fromProductAliasRow(row, {
        isConflict,
        productLineTitle: titleMap.get(productLineKey) ?? null,
        conflictingProductLines,
      });
    })
    .sort((a, b) => {
      if (a.isConflict !== b.isConflict) return a.isConflict ? -1 : 1;
      return a.createdAt.localeCompare(b.createdAt);
    });

  const total = enriched.length;
  const from = (input.page - 1) * input.pageSize;
  const items = enriched.slice(from, from + input.pageSize);

  return { items, page: input.page, pageSize: input.pageSize, total, truncated };
}

/** Approve — verify=true, stamp reviewer + timestamp. Returns the updated row (unenriched). */
export async function approveProductAlias(
  id: string,
  reviewedBy: string,
): Promise<{ id: string; verified: boolean; reviewedBy: string | null; reviewedAt: string | null }> {
  const res = await productAliasTable()
    .update({ verified: true, reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, verified, reviewed_by, reviewed_at')
    .single();
  if (res.error || !res.data) {
    throw new Error(`approveProductAlias failed: ${res.error?.message ?? 'no row'}`);
  }
  return {
    id: String(res.data.id),
    verified: Boolean(res.data.verified),
    reviewedBy: strOrNull(res.data.reviewed_by),
    reviewedAt: strOrNull(res.data.reviewed_at),
  };
}

/** Edit — `product_line_key` and/or `alias_type` only; does not touch verified/reviewed fields. */
export async function editProductAlias(
  id: string,
  rawInput: EditProductAliasInput,
): Promise<{ id: string; productLineKey: string; aliasType: string }> {
  const input = editProductAliasInputSchema.parse(rawInput);
  const patch: LooseRow = {};
  if (input.productLineKey !== undefined) patch.product_line_key = input.productLineKey;
  if (input.aliasType !== undefined) patch.alias_type = input.aliasType;

  const res = await productAliasTable()
    .update(patch)
    .eq('id', id)
    .select('id, product_line_key, alias_type')
    .single();
  if (res.error || !res.data) {
    throw new Error(`editProductAlias failed: ${res.error?.message ?? 'no row'}`);
  }
  return {
    id: String(res.data.id),
    productLineKey: String(res.data.product_line_key),
    aliasType: String(res.data.alias_type),
  };
}

/** Reject — deletes the row outright (per B0-487 spec: reject = delete, not a status flag). */
export async function rejectProductAlias(id: string): Promise<void> {
  const res = await productAliasTable().delete().eq('id', id);
  if (res.error) {
    throw new Error(`rejectProductAlias failed: ${res.error.message}`);
  }
}

/** Search product lines by title, for the edit form's product-line picker. */
export async function searchProductLines(
  rawQuery: string,
  limit = 20,
): Promise<Array<{ productLineKey: string; title: string }>> {
  const trimmed = rawQuery.trim();
  if (!trimmed) return [];

  const supabase = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: 'rag') => {
      from: (t: 'entity') => {
        select: (cols: string) => {
          eq: (
            c: string,
            v: unknown,
          ) => {
            ilike: (
              c: string,
              v: string,
            ) => {
              limit: (
                n: number,
              ) => PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;
            };
          };
        };
      };
    };
  };

  const pattern = `%${trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const { data, error } = await supabase
    .schema('rag')
    .from('entity')
    .select('product_line_key, title')
    .eq('entity_type', 'product_line')
    .ilike('title', pattern)
    .limit(Math.min(Math.max(Math.floor(limit) || 20, 1), 50));
  if (error) throw new Error(`searchProductLines failed: ${error.message}`);

  const results: Array<{ productLineKey: string; title: string }> = [];
  for (const row of data ?? []) {
    const productLineKey = strOrNull(row.product_line_key);
    const title = strOrNull(row.title);
    if (productLineKey && title) results.push({ productLineKey, title });
  }
  return results;
}
