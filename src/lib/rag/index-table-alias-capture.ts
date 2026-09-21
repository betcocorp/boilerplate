// B0-1048 — capture the name -> description pairs mined out of an excluded index/TOC table
// (`~/lib/rag/index-table-chunks.ts`) into `rag.product_alias` as unverified candidate rows,
// instead of silently dropping them when the table itself is excluded from `rag.document_chunk`.
//
// Mirrors the precision/idempotency conventions of `scripts/mine-corpus-alias-candidates.mjs`
// (B0-484): every row is written `verified = false` — a human reviews it at the admin alias
// queue (B0-487) before it can affect retrieval routing — and a re-ingest of the same document
// only ever overwrites a row this same source previously wrote and that is still unverified;
// anything a human verified, or that another source owns, is left untouched.

import { resolveProductEntityByName } from '~/lib/rag/entity-context';
import type { IndexTableEntry } from '~/lib/rag/index-table-chunks';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/** Source tag for aliases mined from ingestion-time index/TOC tables. */
export const INDEX_TABLE_ALIAS_SOURCE = 'index_table_ingest';

/** Confidence for a corpus-mined, not-yet-reviewed alias — same order of magnitude as
 * `mine-corpus-alias-candidates.mjs`'s lowest-confidence pattern (0.35-0.65); an index-table row
 * carries less context than a co-occurrence/parenthetical hit, so it sits in the middle. */
const INDEX_TABLE_ALIAS_CONFIDENCE = 0.5;

/** Mirrors `normalizeAlias` in `~/lib/rag/entity-context.ts` (B0-200) — duplicated because that
 * function isn't exported and this module only needs the one normalization rule. */
function normalizeAlias(value: string): string {
  return value
    .replace(/[®™]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

type LooseRow = Record<string, unknown>;

/** Loose accessor for `rag.product_alias` — same pattern as
 * `~/lib/rag/product-alias-review-repository.ts`'s `productAliasTable()`: the generated Supabase
 * types don't reliably resolve `.schema('rag').from(...)` chains for every table. */
function productAliasTable() {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: 'rag') => {
      from: (t: 'product_alias') => {
        select: (cols: string) => {
          in: (
            c: string,
            v: string[],
          ) => PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;
        };
        insert: (rows: LooseRow[]) => PromiseLike<{ error: { message: string } | null }>;
        upsert: (
          rows: LooseRow[],
          opts: { onConflict: string },
        ) => PromiseLike<{ error: { message: string } | null }>;
      };
    };
  };
  return sb.schema('rag').from('product_alias');
}

export type IndexTableAliasCaptureResult = {
  /** Entries that resolved to a known product line and were inserted or updated. */
  captured: number;
  /** Entries that didn't resolve to any known product/product-line entity — dropped, never
   * fabricated a product_line_key for them. */
  unresolved: number;
  /** Entries that matched an existing row a human had verified, or that another source owns —
   * left untouched. */
  skippedProtected: number;
};

type ResolvedCandidate = {
  aliasNorm: string;
  alias: string;
  productLineKey: string;
};

/**
 * Resolve each index-table {name, description} pair to a known product/product-line entity (via
 * the same resolver the retrieval path itself uses) and record it as an unverified
 * `rag.product_alias` candidate row. An entry that doesn't resolve is dropped — this never
 * fabricates a product_line_key.
 *
 * `description` is accepted on `IndexTableEntry` for callers/future use (e.g. surfacing it in the
 * admin review queue) but `rag.product_alias` has no description column today, so it isn't
 * persisted here.
 */
export async function captureIndexTableAliasCandidates(
  entries: IndexTableEntry[],
): Promise<IndexTableAliasCaptureResult> {
  if (entries.length === 0) {
    return { captured: 0, unresolved: 0, skippedProtected: 0 };
  }

  // Dedupe by normalized name — an index table commonly lists the same product more than once
  // (e.g. repeated across brand sub-sections), and each distinct name is an independent DB lookup.
  const byNorm = new Map<string, IndexTableEntry>();
  for (const entry of entries) {
    const norm = normalizeAlias(entry.name);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, entry);
  }

  const resolved: ResolvedCandidate[] = [];
  let unresolved = 0;
  for (const [aliasNorm, entry] of byNorm) {
    const result = await resolveProductEntityByName(entry.name, { mode: 'name' });
    if (!result.productLineKey) {
      unresolved++;
      continue;
    }
    resolved.push({ aliasNorm, alias: entry.name.trim(), productLineKey: result.productLineKey });
  }

  if (resolved.length === 0) {
    return { captured: 0, unresolved, skippedProtected: 0 };
  }

  const uniqueNorms = [...new Set(resolved.map((r) => r.aliasNorm))];
  const { data: existingRows, error: selectError } = await productAliasTable()
    .select('alias_norm, product_line_key, source, verified')
    .in('alias_norm', uniqueNorms);
  if (selectError) {
    throw new Error(`captureIndexTableAliasCandidates lookup failed: ${selectError.message}`);
  }

  const existing = new Map<string, { source: string; verified: boolean }>();
  for (const row of existingRows ?? []) {
    const key = `${String(row.alias_norm ?? '')}::${String(row.product_line_key ?? '')}`;
    existing.set(key, { source: String(row.source ?? ''), verified: Boolean(row.verified) });
  }

  const toInsert: ResolvedCandidate[] = [];
  const toUpdate: ResolvedCandidate[] = [];
  let skippedProtected = 0;
  for (const candidate of resolved) {
    const key = `${candidate.aliasNorm}::${candidate.productLineKey}`;
    const existingRow = existing.get(key);
    if (!existingRow) {
      toInsert.push(candidate);
    } else if (existingRow.verified === false && existingRow.source === INDEX_TABLE_ALIAS_SOURCE) {
      toUpdate.push(candidate);
    } else {
      skippedProtected++;
    }
  }

  const toRow = (c: ResolvedCandidate) => ({
    alias_norm: c.aliasNorm,
    alias: c.alias,
    // Not populated: resolveProductEntityByName resolves a product_line_key/product_key pair,
    // not the underlying rag.entity id, and entity_id is nullable on this table — leaving it null
    // costs nothing downstream, since resolution matches on (alias_norm, product_line_key).
    entity_id: null,
    product_line_key: c.productLineKey,
    source: INDEX_TABLE_ALIAS_SOURCE,
    confidence: INDEX_TABLE_ALIAS_CONFIDENCE,
    alias_type: 'synonym',
    verified: false,
  });

  if (toInsert.length > 0) {
    const { error } = await productAliasTable().insert(toInsert.map(toRow));
    if (error) throw new Error(`captureIndexTableAliasCandidates insert failed: ${error.message}`);
  }
  if (toUpdate.length > 0) {
    const { error } = await productAliasTable().upsert(toUpdate.map(toRow), {
      onConflict: 'alias_norm,product_line_key',
    });
    if (error) throw new Error(`captureIndexTableAliasCandidates upsert failed: ${error.message}`);
  }

  return { captured: toInsert.length + toUpdate.length, unresolved, skippedProtected };
}
