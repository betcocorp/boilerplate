import { searchProductChunks, type RagSearchMatch } from '~/lib/rag/search';
import {
  deriveCanonicalProductUrl,
  type LegacyProductDescrRow,
  type LegacyProductRow,
} from '~/lib/tools/cross-reference-lookup';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { EnrichedCompetitorSpec } from '~/lib/websearch/enrich-competitor-spec';

/**
 * B0-87 — turn an enriched competitor spec into a ranked set of Betco candidates (many, not one).
 *
 * Builds a semantic query from the spec (category / primary use / chemistry / key claims), runs the
 * existing corpus search, maps each hit back to legacy product identity (product key, line key, SKU,
 * title) with a canonical betco.com URL, then de-duplicates by product while preserving similarity
 * order. Search + URL resolution are injectable so the pure ranking logic is unit-testable.
 */

export type BetcoCandidate = {
  betcoProductKey: string | null;
  betcoProductLineKey: string | null;
  sku: string | null;
  title: string;
  similarity: number;
  url: string | null;
  documentId: string;
  evidence: string;
  /**
   * B0-442 — how `betcoProductKey` was derived, so a line-level match can be represented honestly
   * instead of silently looking like (or failing to look like) a precise SKU match:
   *  - 'direct_match': the search hit itself resolved to a specific product.
   *  - 'line_representative': the hit only resolved to a product *line*; `betcoProductKey` borrows
   *    one representative product from that line (via `legacy.products_attr`) purely so the
   *    candidate is promotable — it is not a guaranteed SKU-exact match and should read as such.
   *  - 'line_only': a line-level hit with no representative product resolvable at all. This is a
   *    legitimate outcome (not a bug) — the candidate has no `betcoProductKey` and stays honestly
   *    unpromotable until a reviewer picks the right product.
   */
  keySource: 'direct_match' | 'line_representative' | 'line_only';
};

const DEFAULT_LIMIT = 5;
const CANDIDATE_FETCH_MULTIPLIER = 3; // over-fetch so dedup still yields ~limit uniques

/** Pure: assemble the retrieval query from the most discriminating spec fields. */
export function buildRetrievalQuery(spec: EnrichedCompetitorSpec): string {
  return [
    spec.productCategory,
    spec.primaryUse,
    spec.chemistryClass,
    spec.formFactor,
    ...spec.keyClaims,
  ]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join(' ')
    .trim();
}

const candidateKey = (m: RagSearchMatch): string =>
  m.product_key ?? m.product_line_key ?? m.document_id;

/** Pure: map matches → candidates, de-dup by product (keep max similarity), order by similarity. */
export function rankCandidates(matches: RagSearchMatch[], limit: number): BetcoCandidate[] {
  const best = new Map<string, BetcoCandidate>();
  for (const m of matches) {
    const key = candidateKey(m);
    const existing = best.get(key);
    if (existing && existing.similarity >= m.similarity) continue;
    best.set(key, {
      betcoProductKey: m.product_key,
      betcoProductLineKey: m.product_line_key,
      sku: m.sku,
      title: m.document_title || m.heading || m.document_key,
      similarity: m.similarity,
      url: null,
      documentId: m.document_id,
      evidence: m.chunk_text,
      // Provisional: a line-level hit (no direct product key) is 'line_only' until
      // resolveCandidateUrls either upgrades it to 'line_representative' or confirms no
      // representative product exists.
      keySource: m.product_key ? 'direct_match' : 'line_only',
    });
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

export type RetrieveBetcoCandidatesDeps = {
  search: (query: string, limit: number) => Promise<RagSearchMatch[]>;
  resolveUrls: (candidates: BetcoCandidate[]) => Promise<BetcoCandidate[]>;
};

export async function retrieveBetcoCandidates(
  input: { spec: EnrichedCompetitorSpec; limit?: number },
  deps: RetrieveBetcoCandidatesDeps = defaultDeps,
): Promise<BetcoCandidate[]> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const query = buildRetrievalQuery(input.spec);
  if (!query) return [];

  const matches = await deps.search(query, limit * CANDIDATE_FETCH_MULTIPLIER);
  const ranked = rankCandidates(matches, limit);
  return deps.resolveUrls(ranked);
}

// --- default (live) deps ---

type LooseRow = Record<string, unknown>;
function legacyFrom(table: string) {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: string) => {
      from: (t: string) => {
        select: (cols: string) => {
          in: (col: string, values: readonly unknown[]) => PromiseLike<{ data: LooseRow[] | null }>;
          eq: (col: string, v: unknown) => {
            in: (col: string, values: readonly unknown[]) => PromiseLike<{ data: LooseRow[] | null }>;
          };
          ilike: (col: string, v: string) => {
            in: (col: string, values: readonly unknown[]) => PromiseLike<{ data: LooseRow[] | null }>;
          };
        };
      };
    };
  };
  return sb.schema('legacy').from(table);
}

