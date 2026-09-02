import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-479: which branch of `resolveProductEntityByName` actually produced the returned
 * `productLineKey`, so callers (product-tools.ts -> ragQueryForProductKnowledgeWithMeta) can
 * tag telemetry with "alias-anchored" vs. "other explicit-key source" instead of only knowing
 * *that* a key was supplied. `null` means no match was found at all (both keys null).
 */
export type ProductEntityResolutionSource =
  | 'alias_exact'
  | 'alias_fuzzy'
  | 'alias_fuzzy_trgm'
  | 'prod_line_id'
  | 'title_exact'
  | 'title_fuzzy'
  /**
   * B0-479: the two `freeform` variants are the same alias tiers, reached with
   * `{ mode: 'freeform' }` — i.e. the input was a raw user question/phrase rather than a
   * model-asserted product name, so only the high-precision alias tiers were allowed to run.
   * Kept distinct so retrieval telemetry can tell a model-asserted product name apart from a
   * key recovered out of freeform text.
   */
  | 'alias_exact_freeform'
  | 'alias_fuzzy_freeform'
  | null;

export type EntityContext = {
  entityId: string;
  title: string | null;
  dilutionCode: string | null;
  coverageSqFt: number | null;
  description: string | null;
  shortDescription: string | null;
};

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function parseEntityMetadata(metadata: unknown): Omit<EntityContext, 'entityId' | 'title'> {
  const empty = { dilutionCode: null, coverageSqFt: null, description: null, shortDescription: null };

  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return empty;
  }

  const m = metadata as Record<string, unknown>;

  const rawDilution = m.dilution_code;
  const dilutionCode =
    typeof rawDilution === 'string' && rawDilution.trim() && rawDilution.trim() !== 'NULL'
      ? rawDilution.trim()
      : null;

  const rawCoverage = m.coverage_sq_ft;
  const coverageSqFt =
    rawCoverage != null && Number.isFinite(Number(rawCoverage)) ? Number(rawCoverage) : null;

  const rawDescription = typeof m.description === 'string' ? m.description.trim() : null;
  const description = rawDescription ? stripHtml(rawDescription) : null;

  const rawShort = typeof m.short_description === 'string' ? m.short_description.trim() : null;
  const shortDescription = rawShort ? stripHtml(rawShort) : null;

  return { dilutionCode, coverageSqFt, description, shortDescription };
}

/**
 * Fetch entity metadata for a set of entity IDs. Returns a map keyed by entity ID.
 * Silently returns an empty map on DB errors so the retrieval pipeline degrades gracefully.
 */
