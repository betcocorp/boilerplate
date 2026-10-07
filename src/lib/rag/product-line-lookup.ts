import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

function readMetadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolves the legacy ERP product-line code (`rag.entity.metadata->>'prod_line_id'`,
 * e.g. "H610") for a set of `product_line_key` UUIDs. Distinct from `product_line_key`
 * itself — only `entity_type = 'product_line'` rows carry this legacy code; ordinary
 * `product`-type entities (and therefore SDS/label/efficacy chunks) only have the key.
 * Admin-display lookup only — never called from the live retrieval/answer path.
 */
export async function getProdLineIdsByProductLineKeys(
  productLineKeys: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const uniqueKeys = Array.from(new Set(productLineKeys.filter(Boolean)));
  if (uniqueKeys.length === 0) {
    return result;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('entity')
    .select('product_line_key, metadata')
    .eq('entity_type', 'product_line')
    .in('product_line_key', uniqueKeys);

  if (error || !data) {
    return result;
  }

  for (const row of data as Array<{ product_line_key: string | null; metadata: unknown }>) {
    if (!row.product_line_key) {
      continue;
    }
    result.set(row.product_line_key, readMetadataString(row.metadata, 'prod_line_id'));
  }

  return result;
}