/**
 * Resolve a canonical betco.com URL per candidate. Direct product keys use their legacy product row;
 * line-level candidates borrow a representative web-visible product from the line. Best-effort.
 *
 * Exported (rather than kept module-private) so the B0-442 line-level key-resolution regression can
 * exercise the real implementation instead of a hand-rolled stand-in.
 */
export async function resolveCandidateUrls(candidates: BetcoCandidate[]): Promise<BetcoCandidate[]> {
  if (candidates.length === 0) return candidates;
  try {
    // line-level candidates (no product key) → one representative ProductsKey via prodline attrs
    const lineKeys = candidates
      .filter((c) => !c.betcoProductKey && c.betcoProductLineKey)
      .map((c) => c.betcoProductLineKey as string);
    const repByLine = new Map<string, string>();
    if (lineKeys.length > 0) {
      const attrRes = await legacyFrom('products_attr')
        .select('ProductsKey, AttrKey')
        .ilike('AttrTable', 'prodline')
        .in('AttrKey', lineKeys);
      for (const r of attrRes.data ?? []) {
        const line = String(r.AttrKey ?? '');
        const pk = typeof r.ProductsKey === 'string' ? r.ProductsKey : null;
        if (line && pk && !repByLine.has(line)) repByLine.set(line, pk);
      }
    }

    const productKeys = [
      ...new Set(
        candidates
          .map((c) => c.betcoProductKey ?? (c.betcoProductLineKey ? repByLine.get(c.betcoProductLineKey) : null))
          .filter((v): v is string => typeof v === 'string'),
      ),
    ];
    if (productKeys.length === 0) return candidates;

    const [prodRes, descrRes] = await Promise.all([
      legacyFrom('products')
        .select(
          'ProductsKey, Title, SKU, SLDescr, InvtID, Status, OnWeb, User_Str_00, User_Str_01, User_Str_02, User_Str_03, User_Str_04, User_Str_05',
        )
        .in('ProductsKey', productKeys),
      legacyFrom('products_descr')
        .select('ProductsKey, ShortDescr, FullDescr, User_Str_00, User_Str_01, User_Str_02, User_Str_03')
        .eq('LanguageCD', 'EN')
        .in('ProductsKey', productKeys),
    ]);

    const productByKey = new Map<string, LegacyProductRow>();
    for (const p of prodRes.data ?? []) {
      if (typeof p.ProductsKey === 'string') productByKey.set(p.ProductsKey, p as unknown as LegacyProductRow);
    }
    const descrByKey = new Map<string, LegacyProductDescrRow>();
    for (const d of descrRes.data ?? []) {
      if (typeof d.ProductsKey === 'string' && !descrByKey.has(d.ProductsKey)) {
        descrByKey.set(d.ProductsKey, d as unknown as LegacyProductDescrRow);
      }
    }

    return candidates.map((c) => {
      const pk = c.betcoProductKey ?? (c.betcoProductLineKey ? repByLine.get(c.betcoProductLineKey) : null);
      // B0-442: the resolved key must be written back onto the candidate, not just used locally to
      // look up the URL — otherwise a line-level candidate keeps a null betco_product_key forever
      // even when a representative product was found, and can never be promoted.
      const betcoProductKey = pk ?? null;
      const keySource: BetcoCandidate['keySource'] =
        c.betcoProductKey != null ? 'direct_match' : pk != null ? 'line_representative' : 'line_only';

      const product = pk ? productByKey.get(pk) : undefined;
      if (!product) return { ...c, betcoProductKey, keySource };
      const link = deriveCanonicalProductUrl({ product, productDescr: descrByKey.get(pk as string) });
      return {
        ...c,
        betcoProductKey,
        keySource,
        url: link.url ?? c.url,
        sku: c.sku ?? (product.SKU ?? null),
      };
    });
  } catch {
    return candidates; // URL enrichment is best-effort
  }
}

const defaultDeps: RetrieveBetcoCandidatesDeps = {
  search: async (query, limit) => {
    const result = await searchProductChunks({ query, limit, scope: 'products', useHybrid: true });
    return result.matches;
  },
  resolveUrls: resolveCandidateUrls,
};
