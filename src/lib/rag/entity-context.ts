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

/**
 * Resolve a free-text product name or prod_line_id to a product_line_key UUID.
 * Tries prod_line_id exact match first, then title ILIKE.
 * Returns null if no unique match is found (ambiguous or unknown name).
 */
export async function resolveProductLineKeyByName(name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  const supabase = getSupabaseServiceRoleClient();

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
      return data[0].product_line_key;
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
    return data[0].product_line_key;
  }

  return null;
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
