import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-751 follow-up — "is this name Betco's at all?", which is a strictly weaker question than
 * `resolveProductEntityByName`'s "which product line is this?".
 *
 * The self-reference check (`~/lib/recommendations/competitor-self-reference`) only needs to know
 * whether a name the routers treated as a competitor is in fact one of ours. It does NOT need the
 * product line, so it must not inherit the resolver's "return nothing when ambiguous" rule — that
 * rule is correct for retrieval (locking the wrong line is worse than not locking) and wrong here
 * (three pH7Q formulations is still, unambiguously, a Betco product).
 *
 * Why this reads `rag.entity` at BOTH grains rather than going through the resolver: the two tiers
 * are not reconciled. Measured 2026-08-29 — `entity_type = 'product_line'` (1,703 rows) has no row
 * at all for af315, grease solv or ph7q, while `entity_type = 'product'` (9,237 rows) has 7, 5 and
 * 19 respectively; `rag.product_alias` has zero rows for speedex, grease solv, af315 and green
 * earth. Any single-tier lookup therefore misses most of the products this check exists to catch.
 * Genuine competitors are absent from both tiers (virex 0, bnc-15 0), which is what makes a
 * catalog-membership test safe here.
 *
 * Deliberately NOT verified-gated (unlike the B0-696 alias tiers): these are catalog entities, not
 * mined aliases, so there is no unverified-row hazard to gate against.
 */

/** Cap the scan — membership is a boolean, and one page is far more than enough to decide it. */
const MATCH_LIMIT = 50;

export type BetcoProductNameMatch = {
  /** True when the name appears in the Betco catalog at either grain. */
  matched: boolean;
  /** Set only when every matched row agrees on one product line; null when they disagree. */
  productLineKey: string | null;
  matchCount: number;
};

const NO_MATCH: BetcoProductNameMatch = {
  matched: false,
  productLineKey: null,
  matchCount: 0,
};

/** PostgREST `ilike` treats these as wildcards; a product name must match them literally. */
function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function matchBetcoProductName(name: string): Promise<BetcoProductNameMatch> {
  const trimmed = name.trim();
  // Below three characters a substring match is noise ("GE", "HD") rather than an identification.
  if (trimmed.length < 3) {
    return NO_MATCH;
  }

  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema('rag')
      .from('entity')
      .select('product_line_key')
      .ilike('title', `%${escapeLikeWildcards(trimmed)}%`)
      .limit(MATCH_LIMIT);

    if (error || !data || data.length === 0) {
      return NO_MATCH;
    }

    const lineKeys = new Set(
      data.map((row) => row.product_line_key).filter((key): key is string => Boolean(key)),
    );
    return {
      matched: true,
      productLineKey: lineKeys.size === 1 ? [...lineKeys][0] : null,
      matchCount: data.length,
    };
  } catch (error) {
    // Fail open, exactly like the resolver path: an unavailable catalog must not change routing.
    console.warn('[betco-product-name] catalog lookup failed; treating as no match', {
      name: trimmed,
      error: error instanceof Error ? error.message : String(error),
    });
    return NO_MATCH;
  }
}
