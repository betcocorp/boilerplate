#!/usr/bin/env -S npx tsx
/**
 * B0-636 — ingests the FastDraw-dispenser dilution/yield workbook (developed with FastDraw SME
 * Barry, reconciled against live Supabase) into the RAG corpus as `rag.document` /
 * `rag.document_chunk` rows with `section_type = 'dilution'` and `metadata.context =
 * 'fastdraw_dispenser'`. `~/lib/retrieval/fastdraw-dilution.ts` (B0-636 tool exposure, a parallel
 * effort) reads these chunks back out at query time — see that file for the read side and for the
 * exact `rawFastDrawChunkMetadataSchema` this script validates its own writes against.
 *
 * This is a standalone, idempotent, one-time/rerunnable batch job — it does NOT go through the
 * Next.js app, mirroring `scripts/ingest-label-md.mjs`. It talks to Supabase + OpenAI directly, and
 * (unlike ingest-label-md.mjs, which reimplements the OpenAI embeddings call inline) generates
 * embeddings via the shared `createEmbedding()` in `~/lib/rag/embeddings.ts` so behaviour can never
 * drift from the rest of the app. Because it imports that TS module via a `~/...` path alias, it
 * must be run with `tsx` (see Usage) rather than plain `node` — tsx resolves both the TypeScript
 * syntax and the `tsconfig.json` `paths` alias; plain Node cannot do either.
 *
 * All 40 SKUs are ingested, including 4125B2-00 / 4130B2-00 (SenTec Mountain Meadow / Pure Linen).
 * The original B0-636 ticket draft skipped these two because no `rag.entity` row appeared to exist
 * for their product lines. RESOLVED (2026-09-01, human decision logged in the B0-636 Jira comment
 * trail): live query confirms both entities (462577e8-87e6-40b1-922a-05387be8d924 and
 * 0c75485a-b0b9-46c9-8d5c-a5ac8555cd5a) were created 2026-07-24 — weeks before this ticket, from the
 * ordinary legacy.products sync, correctly titled and status AC. This was never drift from an
 * in-flight reconciliation effort; the ticket's original premise was simply stale at the time it was
 * written. No entity creation happens in this script either way — both already exist.
 *
 * Source data: the row shape below (see `seedRowSchema`) is the full FastDraw workbook schema
 * per the B0-636 ticket description — 12 columns per row, including `rag_entity_id` (only used as a
 * sanity cross-check; this script always re-resolves the entity live via `rag.entity.sku`, since the
 * corpus may have drifted — see the entity note above for a concrete example of that happening) and
 * `conflicts_with_legacy_dilution_code` (Barry's own reconciliation of whether the FastDraw-context
 * dilution disagrees with the general-use `rag.product_line_fact.dilution_display` — this script
 * NEVER computes that flag itself via unit conversion; it only transcribes the seed file's own
 * value, per the "never round, convert, or infer" regulated-data rule).
 *
 * Usage (repo root, requires NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY
 * in `.env.local`):
 *   npx tsx --env-file=.env.local scripts/ingest-fastdraw-dilution.mjs --input <path-to-seed.json> [--dry-run] [--skip-embeddings]
 */

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { createEmbedding, EMBEDDING_MODEL } from '~/lib/rag/embeddings.ts';
import { rawFastDrawChunkMetadataSchema } from '~/lib/retrieval/fastdraw-dilution.ts';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role.ts';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_EMBEDDINGS = args.includes('--skip-embeddings');
const inputArgIdx = args.indexOf('--input');
const INPUT_PATH = inputArgIdx !== -1 ? args[inputArgIdx + 1] : null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

