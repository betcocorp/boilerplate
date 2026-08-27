#!/usr/bin/env node
/**
 * B0-264 pass 2 — run the deterministic label dilution extractor over every product line that
 * has an ingested label document but NO dilution coverage yet, and print a per-candidate
 * disposition. Read-only: this script never writes.
 *
 * Coverage is defined the way `src/lib/retrieval/product-facts.ts` reads it: a line is covered
 * when a line-level `rag.product_line_fact` row carries `dilution_oz_per_gal` or
 * `dilution_display`, or when `rag.entity.metadata->>'dilution_code'` is set (the B0-194 source).
 *
 * Usage:
 *   node scripts/extract-label-dilution.ts                 # disposition for every candidate doc
 *   node scripts/extract-label-dilution.ts --limit 20
 *   node scripts/extract-label-dilution.ts --extracted-only
 *   node scripts/extract-label-dilution.ts --sql           # emit the promote INSERT for review
 *
 * `service_role` holds SELECT-only on the fact tables
 * (20260717120000_grant_service_role_on_fact_tables.sql), so the load ships as a reviewed SQL
 * migration with a full per-candidate paper trail — same as B0-264 pass 1 and B0-265.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type {
  DilutionExtraction,
  ExtractDilutionOptions,
} from '../src/lib/label/extract-dilution-from-label';

/**
 * Loaded through a computed specifier so `tsc` (which forbids a literal `.ts` import extension)
 * and Node 24's native type-stripping (which requires one) can both live with this file. The types
 * still come from the real module via the `import type` above.
 */
const extractor = (await import(
  new URL('../src/lib/label/extract-dilution-from-label.ts', import.meta.url).href
)) as {
  extractDilutionFromLabel: (
    body: string | null | undefined,
    options?: ExtractDilutionOptions,
  ) => DilutionExtraction;
  extractRtuStatement: (body: string | null | undefined) => { rtu: true; statement: string } | null;
};
const { extractDilutionFromLabel, extractRtuStatement } = extractor;

const __dir = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(resolve(__dir, '../.env.local'), 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1).trim();
  }
} catch {
  // already set in the environment
}

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : null;
const extractedOnly = args.includes('--extracted-only');
const emitSql = args.includes('--sql');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false }, db: { schema: 'rag' } },
);

/** The narrow slice of the PostgREST builder this script uses, so no `any` leaks in. */
interface Queryable {
  eq(column: string, value: unknown): Queryable;
  is(column: string, value: unknown): Queryable;
  not(column: string, operator: string, value: unknown): Queryable;
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
}

