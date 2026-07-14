import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * Corpus-ingestion status for legacy products (B0-100).
 *
 * The retrieval corpus is built at the PRODUCT-LINE grain: rag.source_record holds one row per
 * ingested product line (source_schema='legacy', source_table='prod_line', source_pk = the
 * prod_line ProdLineKey GUID). A legacy product (legacy.products.DSLProdLn = prod_line.ProdLineID)
 * is therefore "in the corpus" when its product line has an active source_record.
 *
 * Given a set of DSLProdLn codes, returns the subset that map to an ingested product line.
 */
export async function fetchIngestedProductLineCodes(
  prodLineCodes: string[],
): Promise<Set<string>> {
  const codes = Array.from(
    new Set(prodLineCodes.map((code) => code?.trim()).filter((c): c is string => Boolean(c))),
  );
  if (codes.length === 0) {
    return new Set<string>();
  }

  const supabase = getSupabaseServiceRoleClient();

  // 1) Map product-line codes (ProdLineID) -> ProdLineKey GUIDs. A code can map to multiple keys.
  const { data: lineRows, error: lineError } = await supabase
    .schema('legacy')
    .from('prod_line')
    .select('ProdLineID, ProdLineKey')
    .in('ProdLineID', codes);
  if (lineError) {
    throw new Error(`Product-line lookup failed: ${lineError.message}`);
  }

  const keyToCode = new Map<string, string>();
  for (const row of lineRows ?? []) {
    const code = row.ProdLineID?.trim();
    const key = row.ProdLineKey?.trim();
    if (code && key) {
      keyToCode.set(key.toUpperCase(), code);
    }
  }
  const prodLineKeys = Array.from(keyToCode.keys());
  if (prodLineKeys.length === 0) {
    return new Set<string>();
  }

  // 2) Which of those product-line keys have an active corpus source_record?
  const { data: sourceRows, error: sourceError } = await supabase
    .schema('rag')
    .from('source_record')
    .select('source_pk')
    .eq('source_schema', 'legacy')
    .eq('source_table', 'prod_line')
    .eq('is_active', true)
    .in('source_pk', prodLineKeys);
  if (sourceError) {
    throw new Error(`Corpus source-record lookup failed: ${sourceError.message}`);
  }

  const ingestedCodes = new Set<string>();
  for (const row of sourceRows ?? []) {
    const code = row.source_pk ? keyToCode.get(row.source_pk.toUpperCase()) : undefined;
    if (code) {
      ingestedCodes.add(code);
    }
  }
  return ingestedCodes;
}
