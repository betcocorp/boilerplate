import { z } from 'zod';

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-636 — FastDraw dispenser-specific dilution/yield data, ingested from the FastDraw workbook
 * (`scripts/ingest-fastdraw-dilution.mjs`) into `rag.document_chunk` rows with
 * `section_type = 'dilution'` and `metadata.context = 'fastdraw_dispenser'`. Each such chunk hangs
 * off a `rag.document` whose `entity_id` anchors it to the product.
 *
 * This is a DISTINCT, separately-labeled sibling to `get_efficacy_data`'s `facts.dilutionDisplay`
 * (general-use dilution from `rag.product_line_fact`) — for roughly 8 of the 40 FastDraw SKUs the
 * two values disagree because they describe different dilution CONTEXTS (general use vs. the
 * FastDraw dispenser). `~/lib/tools/product-tools.ts` must never merge this into `facts`; see the
 * `fastDrawDilution` field it returns alongside (not inside) `facts`.
 */
export const fastDrawDilutionSchema = z.object({
  dilution: z.string(),
  sprayDilution: z.string().nullable(),
  gallonYieldPer2Liter: z.number(),
  gallonYieldPer2LiterSpray: z.number().nullable(),
  conflictsWithLegacyDilutionCode: z.boolean(),
});

export type FastDrawDilution = z.infer<typeof fastDrawDilutionSchema>;

export type FastDrawDilutionLookup = {
  fastDrawDilution: FastDrawDilution;
  documentId: string;
  chunkId: string;
  title: string;
  /** The chunk's own text — a real, citable `rag.document_chunk`, not a synthesized facts block. */
  documentBody: string;
};

/**
 * The chunk's `metadata` jsonb shape exactly as ingestion writes it (snake_case, per B0-636). Parsed
 * defensively — untrusted DB jsonb, never assumed to match — and mapped to the camelCase
 * `FastDrawDilution` shape explicitly below rather than passed through.
 *
 * Exported so `scripts/ingest-fastdraw-dilution.mjs` (via tsx) validates the exact metadata shape it
 * writes against this same schema, rather than a second hand-maintained copy drifting out of sync.
 */
export const rawFastDrawChunkMetadataSchema = z.object({
  dilution: z.string(),
  spray_dilution: z.string().nullable(),
  gallon_yield_per_2_liter: z.number(),
  gallon_yield_per_2_liter_spray: z.number().nullable(),
  context: z.literal('fastdraw_dispenser'),
  source: z.string(),
  conflicts_with_legacy_dilution_code: z.boolean(),
  has_dilution_info: z.literal(true),
});

function toFastDrawDilution(
  raw: z.infer<typeof rawFastDrawChunkMetadataSchema>,
): FastDrawDilution {
  return {
    dilution: raw.dilution,
    sprayDilution: raw.spray_dilution,
    gallonYieldPer2Liter: raw.gallon_yield_per_2_liter,
    gallonYieldPer2LiterSpray: raw.gallon_yield_per_2_liter_spray,
    conflictsWithLegacyDilutionCode: raw.conflicts_with_legacy_dilution_code,
  };
}

/**
 * Resolves the entity ids that could anchor a FastDraw dilution chunk for this product — both the
 * product (SKU) tier and the product_line tier, same two-tier shape `fetchFactsForProductLineKeys`
 * reads (`~/lib/retrieval/product-facts.ts`) since ingestion may have linked a chunk to either,
 * depending on whether the workbook row's ratio is shared across the whole line or specific to one
 * SKU. Product-tier ids are returned first so a SKU-specific chunk outranks a line-level one when a
 * caller has to pick a single winner.
 */
async function resolveFastDrawEntityIds(
  productLineKey: string | null,
  productKey: string | null,
): Promise<string[]> {
  if (!productLineKey && !productKey) {
    return [];
  }

  const rag = getSupabaseServiceRoleClient().schema('rag');
  const [productRes, lineRes] = await Promise.all([
    productKey
      ? rag.from('entity').select('id').eq('entity_type', 'product').eq('product_key', productKey)
      : Promise.resolve({ data: [] as { id: string }[], error: null }),
    productLineKey
      ? rag
          .from('entity')
          .select('id')
          .eq('entity_type', 'product_line')
          .eq('product_line_key', productLineKey)
      : Promise.resolve({ data: [] as { id: string }[], error: null }),
  ]);

  if (productRes.error || lineRes.error) {
    return [];
  }

  return [...(productRes.data ?? []).map((r) => r.id), ...(lineRes.data ?? []).map((r) => r.id)];
}

/**
 * Fetches the FastDraw-dispenser dilution/yield chunk for a resolved product, if one exists.
 * Returns null when there is no such chunk, or when a found chunk's `metadata` doesn't match the
 * expected ingested shape (degrade gracefully — never fabricate a value from malformed metadata).
 *
 * Distinct from, and never merged with, `fetchFactsForProductLineKey`/`fetchFactsForProductLineKeys`
 * — see the module doc above.
 */
export async function fetchFastDrawDilution(
  productLineKey: string | null,
  productKey: string | null,
): Promise<FastDrawDilutionLookup | null> {
  const entityIds = await resolveFastDrawEntityIds(productLineKey, productKey);
  if (entityIds.length === 0) {
    return null;
  }

  const rag = getSupabaseServiceRoleClient().schema('rag');
  const { data: docs, error: docsError } = await rag
    .from('document')
    .select('id, entity_id, title')
    .in('entity_id', entityIds);
  if (docsError || !docs || docs.length === 0) {
    return null;
  }

  const { data: chunks, error: chunksError } = await rag
    .from('document_chunk')
    .select('id, document_id, chunk_text, metadata')
    .in(
      'document_id',
      docs.map((d) => d.id),
    )
    .eq('section_type', 'dilution');
  if (chunksError || !chunks) {
    return null;
  }

  // Rank by entity priority (product tier before product_line tier — see resolveFastDrawEntityIds),
  // then keep only chunks actually flagged as FastDraw-context.
  const entityRank = new Map(entityIds.map((id, index) => [id, index]));
  const docRank = new Map(
    docs.map((d) => [d.id, d.entity_id ? (entityRank.get(d.entity_id) ?? entityIds.length) : entityIds.length]),
  );

  const candidates = chunks
    .filter((c) => {
      const meta = c.metadata;
      return (
        meta != null &&
        typeof meta === 'object' &&
        !Array.isArray(meta) &&
        (meta as Record<string, unknown>).context === 'fastdraw_dispenser'
      );
    })
    .sort((a, b) => (docRank.get(a.document_id) ?? 99) - (docRank.get(b.document_id) ?? 99));

  const winner = candidates[0];
  if (!winner) {
    return null;
  }

  const parsed = rawFastDrawChunkMetadataSchema.safeParse(winner.metadata);
  if (!parsed.success) {
    return null;
  }

  const doc = docs.find((d) => d.id === winner.document_id);

  return {
    fastDrawDilution: toFastDrawDilution(parsed.data),
    documentId: winner.document_id,
    chunkId: winner.id,
    title: doc?.title ?? 'FastDraw Dispenser Dilution',
    documentBody: winner.chunk_text,
  };
}