/** PostgREST caps a single response at 1000 rows (db-max-rows), so every read pages explicitly. */
async function selectAll<T>(
  table: string,
  columns: string,
  shape: (query: Queryable) => Queryable = (query) => query,
): Promise<T[]> {
  const page = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const builder = supabase.from(table).select(columns) as unknown as Queryable;
    const { data, error } = await shape(builder).range(from, from + page - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

interface EntityRow {
  id: string;
  entity_type: string;
  product_line_key: string | null;
  title: string | null;
  metadata: Record<string, unknown> | null;
}
interface FactRow {
  entity_id: string;
  dilution_oz_per_gal: number | null;
  dilution_display: string | null;
}
interface DocRow {
  id: string;
  source_record_id: string | null;
  entity_id: string | null;
  title: string | null;
  body_markdown: string | null;
  body_text: string | null;
  document_kind?: string;
}

const entities = await selectAll<EntityRow>('entity', 'id, entity_type, product_line_key, title, metadata');
const facts = await selectAll<FactRow>(
  'product_line_fact',
  'entity_id, dilution_oz_per_gal, dilution_display',
  (q) => q.is('product_key', null),
);
/**
 * `label` is the primary source. `product_line_profile` is included because it is the ONLY ingested
 * document that exists for every line (1,703 of them) and it carries the legacy Directions-for-Use
 * prose; `sds` is deliberately excluded — 0 of 900 SDS documents on uncovered lines print an oz/gal
 * figure, and every `1:N` in an SDS is chemical-name stoichiometry, not a use dilution.
 */
const SOURCE_DOCUMENT_KINDS = ['label', 'product_line_profile'];

const docs: DocRow[] = [];
for (const kind of SOURCE_DOCUMENT_KINDS) {
  docs.push(
    ...(await selectAll<DocRow>(
      'document',
      'id, source_record_id, entity_id, title, body_markdown, body_text, document_kind',
      (q) => q.eq('document_kind', kind).not('entity_id', 'is', null),
    )),
  );
}

const entityById = new Map(entities.map((e) => [e.id, e]));
const lineByProductLineKey = new Map<string, EntityRow>();
for (const entity of entities) {
  if (entity.entity_type === 'product_line' && entity.product_line_key) {
    lineByProductLineKey.set(entity.product_line_key, entity);
  }
}
const covered = new Set(
  facts.filter((f) => f.dilution_oz_per_gal !== null || f.dilution_display !== null).map((f) => f.entity_id),
);

interface Candidate {
  lineEntityId: string;
  lineTitle: string;
  productLineKey: string;
  docId: string;
  docKind: string;
  docTitle: string;
  sourceRecordId: string | null;
  body: string;
  linkedEntityType: string;
  linkedProductKey: string | null;
}

const candidates: Candidate[] = [];
for (const doc of docs) {
  const linked = doc.entity_id ? entityById.get(doc.entity_id) : undefined;
  const productLineKey = linked?.product_line_key ?? null;
  if (!productLineKey) continue;
  const line = lineByProductLineKey.get(productLineKey);
  if (!line) continue;
  // Coverage is judged ONLY by what get_efficacy_data can read back. A non-empty
  // metadata->>'dilution_code' does not imply coverage: the '0' sentinel is the ambiguous
  // RTU/unparsed case that B0-265 explicitly queued for this pass.
  if (covered.has(line.id)) continue;
  candidates.push({
    lineEntityId: line.id,
    lineTitle: line.title ?? '',
    productLineKey,
    docId: doc.id,
    docKind: doc.document_kind ?? 'label',
    docTitle: doc.title ?? '',
    sourceRecordId: doc.source_record_id,
    body: doc.body_markdown ?? doc.body_text ?? '',
    linkedEntityType: linked?.entity_type ?? '',
    linkedProductKey: (linked?.metadata?.product_key as string | undefined) ?? null,
  });
}
candidates.sort((a, b) => a.lineTitle.localeCompare(b.lineTitle) || a.docTitle.localeCompare(b.docTitle));

const scoped = limit ? candidates.slice(0, limit) : candidates;
const reasonCounts = new Map<string, number>();
const sqlRows: string[] = [];
let extractedCount = 0;

for (const row of scoped) {
  const result = extractDilutionFromLabel(row.body, { productTitle: row.docTitle });
  if (result.status === 'extracted') {
    extractedCount += 1;
    console.log(
      [
        'EXTRACT',
        row.lineTitle,
        `doc="${row.docTitle}"`,
        `oz_per_gal=${result.ozPerGal}`,
        `display="${result.display}"`,
        `entity=${row.lineEntityId}`,
        `variant_product_key=${row.linkedEntityType === 'product' ? (row.linkedProductKey ?? '?') : 'n/a'}`,
        `source_record=${row.sourceRecordId ?? 'null'}`,
      ].join(' | '),
    );
    sqlRows.push(
      `  ('${row.lineEntityId}', ${result.ozPerGal}, '${result.display.replace(/'/g, "''")}', 0.75, ` +
        `${row.sourceRecordId ? `'${row.sourceRecordId}'` : 'null'}), -- ${row.lineTitle} / ${row.docTitle}`,
    );
  } else if (result.reason === 'ready_to_use' && extractRtuStatement(row.body)) {
    // Explicit printed RTU with no dilution figure anywhere in the document — "Ready to use" is a
    // real answer (B0-265 precedent) and carries no numeric risk.
    extractedCount += 1;
    const statement = extractRtuStatement(row.body)!.statement;
    console.log(
      [
        'RTU    ',
        row.lineTitle,
        `doc="${row.docTitle}" (${row.docKind})`,
        `statement="${statement}"`,
        `entity=${row.lineEntityId}`,
        `source_record=${row.sourceRecordId ?? 'null'}`,
      ].join(' | '),
    );
    sqlRows.push(
      `  ('${row.lineEntityId}', null, 'Ready to use', 0.75, ` +
        `${row.sourceRecordId ? `'${row.sourceRecordId}'` : 'null'}), -- ${row.lineTitle} / ${row.docTitle} — "${statement}"`,
    );
  } else {
    reasonCounts.set(result.reason, (reasonCounts.get(result.reason) ?? 0) + 1);
    if (!extractedOnly) {
      console.log(
        ['SKIP   ', row.lineTitle, `doc="${row.docTitle}"`, `reason=${result.reason}`, result.detail ?? '']
          .join(' | ')
          .trimEnd(),
      );
    }
  }
}

console.log('\n--- summary ---');
console.log(`candidate label documents : ${scoped.length}`);
console.log(`distinct candidate lines  : ${new Set(scoped.map((r) => r.lineEntityId)).size}`);
console.log(`extracted                 : ${extractedCount}`);
for (const [reason, count] of [...reasonCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`skipped:${reason.padEnd(22)}: ${count}`);
}

if (emitSql && sqlRows.length > 0) {
  console.log('\n--- promote SQL (REVIEW EVERY ROW AGAINST THE PRINTED LABEL BEFORE APPLYING) ---');
  console.log(
    'insert into rag.product_line_fact (entity_id, dilution_oz_per_gal, dilution_display, confidence, source_record_id)',
  );
  console.log('values');
  console.log(sqlRows.join('\n'));
}