if (!INPUT_PATH) {
  console.error(
    'Usage: npx tsx --env-file=.env.local scripts/ingest-fastdraw-dilution.mjs --input <path-to-seed.json> [--dry-run] [--skip-embeddings]',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DOCUMENT_KIND = 'fastdraw_dilution';
const SOURCE_SCHEMA = 'fastdraw_dilution';
const SOURCE_TABLE = 'fastdraw';
const SECTION_TYPE = 'dilution';
const HEADING = 'FastDraw Dispenser Dilution';

// ---------------------------------------------------------------------------
// Seed row schema — the full 12-column workbook shape per the B0-636 ticket. `dilution` /
// `spray_dilution` are transcribed byte-for-byte into chunk_text/metadata — never parsed, rounded,
// or reformatted. Empty-string spray fields become `null`, matching the target metadata shape.
// ---------------------------------------------------------------------------
const seedRowSchema = z.object({
  sku: z.string().min(1),
  product_name: z.string().min(1),
  dilution: z.string().min(1),
  spray_dilution: z.string(), // '' means "no spray dilution for this SKU"
  gallon_yield_per_2_liter: z.union([z.string(), z.number()]),
  gallon_yield_per_2_liter_spray: z.union([z.string(), z.number()]), // '' means none
  dsl_prod_line: z.string(),
  rag_entity_id: z.string(), // sanity cross-check only — never trusted over the live lookup
  legacy_status: z.string(),
  legacy_dilution_code_ratio: z.string(),
  conflicts_with_legacy_dilution_code: z.boolean(),
  context: z.literal('fastdraw_dispenser'),
  source: z.string().min(1),
});

function toNullableString(value) {
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function toNullableNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Expected a finite number, got: ${JSON.stringify(value)}`);
  }
  return num;
}

// ---------------------------------------------------------------------------
// Chunk text
// ---------------------------------------------------------------------------
function buildChunkText(row) {
  const yieldGallons = toNullableNumber(row.gallon_yield_per_2_liter);
  let text =
    `${row.product_name} (SKU ${row.sku}) is diluted ${row.dilution} for FastDraw dispensing, ` +
    `yielding approximately ${yieldGallons} gallons of ready-to-use solution per 2-liter concentrate bottle.`;

  const sprayDilution = toNullableString(row.spray_dilution);
  const sprayYield = toNullableNumber(row.gallon_yield_per_2_liter_spray);
  if (sprayDilution) {
    text +=
      ` In spray mode, it is diluted ${sprayDilution}` +
      (sprayYield !== null
        ? `, yielding approximately ${sprayYield} gallons per 2-liter concentrate bottle.`
        : '.');
  }

  return text;
}

function buildChunkMetadata(row) {
  const metadata = {
    dilution: row.dilution,
    spray_dilution: toNullableString(row.spray_dilution),
    gallon_yield_per_2_liter: toNullableNumber(row.gallon_yield_per_2_liter),
    gallon_yield_per_2_liter_spray: toNullableNumber(row.gallon_yield_per_2_liter_spray),
    context: row.context,
    source: row.source,
    conflicts_with_legacy_dilution_code: row.conflicts_with_legacy_dilution_code,
    has_dilution_info: true,
  };

  // Validate against the exact schema the read side (~/lib/retrieval/fastdraw-dilution.ts) expects —
  // fail loudly rather than write a shape that silently doesn't round-trip.
  return rawFastDrawChunkMetadataSchema.parse(metadata);
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------
/**
 * Resolves the PRODUCT_LINE-tier `rag.entity` for a SKU, not the product/SKU-tier entity.
 *
 * `get_efficacy_data` (`src/lib/tools/product-tools.ts`) resolves a `productLineLock` for every
 * dilution question and queries `rag.entity` by that lock's `product_line_key`
 * (`resolveFastDrawEntityIds` in `~/lib/retrieval/fastdraw-dilution.ts`). It only also resolves a
 * SKU-specific `productKey` when a product line has exactly one SKU under it — for any multi-SKU
 * product line (gallon bottles, pails, and the 2L FastDraw variant, which is the common case here),
 * no `productKey` is passed at all. A chunk attached only to the SKU-tier `product` entity is
 * therefore unreachable for most of these 40 rows — verified live 2026-09-01 via a real eval run
 * (5/14 pass) after the first ingestion attached chunks to the wrong tier. `rag.product_line_fact`
 * (the existing general-dilution fact this field sits beside) is ALSO keyed at product_line tier,
 * so this matches the established pattern rather than diverging from it.
 */
async function resolveEntityBySku(supabase, sku) {
  const { data: productEntity, error: productError } = await supabase
    .schema('rag')
    .from('entity')
    .select('id, product_key, product_line_key, title')
    .eq('entity_type', 'product')
    .eq('sku', sku)
    .maybeSingle();
  if (productError) throw new Error(`product entity lookup failed for sku ${sku}: ${productError.message}`);
  if (!productEntity) return null;
  if (!productEntity.product_line_key) {
    log(`WARNING: product entity for ${sku} (${productEntity.id}) has no product_line_key — falling back to the product-tier entity, which may be unreachable by get_efficacy_data for multi-SKU lines.`);
    return productEntity;
  }

  const { data: lineEntity, error: lineError } = await supabase
    .schema('rag')
    .from('entity')
    .select('id, product_key, product_line_key, title')
    .eq('entity_type', 'product_line')
    .eq('product_line_key', productEntity.product_line_key)
    .maybeSingle();
  if (lineError) {
    throw new Error(`product_line entity lookup failed for sku ${sku} (product_line_key=${productEntity.product_line_key}): ${lineError.message}`);
  }
  if (!lineEntity) {
    log(`WARNING: no product_line entity found for sku ${sku}'s product_line_key ${productEntity.product_line_key} — falling back to the product-tier entity.`);
    return productEntity;
  }
  return lineEntity;
}

async function findExistingDilutionChunk(supabase, entityId) {
  const { data: docs, error: docsError } = await supabase
    .schema('rag')
    .from('document')
    .select('id')
    .eq('entity_id', entityId);
  if (docsError) throw new Error(`document lookup failed for entity ${entityId}: ${docsError.message}`);
  if (!docs || docs.length === 0) return null;

  const { data: chunks, error: chunksError } = await supabase
    .schema('rag')
    .from('document_chunk')
    .select('id, chunk_key, document_id')
    .in('document_id', docs.map((d) => d.id))
    .eq('section_type', SECTION_TYPE);
  if (chunksError) {
    throw new Error(`chunk lookup failed for entity ${entityId}: ${chunksError.message}`);
  }
  return chunks && chunks.length > 0 ? chunks[0] : null;
}

async function findOrCreateSourceRecord(supabase, { sku, sourceValue }) {
  const { data: existing, error: findErr } = await supabase
    .schema('rag')
    .from('source_record')
    .select('id')
    .eq('source_schema', SOURCE_SCHEMA)
    .eq('source_table', SOURCE_TABLE)
    .eq('source_pk', sku)
    .eq('source_locale', 'en')
    .maybeSingle();
  if (findErr) throw new Error(`source_record lookup failed for ${sku}: ${findErr.message}`);
  if (existing) return existing;

  const { data: inserted, error: insErr } = await supabase
    .schema('rag')
    .from('source_record')
    .insert({
      source_schema: SOURCE_SCHEMA,
      source_table: SOURCE_TABLE,
      source_pk: sku,
      source_locale: 'en',
      source_type: DOCUMENT_KIND,
      source_uri: null,
      is_active: true,
      metadata: { sku, source: sourceValue },
    })
    .select('id')
    .single();
  if (insErr) throw new Error(`source_record insert failed for ${sku}: ${insErr.message}`);
  return inserted;
}

async function upsertDocument(supabase, { documentKey, sourceRecordId, entityId, title, bodyText }) {
  const { data: existing, error: findErr } = await supabase
    .schema('rag')
    .from('document')
    .select('id')
    .eq('document_key', documentKey)
    .maybeSingle();
  if (findErr) throw new Error(`document lookup failed for ${documentKey}: ${findErr.message}`);

  const row = {
    document_key: documentKey,
    source_record_id: sourceRecordId,
    entity_id: entityId,
    document_kind: DOCUMENT_KIND,
    title,
    language_code: 'EN',
    body_text: bodyText,
    metadata: { context: 'fastdraw_dispenser' },
  };

  if (existing) {
    const { error: updErr } = await supabase.schema('rag').from('document').update(row).eq('id', existing.id);
    if (updErr) throw new Error(`document update failed for ${documentKey}: ${updErr.message}`);
    return existing.id;
  }

  const { data: inserted, error: insErr } = await supabase
    .schema('rag')
    .from('document')
    .insert(row)
    .select('id')
    .single();
  if (insErr) throw new Error(`document insert failed for ${documentKey}: ${insErr.message}`);
  return inserted.id;
}

async function insertDilutionChunk(supabase, { documentId, documentKey, chunkText, metadata }) {
  const chunkKey = `${documentKey}:chunk:0`;
  const { data: inserted, error: insErr } = await supabase
    .schema('rag')
    .from('document_chunk')
    .insert({
      chunk_key: chunkKey,
      document_id: documentId,
      chunk_index: 0,
      section_path: [HEADING],
      heading: HEADING,
      chunk_text: chunkText,
      section_type: SECTION_TYPE,
      metadata,
    })
    .select('id')
    .single();
  if (insErr) throw new Error(`chunk insert failed for ${chunkKey}: ${insErr.message}`);
  return inserted.id;
}

// ---------------------------------------------------------------------------
// Embeddings — generated via the shared `createEmbedding()` (~/lib/rag/embeddings.ts), never
// reimplemented. Same `Heading: ...\n\n...` input convention as the rest of the corpus so the
// FastDraw chunks embed consistently with everything else `rag.match_corpus_chunks*` searches.
// ---------------------------------------------------------------------------
function buildEmbeddingInput(chunkText) {
  return `Heading: ${HEADING}\n\n${chunkText}`;
}

function toVectorLiteral(embedding) {
  return `[${embedding.join(',')}]`;
}

async function embedChunk(supabase, { chunkId, chunkText }) {
  const { embedding, model } = await createEmbedding(buildEmbeddingInput(chunkText));
  const { error: updErr } = await supabase
    .schema('rag')
    .from('document_chunk')
    .update({ embedding_large: toVectorLiteral(embedding), embedding_model_large: model })
    .eq('id', chunkId);
  if (updErr) throw new Error(`Failed to persist embedding for chunk ${chunkId}: ${updErr.message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const raw = readFileSync(INPUT_PATH, 'utf8');
  const parsedJson = JSON.parse(raw);
  const rows = z.array(seedRowSchema).parse(parsedJson);
  log(`Loaded ${rows.length} rows from ${INPUT_PATH}.`);

  const supabase = getSupabaseServiceRoleClient();

  let ingested = 0;
  let skippedNoEntity = 0;
  let skippedExistingChunk = 0;
  let failed = 0;

  const conflictsFound = [];
  const missingEntities = [];

  for (const row of rows) {
    try {
      const entity = await resolveEntityBySku(supabase, row.sku);
      if (!entity) {
        console.error(`SKIP (no live entity): ${row.sku} — no rag.entity row found for this SKU.`);
        missingEntities.push(row.sku);
        skippedNoEntity += 1;
        continue;
      }

      const existingChunk = await findExistingDilutionChunk(supabase, entity.id);
      if (existingChunk) {
        console.error(
          `CONFLICT: ${row.sku} (entity ${entity.id}) already has a dilution chunk ` +
            `(chunk_key=${existingChunk.chunk_key}) — skipping, needs a human decision.`,
        );
        conflictsFound.push({ sku: row.sku, chunkKey: existingChunk.chunk_key });
        skippedExistingChunk += 1;
        continue;
      }

      const chunkText = buildChunkText(row);
      const metadata = buildChunkMetadata(row);
      const documentKey = `${DOCUMENT_KIND}:${row.sku}:en`;
      const title = `${row.product_name} — FastDraw Dispenser Dilution`;

      if (DRY_RUN) {
        log(`[dry-run] ${row.sku} -> entity=${entity.id} documentKey=${documentKey}`);
        log(`[dry-run]   chunkText="${chunkText}"`);
        ingested += 1;
        continue;
      }

      const sourceRecord = await findOrCreateSourceRecord(supabase, { sku: row.sku, sourceValue: row.source });
      const documentId = await upsertDocument(supabase, {
        documentKey,
        sourceRecordId: sourceRecord.id,
        entityId: entity.id,
        title,
        bodyText: chunkText,
      });
      const chunkId = await insertDilutionChunk(supabase, { documentId, documentKey, chunkText, metadata });

      if (!SKIP_EMBEDDINGS) {
        await embedChunk(supabase, { chunkId, chunkText });
      }

      ingested += 1;
      log(`Ingested ${row.sku} (entity ${entity.id}, chunk ${chunkId}).`);
    } catch (err) {
      failed += 1;
      console.error(`FAILED: ${row.sku}: ${err instanceof Error ? err.message : err}`);
    }
  }

  log(
    `Done. ingested=${ingested} skippedNoEntity=${skippedNoEntity} ` +
      `skippedExistingChunk=${skippedExistingChunk} failed=${failed} model=${EMBEDDING_MODEL}`,
  );
  if (missingEntities.length > 0) {
    log(`SKUs with no live entity: ${missingEntities.join(', ')}`);
  }
  if (conflictsFound.length > 0) {
    log(`Real conflicts needing a human decision: ${JSON.stringify(conflictsFound)}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
