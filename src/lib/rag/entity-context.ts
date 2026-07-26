import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

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

type ProductAliasRow = { product_line_key: string | null; entity_id: string | null };

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
 * Order: exact alias match (rag.product_alias), tokenized alias match, prod_line_id exact,
 * title ILIKE, tokenized title match.
 * Returns nulls if no unique match is found (ambiguous or unknown name) — this resolver never
 * guesses between multiple equally-plausible matches (e.g. US vs. Canada variants of the same
 * product name), by design: silently picking one would be exactly the kind of inferred
 * region/product identification the regulated-data handling rules prohibit.
 */
export async function resolveProductEntityByName(
  name: string,
): Promise<{ productLineKey: string | null; productKey: string | null }> {
  const trimmed = name.trim();
  if (!trimmed) {
    return { productLineKey: null, productKey: null };
  }

  const supabase = getSupabaseServiceRoleClient();
  const aliasClient = supabase.schema('rag') as unknown as ProductAliasClient;

  // B0-200: exact alias match first — deterministic, seeded only with unambiguous aliases.
  try {
    const { data: aliasRows } = await aliasClient
      .from('product_alias')
      .select('product_line_key, entity_id')
      .eq('alias_norm', normalizeAlias(trimmed))
      .limit(1);
    if (aliasRows && aliasRows[0]?.product_line_key) {
      const productKey = await resolveProductKeyForAliasEntity(supabase, aliasRows[0].entity_id);
      return { productLineKey: aliasRows[0].product_line_key, productKey };
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
        .select('product_line_key, entity_id');
      for (const token of aliasTokens) {
        fuzzyAliasQuery = fuzzyAliasQuery.ilike('alias_norm', `%${token}%`);
      }
      const { data: fuzzyAliasRows } = await fuzzyAliasQuery.limit(5);

      if (fuzzyAliasRows && fuzzyAliasRows.length > 0) {
        const distinctLineKeys = new Set(
          fuzzyAliasRows.filter((r) => r.product_line_key).map((r) => r.product_line_key),
        );
        if (distinctLineKeys.size === 1 && fuzzyAliasRows[0].product_line_key) {
          const productKey = await resolveProductKeyForAliasEntity(
            supabase,
            fuzzyAliasRows[0].entity_id,
          );
          return { productLineKey: fuzzyAliasRows[0].product_line_key, productKey };
        }
      }
    } catch {
      // Alias table unavailable — fall through to legacy resolution.
    }
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
      return { productLineKey: data[0].product_line_key, productKey: null };
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
    return { productLineKey: data[0].product_line_key, productKey: null };
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
      return { productLineKey: tokenData[0].product_line_key, productKey: null };
    }
  }

  return { productLineKey: null, productKey: null };
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