export async function fetchEntityContexts(
  entityIds: string[],
): Promise<Map<string, EntityContext>> {
  const unique = [...new Set(entityIds.filter(Boolean))];

  if (unique.length === 0) {
    return new Map();
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('entity')
    .select('id, title, metadata')
    .in('id', unique);

  if (error || !data) {
    return new Map();
  }

  const map = new Map<string, EntityContext>();
  for (const row of data) {
    map.set(row.id, {
      entityId: row.id,
      title: row.title,
      ...parseEntityMetadata(row.metadata),
    });
  }

  return map;
}

/** Normalize a product name to match rag.product_alias.alias_norm (B0-200). */
function normalizeAlias(value: string): string {
  return value
    .replace(/[®™]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Generic English filler words that add no discriminating value when tokenizing a product name. */
const PRODUCT_NAME_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'with', 'in', 'on', 'to', 'is', 'are',
]);

/**
 * B0-272: tokenize a free-text product name for the fuzzy fallback below. Strips trademark
 * glyphs/punctuation, lowercases, and drops short filler words — but keeps short brand/form
 * tokens (e.g. "GE", "RTU") since those are exactly what distinguishes one product line from
 * another here.
 */
function tokenizeProductName(value: string): string[] {
  return value
    .replace(/[®™]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !PRODUCT_NAME_STOPWORDS.has(token));
}

type ProductAliasRow = {
  product_line_key: string | null;
  entity_id: string | null;
  /** Only populated when the caller's `.select()` includes it (B0-483 exact-match tiebreak). */
  verified?: boolean;
  /** B0-488: `rag.product_alias.id` / `.confidence`, only populated when the caller's `.select()`
   * includes them — needed so a successful match can be logged with which alias row produced it. */
  id?: string;
  confidence?: number | null;
  /** Only populated when the caller's `.select()` includes it (B0-791 EXP- exclusion). */
  alias?: string;
};

/** Chainable filter shape for `rag.product_alias`, which isn't in the generated Supabase types. */
type ProductAliasQuery = {
  eq: (column: string, value: string) => ProductAliasQuery;
  ilike: (column: string, value: string) => ProductAliasQuery;
  limit: (n: number) => Promise<{ data: ProductAliasRow[] | null; error: unknown }>;
};

type ProductAliasClient = {
  from: (table: 'product_alias') => {
    select: (columns: string) => ProductAliasQuery;
  };
};

/** Row shape returned by the `rag.match_product_alias_fuzzy` RPC (B0-482). */
type FuzzyTrgmAliasRow = {
  alias_norm: string;
  alias: string;
  product_line_key: string | null;
  entity_id: string | null;
  verified: boolean;
  alias_type: string | null;
  confidence: number | null;
  similarity: number;
};

// rag.match_product_alias_fuzzy IS now in the generated Supabase RPC types
// (`~/types/supabase.rag.ts`), but the generated `Returns` row declares every column
// non-nullable (`product_line_key: string`, `confidence: number`) while the SQL function can
// return NULL for both. Keep this narrow local cast — it models the real nullability — rather
// than adopting the generated shape and losing the null checks below.
type FuzzyTrgmAliasRpcClient = {
  rpc: (
    fn: 'match_product_alias_fuzzy',
    args: { query: string; similarity_threshold?: number; max_results?: number },
  ) => Promise<{ data: FuzzyTrgmAliasRow[] | null; error: unknown }>;
};

/** B0-482 fuzzy RPC defaults, mirrored here so the app-layer call is explicit rather than relying on the SQL-side defaults. */
const FUZZY_TRGM_SIMILARITY_THRESHOLD = 0.35;
const FUZZY_TRGM_MAX_RESULTS = 5;

/**
 * B0-791: `EXP-`-prefixed aliases mark experimental/discontinued product lines (confirmed against
 * live data: 12 such rows, e.g. "EXP-DENSICLEAN", "EXP-DRAIN GEL" — all `verified = true`, so the
 * existing verified gate doesn't touch them). A short bare product name like "DENSICLEAN" scores
 * HIGHER trigram similarity against "EXP-DENSICLEAN" (a near-identical, longer superstring) than
 * against the real, wordier product alias ("DensicleanT Cleaner with Densifier") it should match —
 * a property of trigram similarity, not a data error. Exclude `EXP-` candidates from the fuzzy
 * tiers unless the caller's own query is itself an EXP- lookup, so an experimental line stays
 * findable by its exact/near-exact name but can't silently steal a fuzzy match meant for the real
 * product line.
 */
function isExperimentalAliasMatch(alias: string, query: string): boolean {
  return /^exp-/i.test(alias) && !/^exp[\s-]/i.test(query);
}

/**
 * B0-483: candidates within this margin of the top trigram similarity score are treated as
 * "too close to call" for ambiguity purposes. The exact-match tier's ambiguity check is exact
 * (every candidate row shares the identical `alias_norm`), but the fuzzy tier's top-N candidates
 * are typically NOT all the same `alias_norm`, so a numeric margin around the top score is the
 * fuzzy-tier analogue of "these candidates are competing for the same query."
 */
const FUZZY_TRGM_AMBIGUITY_MARGIN = 0.05;

/**
 * B0-483: given a set of candidate rows that span more than one distinct `product_line_key` for
 * what the caller has judged the same query (either an exact `alias_norm` match, or a cluster of
 * fuzzy matches within a small similarity margin of the top result), resolve deterministically
 * ONLY when exactly one distinct product line among them is `verified`. Returns null otherwise --
 * this resolver never guesses between multiple equally-plausible verified (or all-unverified)
 * candidates.
 */
function resolveVerifiedTiebreak<
  T extends { product_line_key: string | null; verified?: boolean | null },
>(rows: T[]): T | null {
  const verifiedRows = rows.filter((r) => r.product_line_key && r.verified === true);
  const distinctVerifiedLineKeys = new Set(verifiedRows.map((r) => r.product_line_key));
  return distinctVerifiedLineKeys.size === 1 ? verifiedRows[0] : null;
}

/** Resolve the `product_key` for an alias's `entity_id`, when it points at a SKU-tier row (B0-248). */
async function resolveProductKeyForAliasEntity(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  entityId: string | null,
): Promise<string | null> {
  if (!entityId) {
    return null;
  }
  const { data: entityRows } = await supabase
    .schema('rag')
    .from('entity')
    .select('entity_type, product_key')
    .eq('id', entityId)
    .limit(1);
  return entityRows && entityRows[0]?.entity_type === 'product' ? entityRows[0].product_key : null;
}

/**
 * Resolve a free-text product name or prod_line_id to a product_line_key UUID and,
 * where the matched alias points at a SKU-level entity (B0-248), a product_key UUID.
 * Order: exact alias match (rag.product_alias), tokenized alias match, trigram fuzzy alias match
 * (B0-482), prod_line_id exact, title ILIKE, tokenized title match.
 * Returns nulls if no unique match is found (ambiguous or unknown name) — this resolver never
 * guesses between multiple equally-plausible matches (e.g. US vs. Canada variants of the same
 * product name), by design: silently picking one would be exactly the kind of inferred
 * region/product identification the regulated-data handling rules prohibit. B0-483: the two
 * alias-table tiers that can see multiple product lines for the "same" query (exact alias_norm,
 * and the fuzzy-trigram similarity cluster) make a single deterministic exception to that rule —
 * if exactly one candidate among the ambiguous set is `verified`, that one wins.
 *
 * B0-479: `options.mode` restricts which tiers may run — `'freeform'` narrows resolution to the
 * two high-precision alias tiers for raw user text (see `ResolveProductEntityOptions`).
 *
 * B0-479: also reports `resolutionSource` — which of the branches below actually produced the
 * match — so callers can tag downstream retrieval telemetry with "alias-anchored" (alias_exact /
 * alias_fuzzy / alias_fuzzy_trgm) vs. a non-alias explicit-key source (prod_line_id / title match).
 *
 * B0-488: also reports `ambiguousAlias` / `matchedAliasId` / `matchedAliasConfidence`, so callers
 * can log an alias-resolution audit event and distinguish, when `resolutionSource` is `null`,
 * "genuinely no match found" from "found alias candidates spanning multiple product lines that
 * were rejected by the verified-tiebreak gate" — those two cases were previously indistinguishable
 * from the return value alone. `ambiguousAlias` is only ever true when the FINAL resolution is
 * null; if an earlier tier's ambiguity is later resolved by a subsequent tier, the outcome is that
 * tier's normal success, not "ambiguous".
 */
export type ProductEntityResolutionResult = {
  productLineKey: string | null;
  productKey: string | null;
  resolutionSource: ProductEntityResolutionSource;
  ambiguousAlias: boolean;
  /** `rag.product_alias.id` of the matched row, when `resolutionSource` is an alias_* tier. Null
   * for non-alias sources and for `alias_fuzzy_trgm` (the RPC doesn't return the row id). */
  matchedAliasId: string | null;
  /** `rag.product_alias.confidence` of the matched row, when `resolutionSource` is an alias_* tier. */
  matchedAliasConfidence: number | null;
};

/**
 * B0-479: which family of tiers `resolveProductEntityByName` is allowed to run.
 *
 * - `'name'` (default) — the caller is passing a product name/code the model explicitly asserted
 *   (`productName` / `productId`). All six tiers run, including the trigram-similarity RPC and the
 *   legacy prod_line_id/title fallbacks.
 * - `'freeform'` — the caller is passing raw user text (`search_product_docs.freeformQuery`), which
 *   may be a SKU or short product name but may equally be a full natural-language question. Only
 *   the two high-precision alias tiers run, and only on an unambiguous match:
 *     * exact `alias_norm` equality — the WHOLE input must equal a curated alias, so a sentence
 *       can never match by accident;
 *     * tokenized alias AND-match — every significant token of the input must appear in one
 *       `alias_norm`. AND-ing more tokens can only shrink the candidate set, so a long sentence is
 *       strictly *less* likely to match than a short phrase — the tier gets more precise, not less,
 *       as the input grows, which is why no input-length gate is needed here.
 *   Deliberately EXCLUDED in this mode:
 *     * the trigram RPC (`match_product_alias_fuzzy`, threshold 0.35) — whole-string similarity is
 *       not monotonic in input length, so a long question can score a spurious 0.4+ against some
 *       unrelated alias and lock retrieval onto the wrong product's label/SDS;
 *     * the `prod_line_id` / `title ILIKE` / tokenized-title fallbacks — those resolve against
 *       legacy internal titles rather than the curated alias table, and freeform text is exactly
 *       the input for which "no lock" is the correct outcome;
 *     * the B0-483 verified-tiebreak — when freeform text hits aliases spanning multiple product
 *       lines, this mode returns no key at all rather than electing the single verified one.
 */
export type ProductEntityResolutionMode = 'name' | 'freeform';

export type ResolveProductEntityOptions = {
  mode?: ProductEntityResolutionMode;
};

export async function resolveProductEntityByName(
  name: string,
  options: ResolveProductEntityOptions = {},
): Promise<ProductEntityResolutionResult> {
  const freeform = options.mode === 'freeform';
  const trimmed = name.trim();
  if (!trimmed) {
    return {
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: null,
    };
  }

  // B0-488: true once any alias tier below sees candidates spanning >1 distinct product line that
  // the verified-tiebreak gate rejects — see the doc comment above for exactly what this means.
  let sawAmbiguousAlias = false;

  const supabase = getSupabaseServiceRoleClient();
  const aliasClient = supabase.schema('rag') as unknown as ProductAliasClient;

  // B0-200: exact alias match first — deterministic. B0-481 relaxed the table's uniqueness
  // constraint from bare UNIQUE(alias_norm) to UNIQUE(alias_norm, product_line_key), so an exact
  // alias_norm hit can now legitimately span more than one product line (e.g. a US/Canada variant
  // sharing a display name). B0-483: bump the limit so ambiguity across product lines is actually
  // visible (not silently first-row-wins), and only resolve when there's exactly one product line
  // present, or exactly one verified winner among the candidates for this alias.
  try {
    const { data: aliasRows } = await aliasClient
      .from('product_alias')
      .select('id, product_line_key, entity_id, verified, confidence')
      .eq('alias_norm', normalizeAlias(trimmed))
      .limit(20);
    if (aliasRows && aliasRows.length > 0) {
      const distinctLineKeys = new Set(
        aliasRows.filter((r) => r.product_line_key).map((r) => r.product_line_key),
      );
      // B0-696: the single-line branch used to trust aliasRows[0] unconditionally — including a
      // row that's `verified = false` (e.g. an unreviewed corpus-mined alias from B0-484). Require
      // verification here too; the multi-line branch below already requires it via
      // resolveVerifiedTiebreak. B0-479: the verified-tiebreak is a `mode: 'name'`-only exception —
      // freeform text that hits multiple product lines must produce no lock at all.
      const winner =
        distinctLineKeys.size <= 1
          ? (aliasRows.find((r) => r.verified === true) ?? null)
          : freeform
            ? null
            : resolveVerifiedTiebreak(aliasRows);
      if (winner?.product_line_key) {
        const productKey = await resolveProductKeyForAliasEntity(supabase, winner.entity_id);
        return {
          productLineKey: winner.product_line_key,
          productKey,
          resolutionSource: freeform ? 'alias_exact_freeform' : 'alias_exact',
          ambiguousAlias: false,
          matchedAliasId: winner.id ?? null,
          matchedAliasConfidence: winner.confidence ?? null,
        };
      }
      if (distinctLineKeys.size > 1) {
        sawAmbiguousAlias = true;
      }
    }
  } catch {
    // Alias table unavailable — fall through to legacy resolution.
  }

  // B0-272: tokenized alias fallback — same curated `product_alias` table, but tolerant of
  // near-miss wording (e.g. query "GE Fight Bac RTU" vs. seeded alias "GE Fight BacT RTU
  // Disinfectant"). Requires every significant query token to appear in `alias_norm` (AND'd
  // ILIKE per token). Only accepts the match when every row that matched shares the SAME
  // product_line_key — if the tokens hit multiple distinct product lines (e.g. a US alias and
  // a separately-seeded Canada alias for the "same" name), that's a genuine ambiguity this
  // resolver must not silently guess through, so it falls through to the next check instead.
  const aliasTokens = tokenizeProductName(trimmed);
  if (aliasTokens.length >= 2) {
    try {
      let fuzzyAliasQuery = aliasClient
        .from('product_alias')
        .select('id, alias, product_line_key, entity_id, verified, confidence');
      for (const token of aliasTokens) {
        fuzzyAliasQuery = fuzzyAliasQuery.ilike('alias_norm', `%${token}%`);
      }
      const { data: allFuzzyAliasRows } = await fuzzyAliasQuery.limit(5);
      // B0-791: drop EXP- (experimental/discontinued) candidates before judging uniqueness — see
      // `isExperimentalAliasMatch`.
      const fuzzyAliasRows = allFuzzyAliasRows?.filter(
        (r) => !isExperimentalAliasMatch(r.alias ?? '', trimmed),
      );

      if (fuzzyAliasRows && fuzzyAliasRows.length > 0) {
        const distinctLineKeys = new Set(
          fuzzyAliasRows.filter((r) => r.product_line_key).map((r) => r.product_line_key),
        );
        // B0-696: this tier didn't even select `verified` before — an unreviewed corpus-mined
        // alias could win the tokenized fallback on its own. Require at least one matching row to
        // be verified, on top of the existing same-product-line unanimity requirement.
        const hasVerifiedMatch = fuzzyAliasRows.some((r) => r.verified === true);
        if (distinctLineKeys.size === 1 && hasVerifiedMatch && fuzzyAliasRows[0].product_line_key) {
          const productKey = await resolveProductKeyForAliasEntity(
            supabase,
            fuzzyAliasRows[0].entity_id,
          );
          return {
            productLineKey: fuzzyAliasRows[0].product_line_key,
            productKey,
            resolutionSource: freeform ? 'alias_fuzzy_freeform' : 'alias_fuzzy',
            ambiguousAlias: false,
            matchedAliasId: fuzzyAliasRows[0].id ?? null,
            matchedAliasConfidence: fuzzyAliasRows[0].confidence ?? null,
          };
        }
        if (distinctLineKeys.size > 1) {
          sawAmbiguousAlias = true;
        }
      }
    } catch {
      // Alias table unavailable — fall through to legacy resolution.
    }
  }

  // B0-479: freeform input stops here. Everything below is either a similarity-scored net cast
  // over the whole input string or a legacy non-alias fallback — see `ResolveProductEntityOptions`
  // for why neither is safe to run against a raw user question. "No key" is the correct outcome.
  if (freeform) {
    return {
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: sawAmbiguousAlias,
      matchedAliasId: null,
      matchedAliasConfidence: null,
    };
  }

  // B0-482: trigram-similarity fuzzy alias lookup (rag.match_product_alias_fuzzy) — a broader net
  // than the tokenized AND-match above, since it catches single-token typos/transpositions the
  // token approach can't (e.g. "acrylic polymer FLOR finish" vs. seeded "...FLOOR finish"; token
  // matching would require every token to appear verbatim in alias_norm, which a misspelled token
  // never will). Only accepted when the top candidate clears the similarity threshold AND
  // (B0-483) there isn't a genuine multi-product-line ambiguity among the top-scoring
  // candidates — mirroring the exact-match tier's verified-tiebreak policy, just applied over a
  // similarity-margin cluster instead of an identical alias_norm.
  try {
    const { data: allFuzzyTrgmRows } = await (
      aliasClient as unknown as FuzzyTrgmAliasRpcClient
    ).rpc('match_product_alias_fuzzy', {
      query: trimmed,
      similarity_threshold: FUZZY_TRGM_SIMILARITY_THRESHOLD,
      max_results: FUZZY_TRGM_MAX_RESULTS,
    });
    // B0-791: a short bare product name (e.g. "DENSICLEAN") scores higher trigram similarity
    // against an EXP-prefixed superstring than against the real, wordier product alias it should
    // match — drop those candidates before ranking. See `isExperimentalAliasMatch`.
    const fuzzyTrgmRows = allFuzzyTrgmRows?.filter(
      (r) => !isExperimentalAliasMatch(r.alias, trimmed),
    );

    if (fuzzyTrgmRows && fuzzyTrgmRows.length > 0) {
      const topSimilarity = fuzzyTrgmRows[0].similarity;
      const closeRows = fuzzyTrgmRows.filter(
        (r) => r.similarity >= topSimilarity - FUZZY_TRGM_AMBIGUITY_MARGIN,
      );
      const distinctCloseLineKeys = new Set(
        closeRows.filter((r) => r.product_line_key).map((r) => r.product_line_key),
      );
      const winner =
        distinctCloseLineKeys.size <= 1 ? fuzzyTrgmRows[0] : resolveVerifiedTiebreak(closeRows);

      if (winner?.product_line_key) {
        const productKey = await resolveProductKeyForAliasEntity(supabase, winner.entity_id);
        return {
          productLineKey: winner.product_line_key,
          productKey,
          resolutionSource: 'alias_fuzzy_trgm',
          ambiguousAlias: false,
          // B0-488: rag.match_product_alias_fuzzy doesn't return the alias row id.
          matchedAliasId: null,
          matchedAliasConfidence: winner.confidence ?? null,
        };
      }
      if (distinctCloseLineKeys.size > 1) {
        sawAmbiguousAlias = true;
      }
    }
  } catch {
    // RPC unavailable (e.g. pre-migration environment) — fall through to legacy resolution.
  }

  // Try exact prod_line_id match (e.g. "4020")
  if (/^\d+$/.test(trimmed)) {
    const { data } = await supabase
      .schema('rag')
      .from('entity')
      .select('product_line_key')
      .eq('entity_type', 'product_line')
      .filter('metadata->>prod_line_id', 'eq', trimmed)
      .limit(2);

    if (data && data.length === 1 && data[0].product_line_key) {
      return {
        productLineKey: data[0].product_line_key,
        productKey: null,
        resolutionSource: 'prod_line_id',
        ambiguousAlias: false,
        matchedAliasId: null,
        matchedAliasConfidence: null,
      };
    }
  }

  // Try title ILIKE — only use if exactly 1 match to avoid wrong anchoring
  const { data } = await supabase
    .schema('rag')
    .from('entity')
    .select('product_line_key')
    .eq('entity_type', 'product_line')
    .ilike('title', `%${trimmed}%`)
    .limit(2);

  if (data && data.length === 1 && data[0].product_line_key) {
    return {
      productLineKey: data[0].product_line_key,
      productKey: null,
      resolutionSource: 'title_exact',
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: null,
    };
  }

  // B0-272: tokenized *title* fallback — last resort for names with no product_alias row at
  // all (entity.title itself may be a legacy/internal name unrelated to the commercial name,
  // per the alias fallback above). Same rule: every significant token must appear in the
  // title, and only a UNIQUE product_line match is accepted.
  const tokens = tokenizeProductName(trimmed);
  if (tokens.length >= 2) {
    let tokenQuery = supabase
      .schema('rag')
      .from('entity')
      .select('product_line_key')
      .eq('entity_type', 'product_line');
    for (const token of tokens) {
      tokenQuery = tokenQuery.ilike('title', `%${token}%`);
    }
    const { data: tokenData } = await tokenQuery.limit(2);

    if (tokenData && tokenData.length === 1 && tokenData[0].product_line_key) {
      return {
        productLineKey: tokenData[0].product_line_key,
        productKey: null,
        resolutionSource: 'title_fuzzy',
        ambiguousAlias: false,
        matchedAliasId: null,
        matchedAliasConfidence: null,
      };
    }
  }

  return {
    productLineKey: null,
    productKey: null,
    resolutionSource: null,
    ambiguousAlias: sawAmbiguousAlias,
    matchedAliasId: null,
    matchedAliasConfidence: null,
  };
}

/**
 * Resolve a free-text product name or prod_line_id to a product_line_key UUID.
 * Order: exact alias match (rag.product_alias), then prod_line_id exact, then title ILIKE.
 * Returns null if no unique match is found (ambiguous or unknown name).
 */
export async function resolveProductLineKeyByName(name: string): Promise<string | null> {
  return (await resolveProductEntityByName(name)).productLineKey;
}

/**
 * Render entity metadata as a concise markdown block for injection into LLM prompts.
 * Returns null when no entities have displayable metadata.
 */
export function buildEntityContextBlock(
  entityContextMap: Map<string, EntityContext>,
): string | null {
  if (entityContextMap.size === 0) {
    return null;
  }

  const sections: string[] = [];

  for (const ctx of entityContextMap.values()) {
    if (!ctx.title && !ctx.shortDescription && !ctx.description) {
      continue;
    }

    const name = ctx.title ?? 'Unknown Product';
    const lines: string[] = [`### ${name}`];

    if (ctx.shortDescription) {
      lines.push(ctx.shortDescription);
    }

    if (ctx.dilutionCode) {
      lines.push(`- **Dilution:** ${ctx.dilutionCode}`);
    }

    if (ctx.coverageSqFt != null) {
      lines.push(`- **Coverage:** ${ctx.coverageSqFt.toLocaleString()} sq ft/gal`);
    }

    if (ctx.description && ctx.description !== ctx.shortDescription) {
      const preview =
        ctx.description.length > 500 ? `${ctx.description.slice(0, 497)}…` : ctx.description;
      lines.push(`\n${preview}`);
    }

    sections.push(lines.join('\n'));
  }

  if (sections.length === 0) {
    return null;
  }

  return `## Product Context\n\n${sections.join('\n\n---\n\n')}`;
}
