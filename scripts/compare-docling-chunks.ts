#!/usr/bin/env -S npx tsx
/**
 * Does docling's markdown chunk better than the live SDS path?
 *
 * The live path is pdfjs text extraction (`admin/sds/pipeline.ts:parsePdf`) followed by
 * `rag.chunk_sds_document_text`, and it loses 59% of SDS sections — the extractor flattens each
 * page to one line, and the chunker discards any section with no newline in it
 * (`src/docs/sds-chunk-section-loss.md`). This script measures whether converting the same PDFs
 * with docling and chunking the result recovers that content, and which chunker to pair it with.
 *
 * Driven by `sds-chunk-loss-sample40.csv` — the stratified 40-document sample (8 per loss band,
 * A through E) with the PDFs already downloaded to `dump/sds/`. The CSV's own `loss_pct` is the
 * baseline every variant here is measured against, so results are comparable to the defect doc
 * rather than to a fresh arbitrary sample.
 *
 * READ-ONLY against Supabase. It never writes a chunk, a document, or an embedding —
 * `rag.chunk_sds_document_text` is a pure table-returning function, so the SQL chunker can be run
 * over docling markdown without touching the corpus.
 *
 * ## Three phases
 *
 *   1. npx tsx --env-file=.env.local scripts/compare-docling-chunks.ts --plan --per-band 1
 *        Reads the CSV, resolves each row's local_pdf_path, writes <workdir>/manifest.json.
 *
 *   2. uv run --with docling scripts/docling/convert-sds-pdfs.py <workdir>
 *        PDFs -> <workdir>/md/<documentId>.md.
 *
 *   3. npx tsx --env-file=.env.local scripts/compare-docling-chunks.ts --compare
 *        Chunks each markdown three ways and writes report.md + per-document.jsonl.
 *
 *   4. npx tsx --env-file=.env.local scripts/compare-docling-chunks.ts --deltas --per-band 1
 *        Writes chunk-deltas.md: per document, the live and docling chunk inventories side by side
 *        plus the sentences each side has and the other does not. The aggregate report says how
 *        much is missing; this says WHAT is missing, in the document's own words.
 *
 * ## What gets compared
 *
 *   live      rag.document_chunk as it stands today (pdfjs text -> SQL SDS chunker)
 *   pdfjsSql  pdfjs body_text -> rag.chunk_sds_document_text, recomputed now
 *   sql       docling markdown -> rag.chunk_sds_document_text (same chunker, better text)
 *   markdown  docling markdown -> chunkMarkdown() from ~/lib/rag/markdown-chunking
 *
 * `pdfjsSql` exists because `live` is not purely the current chunker: 10 of the 40 sample rows are
 * `chunk_generation = first-gen`, chunks written by an older implementation and never refreshed
 * (`RSS607SU6040` stores one chunk at 0.3% coverage, where today's chunker over the same body
 * yields 13 at 47%). Crediting docling with that difference would be crediting it with a rechunk.
 * `pdfjsSql` holds the extractor fixed and the chunker current, so `pdfjsSql` -> `sql` is the
 * extractor's contribution alone, and `live` -> `pdfjsSql` is staleness.
 *
 * `markdown` then shows what a heading-aware chunker does with markdown headings the SQL chunker
 * cannot see (it only looks for "Section N."). Its coverage reads ~8% low by construction —
 * chunkMarkdown keeps heading text in the `heading` column, and headings are 8-12% of a docling
 * file — so compare it on probes, not on the coverage column.
 *
 * Coverage is chunk chars / source chars, the same ratio src/docs/sds-chunk-section-loss.md
 * reports. Probes search chunk_text, heading and section_path together — the widened predicate
 * that doc had to adopt, because chunkMarkdown keeps the heading out of chunk_text while the SQL
 * chunker prepends it.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chunkMarkdown, estimateTokens } from '~/lib/rag/markdown-chunking';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

const DEFAULT_CSV = 'sds-chunk-loss-sample40.csv';
const DEFAULT_WORKDIR = 'tmp/docling-compare';

/** Regulated strings whose survival is the actual question. Mirrors the impact table in the defect doc. */
const PROBES: Array<{ id: string; test: (text: string) => boolean }> = [
  { id: 'first_aid', test: (t) => /get medical attention/i.test(t) },
  { id: 'signal_word', test: (t) => /signal word/i.test(t) },
  { id: 'cas_number', test: (t) => /\b\d{2,7}-\d{2}-\d\b/.test(t) },
  { id: 'first_aid_section', test: (t) => /first[- ]aid/i.test(t) },
  { id: 'disposal', test: (t) => /disposal considerations/i.test(t) },
];

type Args = {
  mode: 'plan' | 'compare' | 'deltas' | 'rebuild';
  csv: string;
  workdir: string;
  perBand: number | null;
  limit: number | null;
  band: string | null;
};

function parseArgs(argv: string[]): Args {
  const mode = argv.includes('--plan')
    ? 'plan'
    : argv.includes('--compare')
      ? 'compare'
      : argv.includes('--deltas')
        ? 'deltas'
        : argv.includes('--rebuild')
          ? 'rebuild'
          : null;
  if (!mode) {
    throw new Error(
      'Pass --plan, --compare, --deltas or --rebuild. See the header comment for the phases.',
    );
  }

  const readFlag = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const readCount = (name: string) => {
    const raw = readFlag(name);
    if (raw === undefined) return null;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer, got ${raw}`);
    }
    return value;
  };

  return {
    mode,
    csv: path.resolve(readFlag('--csv') ?? DEFAULT_CSV),
    workdir: path.resolve(readFlag('--workdir') ?? DEFAULT_WORKDIR),
    perBand: readCount('--per-band'),
    limit: readCount('--limit'),
    band: readFlag('--band') ?? null,
  };
}

// --- CSV ------------------------------------------------------------------

/** Minimal RFC-4180 reader: the sample CSV has quoted titles and paths containing commas. */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((entry) => entry.some((cell) => cell.trim().length > 0));
  if (!header) {
    throw new Error('CSV had no header row.');
  }

  return body.map((cells) =>
    Object.fromEntries(header.map((name, index) => [name.trim(), (cells[index] ?? '').trim()])),
  );
}

type SampleRow = {
  band: string;
  documentId: string;
  title: string;
  bodyChars: number;
  chunkChars: number;
  lossPct: number;
  chunkCount: number;
  chunkGeneration: string;
  s3Key: string;
  pdfPath: string;
};

function toSampleRows(records: Array<Record<string, string>>): SampleRow[] {
  return records.map((record) => ({
    band: record.band,
    documentId: record.document_id,
    title: record.title,
    bodyChars: Number(record.body_chars || 0),
    chunkChars: Number(record.chunk_chars || 0),
    lossPct: Number(record.loss_pct || 0),
    chunkCount: Number(record.chunk_count || 0),
    chunkGeneration: record.chunk_generation,
    s3Key: record.s3_key,
    pdfPath: record.local_pdf_path,
  }));
}

/** Keep the band strata intact when subsetting: N per band beats the first N rows overall. */
function selectRows(rows: SampleRow[], args: Args): SampleRow[] {
  const filtered = args.band
    ? rows.filter((row) => row.band.toUpperCase().startsWith(args.band!.toUpperCase()))
    : rows;

  let selected = filtered;
  if (args.perBand) {
    const seen = new Map<string, number>();
    selected = filtered.filter((row) => {
      const count = seen.get(row.band) ?? 0;
      if (count >= args.perBand!) return false;
      seen.set(row.band, count + 1);
      return true;
    });
  }

  return args.limit ? selected.slice(0, args.limit) : selected;
}

// --- Supabase -------------------------------------------------------------

type DocumentRow = {
  id: string;
  title: string;
  body_text: string | null;
};

type ChunkRow = {
  document_id: string;
  chunk_text: string;
  heading: string | null;
  section_path: string[] | null;
  token_count: number | null;
};

type SqlChunk = {
  chunk_index: number;
  heading: string | null;
  section_path: string[] | null;
  chunk_text: string;
  token_count: number | null;
};

type QueryResult = Promise<{ data: unknown[] | null; error: { message: string } | null }>;

/**
 * The generated Supabase types do not resolve `.schema('rag').from(...)` chains under strict mode,
 * which is why the rest of this codebase casts at each call site. Same here.
 */
type LooseFilter = {
  in(col: string, vals: readonly unknown[]): LooseFilter;
  limit(n: number): QueryResult;
};

function ragTable(table: string): { select(cols: string): LooseFilter } {
  const client = getSupabaseServiceRoleClient().schema('rag') as unknown as {
    from(table: string): { select(cols: string): LooseFilter };
  };
  return client.from(table);
}

async function fetchDocuments(documentIds: string[]): Promise<Map<string, DocumentRow>> {
  if (documentIds.length === 0) return new Map();

  const { data, error } = await ragTable('document')
    .select('id, title, body_text')
    .in('id', documentIds)
    .limit(documentIds.length);

  if (error) {
    throw new Error(`Failed to load document bodies: ${error.message}`);
  }

  return new Map(((data ?? []) as DocumentRow[]).map((row) => [row.id, row]));
}

async function fetchLiveChunks(documentIds: string[]): Promise<Map<string, ChunkRow[]>> {
  const byDocument = new Map<string, ChunkRow[]>();
  if (documentIds.length === 0) return byDocument;

  const { data, error } = await ragTable('document_chunk')
    .select('document_id, chunk_text, heading, section_path, token_count')
    .in('document_id', documentIds)
    .limit(10_000);

  if (error) {
    throw new Error(`Failed to load live chunks: ${error.message}`);
  }

  for (const row of (data ?? []) as ChunkRow[]) {
    const list = byDocument.get(row.document_id) ?? [];
    list.push(row);
    byDocument.set(row.document_id, list);
  }

  return byDocument;
}

/** Run the live SQL chunker over arbitrary text. Pure function — writes nothing. */
async function chunkWithSql(bodyText: string, title: string): Promise<SqlChunk[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await (
    supabase.schema('rag') as unknown as {
      rpc(
        fn: string,
        args: Record<string, unknown>,
      ): Promise<{ data: SqlChunk[] | null; error: { message: string } | null }>;
    }
  ).rpc('chunk_sds_document_text', {
    p_body_text: bodyText,
    p_max_chars: 1600,
    p_overlap_chars: 150,
    p_title: title,
  });

  if (error) {
    throw new Error(`chunk_sds_document_text failed: ${error.message}`);
  }

  return data ?? [];
}

// --- Phase 1: plan --------------------------------------------------------

type ManifestDocument = SampleRow & { pdfPathAbsolute: string };
type Manifest = { generatedAt: string; csv: string; documents: ManifestDocument[] };

async function runPlan(args: Args) {
  const rows = toSampleRows(parseCsv(await readFile(args.csv, 'utf-8')));
  const selected = selectRows(rows, args);

  if (selected.length === 0) {
    throw new Error(`No rows selected from ${path.basename(args.csv)}.`);
  }

  const repoRoot = process.cwd();
  const documents: ManifestDocument[] = [];
  for (const row of selected) {
    const pdfPathAbsolute = path.resolve(repoRoot, row.pdfPath);
    const exists = await readFile(pdfPathAbsolute)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      console.warn(`skip ${row.documentId} (${row.title}): missing PDF at ${row.pdfPath}`);
      continue;
    }
    documents.push({ ...row, pdfPathAbsolute });
  }

  await mkdir(args.workdir, { recursive: true });
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    csv: args.csv,
    documents,
  };
  await writeFile(
    path.join(args.workdir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const byBand = new Map<string, number>();
  for (const doc of documents) {
    byBand.set(doc.band, (byBand.get(doc.band) ?? 0) + 1);
  }

  console.log(`${documents.length} documents planned:`);
  for (const [band, count] of [...byBand].sort()) {
    console.log(`  ${band}: ${count}`);
  }
  console.log(`\nNext: uv run --with docling scripts/docling/convert-sds-pdfs.py ${args.workdir}`);
}

// --- Phase 3: compare -----------------------------------------------------

type VariantStats = {
  chunks: number;
  chars: number;
  tokens: number;
  coverage: number;
  sections: string[];
  probes: Record<string, boolean>;
};

type AnyChunk = {
  chunk_text: string;
  heading?: string | null;
  section_path?: string[] | null;
  token_count?: number | null;
};

/** Every column a chunk can carry text in — the widened predicate from the defect doc. */
function chunkSearchText(chunk: AnyChunk) {
  return [chunk.chunk_text, chunk.heading ?? '', (chunk.section_path ?? []).join(' ')].join('\n');
}

function summarizeVariant(chunks: AnyChunk[], sourceChars: number): VariantStats {
  const chars = chunks.reduce((sum, chunk) => sum + chunk.chunk_text.length, 0);
  const tokens = chunks.reduce(
    (sum, chunk) => sum + (chunk.token_count ?? estimateTokens(chunk.chunk_text)),
    0,
  );
  const haystack = chunks.map(chunkSearchText).join('\n');
  const sections = Array.from(
    new Set(chunks.map((chunk) => (chunk.section_path ?? []).join('/')).filter(Boolean)),
  ).sort();

  return {
    chunks: chunks.length,
    chars,
    tokens,
    coverage: sourceChars > 0 ? chars / sourceChars : 0,
    sections,
    probes: Object.fromEntries(PROBES.map((probe) => [probe.id, probe.test(haystack)])),
  };
}

type DocumentReport = {
  documentId: string;
  band: string;
  title: string;
  csvLossPct: number;
  bodyChars: number;
  doclingChars: number;
  doclingTableRows: number;
  doclingHeadings: number;
  bodyProbes: Record<string, boolean>;
  doclingProbes: Record<string, boolean>;
  live: VariantStats;
  pdfjsSql: VariantStats;
  sql: VariantStats;
  markdown: VariantStats;
};

const VARIANTS = ['live', 'pdfjsSql', 'sql', 'markdown'] as const;

async function runCompare(args: Args) {
  const manifest = JSON.parse(
    await readFile(path.join(args.workdir, 'manifest.json'), 'utf-8'),
  ) as Manifest;

  const mdDir = path.join(args.workdir, 'md');
  const mdFiles = new Set(
    (await readdir(mdDir).catch(() => [])).filter((name) => name.endsWith('.md')),
  );
  if (mdFiles.size === 0) {
    throw new Error(`No markdown in ${mdDir}. Run the docling converter (phase 2) first.`);
  }

  const documentIds = manifest.documents.map((doc) => doc.documentId);
  const [documents, liveChunks] = await Promise.all([
    fetchDocuments(documentIds),
    fetchLiveChunks(documentIds),
  ]);

  const reports: DocumentReport[] = [];

  for (const doc of manifest.documents) {
    if (!mdFiles.has(`${doc.documentId}.md`)) {
      console.warn(`skip ${doc.documentId} (${doc.title}): no docling markdown`);
      continue;
    }

    const markdown = await readFile(path.join(mdDir, `${doc.documentId}.md`), 'utf-8');
    // Prefer the live body, but fall back to the CSV's char count if the row is gone from the DB.
    const bodyText = documents.get(doc.documentId)?.body_text ?? '';
    const live = liveChunks.get(doc.documentId) ?? [];

    const sqlChunks = await chunkWithSql(markdown, doc.title);
    // Empty body_text would make the recomputed variant a meaningless 0 rather than a measurement.
    const pdfjsSqlChunks = bodyText ? await chunkWithSql(bodyText, doc.title) : [];
    const mdChunks: AnyChunk[] = chunkMarkdown(markdown).map((chunk) => ({
      chunk_text: chunk.text,
      heading: chunk.heading,
      section_path: chunk.sectionPath,
      token_count: estimateTokens(chunk.text),
    }));

    const report: DocumentReport = {
      documentId: doc.documentId,
      band: doc.band,
      title: doc.title,
      csvLossPct: doc.lossPct,
      bodyChars: bodyText.length || doc.bodyChars,
      doclingChars: markdown.length,
      doclingTableRows: (markdown.match(/^\s*\|.*\|\s*$/gm) ?? []).length,
      doclingHeadings: (markdown.match(/^#{1,6}\s+\S/gm) ?? []).length,
      bodyProbes: Object.fromEntries(PROBES.map((probe) => [probe.id, probe.test(bodyText)])),
      doclingProbes: Object.fromEntries(PROBES.map((probe) => [probe.id, probe.test(markdown)])),
      // Each variant is measured against the text it was actually built from — live against the
      // pdfjs body, the docling variants against the markdown. Crossing them would report a ratio
      // between two unrelated extractions.
      live: summarizeVariant(live, bodyText.length || doc.bodyChars),
      pdfjsSql: summarizeVariant(pdfjsSqlChunks, bodyText.length || doc.bodyChars),
      sql: summarizeVariant(sqlChunks, markdown.length),
      markdown: summarizeVariant(mdChunks, markdown.length),
    };
    reports.push(report);

    const stale = report.live.coverage + 0.01 < report.pdfjsSql.coverage ? ' STALE' : '';
    console.log(
      `[${report.band}] ${report.title}: live ${pct(report.live.coverage)}${stale} | ` +
        `pdfjs+sql ${pct(report.pdfjsSql.coverage)} | docling+sql ${pct(report.sql.coverage)} | ` +
        `docling+md ${pct(report.markdown.coverage)}`,
    );
  }

  if (reports.length === 0) {
    throw new Error('Nothing to compare — no document had both a manifest entry and markdown.');
  }

  await writeFile(
    path.join(args.workdir, 'per-document.jsonl'),
    `${reports.map((report) => JSON.stringify(report)).join('\n')}\n`,
  );
  await writeFile(path.join(args.workdir, 'report.md'), renderReport(reports));

  console.log(`\nReport: ${path.join(args.workdir, 'report.md')}`);
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function renderReport(reports: DocumentReport[]): string {
  const lines: string[] = [];
  lines.push('# docling vs live SDS chunking', '');
  lines.push(`Documents compared: ${reports.length}`, '');
  lines.push(
    'Baseline is `sds-chunk-loss-sample40.csv` (`loss_pct` = body chars never reaching a chunk).',
    '',
  );

  lines.push('## Coverage (chunk chars / source chars)', '');
  lines.push(
    '`markdown` reads ~8% low by construction: chunkMarkdown keeps heading text in the `heading`',
    'column, and headings are 8-12% of a docling file. Judge that variant on probes, not here.',
    '',
  );
  lines.push('| variant | mean | median | under 50% |');
  lines.push('| --- | --- | --- | --- |');
  for (const variant of VARIANTS) {
    const values = reports.map((report) => report[variant].coverage);
    lines.push(
      `| ${variant} | ${pct(mean(values))} | ${pct(median(values))} | ${values.filter((value) => value < 0.5).length} |`,
    );
  }
  lines.push('');

  const stale = reports.filter((report) => report.live.coverage + 0.01 < report.pdfjsSql.coverage);
  lines.push('## Stale chunks (live below a fresh rechunk of the same text)', '');
  lines.push(
    `${stale.length} of ${reports.length} documents store chunks worse than today's chunker produces`,
    'from the same `body_text` — that gap is staleness, not extraction, and must not be credited to',
    'docling. `pdfjsSql` -> `sql` is the extractor\'s actual contribution.',
    '',
  );
  if (stale.length > 0) {
    lines.push('| document | live cov | pdfjs+sql cov | gap |');
    lines.push('| --- | --- | --- | --- |');
    for (const report of stale) {
      lines.push(
        `| ${report.title} | ${pct(report.live.coverage)} | ${pct(report.pdfjsSql.coverage)} | ` +
          `+${pct(report.pdfjsSql.coverage - report.live.coverage)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## By band', '');
  lines.push('| band | docs | csv loss | live | pdfjs+sql | docling+sql | docling+md |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  const bands = [...new Set(reports.map((report) => report.band))].sort();
  for (const band of bands) {
    const inBand = reports.filter((report) => report.band === band);
    lines.push(
      `| ${band} | ${inBand.length} | ${mean(inBand.map((r) => r.csvLossPct)).toFixed(1)}% | ` +
        `${pct(mean(inBand.map((r) => r.live.coverage)))} | ` +
        `${pct(mean(inBand.map((r) => r.pdfjsSql.coverage)))} | ` +
        `${pct(mean(inBand.map((r) => r.sql.coverage)))} | ` +
        `${pct(mean(inBand.map((r) => r.markdown.coverage)))} |`,
    );
  }
  lines.push('');

  lines.push('## Probe survival (documents where the string is present)', '');
  lines.push('| probe | pdfjs body | docling md | live | pdfjs+sql | docling+sql | docling+md |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const probe of PROBES) {
    const count = (predicate: (report: DocumentReport) => boolean) =>
      reports.filter(predicate).length;
    lines.push(
      `| ${probe.id} | ${count((r) => r.bodyProbes[probe.id])} | ${count((r) => r.doclingProbes[probe.id])} | ` +
        `${count((r) => r.live.probes[probe.id])} | ${count((r) => r.pdfjsSql.probes[probe.id])} | ` +
        `${count((r) => r.sql.probes[probe.id])} | ${count((r) => r.markdown.probes[probe.id])} |`,
    );
  }
  lines.push('');

  lines.push('## Structure', '');
  lines.push(
    `Mean docling markdown table rows per document: ${mean(reports.map((r) => r.doclingTableRows)).toFixed(1)}`,
  );
  lines.push(
    `Mean docling headings per document: ${mean(reports.map((r) => r.doclingHeadings)).toFixed(1)}`,
  );
  lines.push(
    `Mean chunks per document — live ${mean(reports.map((r) => r.live.chunks)).toFixed(1)}, ` +
      `pdfjs+sql ${mean(reports.map((r) => r.pdfjsSql.chunks)).toFixed(1)}, ` +
      `docling+sql ${mean(reports.map((r) => r.sql.chunks)).toFixed(1)}, ` +
      `docling+md ${mean(reports.map((r) => r.markdown.chunks)).toFixed(1)}`,
  );
  lines.push('');

  lines.push('## Per document', '');
  lines.push(
    '| band | document | csv loss | body chars | docling chars | live | pdfjs+sql | docling+sql | docling+md | chunks live/pdfjs/sql/md |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const report of [...reports].sort((a, b) => a.band.localeCompare(b.band))) {
    lines.push(
      `| ${report.band} | ${report.title} | ${report.csvLossPct.toFixed(1)}% | ${report.bodyChars} | ` +
        `${report.doclingChars} | ${pct(report.live.coverage)} | ${pct(report.pdfjsSql.coverage)} | ` +
        `${pct(report.sql.coverage)} | ${pct(report.markdown.coverage)} | ` +
        `${report.live.chunks}/${report.pdfjsSql.chunks}/${report.sql.chunks}/${report.markdown.chunks} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

// --- Phase 4: chunk deltas ------------------------------------------------

const MAX_INVENTORY_ROWS = 30;
const MAX_DELTA_EXCERPTS = 12;

/**
 * Sentence-ish units for set-differencing two chunk sets. Splitting on sentence punctuation and
 * newlines rather than diffing chunk-by-chunk is deliberate: the two sides draw chunk boundaries in
 * different places, so a chunk-level diff would report every chunk as changed and say nothing about
 * content. Normalization drops case, punctuation and whitespace runs so that a sentence surviving
 * with different spacing (which is exactly what changes between extractors) counts as the same
 * sentence.
 */
function toSentences(text: string): Map<string, string> {
  const byNormalized = new Map<string, string>();
  for (const raw of text.split(/(?<=[.;:!?])\s+|\n+/)) {
    const trimmed = raw.trim();
    // Short fragments are mostly table-cell debris and label stubs; they inflate both sides.
    if (trimmed.length < 25) continue;
    const normalized = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (normalized.length < 25) continue;
    if (!byNormalized.has(normalized)) {
      byNormalized.set(normalized, trimmed);
    }
  }
  return byNormalized;
}

const GRAM_SIZE = 5;
/** Half a sentence's 5-grams surviving on the other side is reformatting, not loss. */
const REFORMATTED_THRESHOLD = 0.5;

function wordGrams(text: string, size = GRAM_SIZE): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const grams = new Set<string>();
  for (let index = 0; index + size <= words.length; index += 1) {
    grams.add(words.slice(index, index + size).join(' '));
  }
  return grams;
}

/**
 * Split a sentence-level set difference into content that genuinely is not on the other side and
 * content that is merely written differently there.
 *
 * The two extractors disagree about where a sentence ends: pdfjs flattens a whole toxicology table
 * into one run-on line, docling renders it as markdown rows. Sentence identity therefore reports
 * those as lost when every word is present. Comparing word 5-grams against the other side's full
 * text is order- and boundary-insensitive, so it separates the two cases.
 */
function splitByContainment(
  sentences: string[],
  otherText: string,
): { absent: string[]; reformatted: string[] } {
  const otherGrams = wordGrams(otherText);
  const absent: string[] = [];
  const reformatted: string[] = [];

  for (const sentence of sentences) {
    const grams = [...wordGrams(sentence)];
    if (grams.length === 0) {
      // Too short to gram: fall back to a substring test against the normalized other side.
      const normalized = sentence.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const otherNormalized = otherText.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      (otherNormalized.includes(normalized) ? reformatted : absent).push(sentence);
      continue;
    }
    const hit = grams.filter((gram) => otherGrams.has(gram)).length / grams.length;
    (hit >= REFORMATTED_THRESHOLD ? reformatted : absent).push(sentence);
  }

  return { absent, reformatted };
}

function inventoryRows(chunks: AnyChunk[]): string[] {
  const lines: string[] = [];
  lines.push('| # | heading | chars | opening |');
  lines.push('| --- | --- | --- | --- |');
  chunks.slice(0, MAX_INVENTORY_ROWS).forEach((chunk, index) => {
    const opening = chunk.chunk_text
      .replace(/\s+/g, ' ')
      .slice(0, 90)
      .replace(/\|/g, '\\|');
    const heading = (chunk.heading ?? '—').replace(/\s+/g, ' ').slice(0, 40).replace(/\|/g, '\\|');
    lines.push(`| ${index} | ${heading} | ${chunk.chunk_text.length} | ${opening} |`);
  });
  if (chunks.length > MAX_INVENTORY_ROWS) {
    lines.push(`| … | ${chunks.length - MAX_INVENTORY_ROWS} more | | |`);
  }
  return lines;
}

function excerptList(sentences: string[]): string[] {
  return sentences
    .slice(0, MAX_DELTA_EXCERPTS)
    .map((sentence) => `- ${sentence.replace(/\s+/g, ' ').slice(0, 240)}`);
}

async function runDeltas(args: Args) {
  const manifest = JSON.parse(
    await readFile(path.join(args.workdir, 'manifest.json'), 'utf-8'),
  ) as Manifest;

  const mdDir = path.join(args.workdir, 'md');
  const mdFiles = new Set(
    (await readdir(mdDir).catch(() => [])).filter((name) => name.endsWith('.md')),
  );

  const selected = selectRows(manifest.documents, args).filter((doc) =>
    mdFiles.has(`${doc.documentId}.md`),
  );
  if (selected.length === 0) {
    throw new Error('No documents selected that have docling markdown.');
  }

  const documentIds = selected.map((doc) => doc.documentId);
  const [documents, liveChunks] = await Promise.all([
    fetchDocuments(documentIds),
    fetchLiveChunks(documentIds),
  ]);

  const lines: string[] = [];
  lines.push('# SDS chunk deltas — live vs docling', '');
  lines.push(
    'For each document: what is in the live chunks, what is in the docling chunks, and the',
    'sentences one side carries and the other does not. Sentences are normalized (case,',
    'punctuation, whitespace) before differencing, so a line that survives with different spacing',
    'counts as present on both sides rather than as a delta.',
    '',
    '`recovered` = in docling chunks, absent from live chunks. `dropped` = the reverse.',
    '',
  );

  for (const doc of selected) {
    const markdown = await readFile(path.join(mdDir, `${doc.documentId}.md`), 'utf-8');
    const bodyText = documents.get(doc.documentId)?.body_text ?? '';
    const live = liveChunks.get(doc.documentId) ?? [];
    const doclingChunks = await chunkWithSql(markdown, doc.title);

    const liveSentences = toSentences(live.map(chunkSearchText).join('\n'));
    const doclingSentences = toSentences(doclingChunks.map(chunkSearchText).join('\n'));
    const bodySentences = toSentences(bodyText);

    const liveText = live.map(chunkSearchText).join('\n');
    const doclingText = doclingChunks.map(chunkSearchText).join('\n');

    const recovered = splitByContainment(
      [...doclingSentences].filter(([key]) => !liveSentences.has(key)).map(([, text]) => text),
      liveText,
    );
    const dropped = splitByContainment(
      [...liveSentences].filter(([key]) => !doclingSentences.has(key)).map(([, text]) => text),
      doclingText,
    );
    // Sentences the PDF body has that neither chunk set carries — the residue that no amount of
    // rechunking recovers, and the honest ceiling on what docling buys.
    const missingFromBoth = splitByContainment(
      [...bodySentences]
        .filter(([key]) => !liveSentences.has(key) && !doclingSentences.has(key))
        .map(([, text]) => text),
      `${liveText}\n${doclingText}`,
    );

    lines.push(`## ${doc.title} — ${doc.band}`, '');
    lines.push(
      `Document \`${doc.documentId}\`, chunk_generation \`${doc.chunkGeneration}\`, ` +
        `CSV loss ${doc.lossPct.toFixed(1)}%.`,
      '',
    );
    lines.push('| | live | docling+sql |');
    lines.push('| --- | --- | --- |');
    lines.push(`| chunks | ${live.length} | ${doclingChunks.length} |`);
    lines.push(
      `| chunk chars | ${live.reduce((sum, chunk) => sum + chunk.chunk_text.length, 0)} | ` +
        `${doclingChunks.reduce((sum, chunk) => sum + chunk.chunk_text.length, 0)} |`,
    );
    lines.push(`| sentences | ${liveSentences.size} | ${doclingSentences.size} |`);
    lines.push('');
    lines.push(
      `**recovered ${recovered.absent.length} sentences · dropped ${dropped.absent.length} · ` +
        `in body but in neither ${missingFromBoth.absent.length}**`,
      '',
    );
    lines.push(
      `Reformatted-only (same words, different sentence boundaries, excluded from the counts above):` +
        ` recovered ${recovered.reformatted.length}, dropped ${dropped.reformatted.length},` +
        ` neither ${missingFromBoth.reformatted.length}.`,
      '',
    );

    lines.push('### Live chunk inventory', '');
    lines.push(...inventoryRows(live), '');
    lines.push('### docling+sql chunk inventory', '');
    lines.push(...inventoryRows(doclingChunks), '');

    lines.push(
      `### Recovered by docling (${recovered.absent.length}, showing up to ${MAX_DELTA_EXCERPTS})`,
      '',
    );
    lines.push(...(recovered.absent.length ? excerptList(recovered.absent) : ['- (none)']), '');

    lines.push(
      `### Dropped vs live (${dropped.absent.length}, showing up to ${MAX_DELTA_EXCERPTS})`,
      '',
    );
    lines.push(...(dropped.absent.length ? excerptList(dropped.absent) : ['- (none)']), '');

    lines.push(
      `### In pdfjs body but in neither chunk set (${missingFromBoth.absent.length}, showing up to ${MAX_DELTA_EXCERPTS})`,
      '',
    );
    lines.push(
      ...(missingFromBoth.absent.length ? excerptList(missingFromBoth.absent) : ['- (none)']),
      '',
    );

    console.log(
      `[${doc.band}] ${doc.title}: recovered ${recovered.absent.length}, ` +
        `dropped ${dropped.absent.length}, neither ${missingFromBoth.absent.length}`,
    );
  }

  const target = path.join(args.workdir, 'chunk-deltas.md');
  await writeFile(target, lines.join('\n'));
  console.log(`\nDeltas: ${target}`);
}

// --- Phase 5: rebuild -----------------------------------------------------

/** The 16 GHS sections every SDS has, by the slug both chunkers put in `section_path`. */
const SDS_SECTIONS: Array<{ slug: string; label: string }> = [
  { slug: 'section_1', label: '1 Identification' },
  { slug: 'section_2', label: '2 Hazards' },
  { slug: 'section_3', label: '3 Composition' },
  { slug: 'section_4', label: '4 First aid' },
  { slug: 'section_5', label: '5 Fire fighting' },
  { slug: 'section_6', label: '6 Accidental release' },
  { slug: 'section_7', label: '7 Handling / storage' },
  { slug: 'section_8', label: '8 Exposure controls' },
  { slug: 'section_9', label: '9 Physical properties' },
  { slug: 'section_10', label: '10 Stability' },
  { slug: 'section_11', label: '11 Toxicology' },
  { slug: 'section_12', label: '12 Ecological' },
  { slug: 'section_13', label: '13 Disposal' },
  { slug: 'section_14', label: '14 Transport' },
  { slug: 'section_15', label: '15 Regulatory' },
  { slug: 'section_16', label: '16 Other' },
];

/** A section counts as present only if it carries real content, not just its own heading. */
const SECTION_CONTENT_MIN_CHARS = 120;

function sectionChars(chunks: AnyChunk[]): Map<string, number> {
  const bySlug = new Map<string, number>();
  for (const chunk of chunks) {
    const slug = (chunk.section_path ?? []).at(-1);
    if (!slug) continue;
    bySlug.set(slug, (bySlug.get(slug) ?? 0) + chunk.chunk_text.length);
  }
  return bySlug;
}

/** Concatenate chunks back into the document retrieval actually holds. */
function rebuildDocument(title: string, variant: string, chunks: AnyChunk[]): string {
  const lines = [`# ${title} — rebuilt from ${variant} chunks`, ''];
  lines.push(
    `${chunks.length} chunks, ${chunks.reduce((sum, chunk) => sum + chunk.chunk_text.length, 0)} chars.`,
    '',
    'Everything below is chunk text verbatim, in chunk order. Anything absent here is absent from',
    'retrieval — no tool call, rerank or prompt can reach it.',
    '',
    '---',
    '',
  );
  chunks.forEach((chunk, index) => {
    const slug = (chunk.section_path ?? []).join('/') || '—';
    lines.push(`<!-- chunk ${index} · ${slug} -->`, '', chunk.chunk_text.trim(), '');
  });
  return lines.join('\n');
}

async function runRebuild(args: Args) {
  const manifest = JSON.parse(
    await readFile(path.join(args.workdir, 'manifest.json'), 'utf-8'),
  ) as Manifest;

  const mdDir = path.join(args.workdir, 'md');
  const mdFiles = new Set(
    (await readdir(mdDir).catch(() => [])).filter((name) => name.endsWith('.md')),
  );
  const selected = selectRows(manifest.documents, args).filter((doc) =>
    mdFiles.has(`${doc.documentId}.md`),
  );
  if (selected.length === 0) {
    throw new Error('No documents selected that have docling markdown.');
  }

  const documentIds = selected.map((doc) => doc.documentId);
  const liveChunks = await fetchLiveChunks(documentIds);
  const rebuiltDir = path.join(args.workdir, 'rebuilt');
  await mkdir(rebuiltDir, { recursive: true });

  const lines: string[] = [];
  lines.push('# Before / after — what the corpus holds for each SDS', '');
  lines.push(
    'Both columns are the document rebuilt from its chunks: **before** is `rag.document_chunk` as it',
    'stands, **after** is the same chunker over docling markdown. A section is counted present only',
    `if its chunks carry at least ${SECTION_CONTENT_MIN_CHARS} characters — a heading with no body is`,
    'worse than absence, because it ranks for the query it cannot answer.',
    '',
    'Full rebuilt documents are in `rebuilt/<documentId>.{before,after}.md`.',
    '',
  );

  let beforeTotal = 0;
  let afterTotal = 0;

  for (const doc of selected) {
    const markdown = await readFile(path.join(mdDir, `${doc.documentId}.md`), 'utf-8');
    const before = liveChunks.get(doc.documentId) ?? [];
    const after = await chunkWithSql(markdown, doc.title);

    await writeFile(
      path.join(rebuiltDir, `${doc.documentId}.before.md`),
      rebuildDocument(doc.title, 'live', before),
    );
    await writeFile(
      path.join(rebuiltDir, `${doc.documentId}.after.md`),
      rebuildDocument(doc.title, 'docling+sql', after),
    );

    const beforeSections = sectionChars(before);
    const afterSections = sectionChars(after);
    const present = (map: Map<string, number>, slug: string) =>
      (map.get(slug) ?? 0) >= SECTION_CONTENT_MIN_CHARS;

    const beforeCount = SDS_SECTIONS.filter((s) => present(beforeSections, s.slug)).length;
    const afterCount = SDS_SECTIONS.filter((s) => present(afterSections, s.slug)).length;
    beforeTotal += beforeCount;
    afterTotal += afterCount;

    lines.push(`## ${doc.title} — ${doc.band}`, '');
    lines.push(
      `\`${doc.documentId}\` · sections with content: **${beforeCount}/16 → ${afterCount}/16** · ` +
        `chunks ${before.length} → ${after.length}`,
      '',
    );
    lines.push('| section | before | after |');
    lines.push('| --- | --- | --- |');
    for (const section of SDS_SECTIONS) {
      const beforeChars = beforeSections.get(section.slug) ?? 0;
      const afterChars = afterSections.get(section.slug) ?? 0;
      if (beforeChars === 0 && afterChars === 0) continue;
      const mark = (chars: number) =>
        chars >= SECTION_CONTENT_MIN_CHARS ? `${chars}` : chars > 0 ? `${chars} (stub)` : '—';
      lines.push(`| ${section.label} | ${mark(beforeChars)} | ${mark(afterChars)} |`);
    }
    lines.push('');

    // Spotlight the biggest single gain, which is the concrete "here is what you could not answer
    // before" example rather than another aggregate.
    const gains = SDS_SECTIONS.map((section) => ({
      section,
      gain: (afterSections.get(section.slug) ?? 0) - (beforeSections.get(section.slug) ?? 0),
    }))
      .filter((entry) => entry.gain > 0)
      .sort((a, b) => b.gain - a.gain);

    const spotlight = gains[0];
    if (spotlight) {
      const slug = spotlight.section.slug;
      const pick = (chunks: AnyChunk[]) =>
        chunks
          .filter((chunk) => (chunk.section_path ?? []).at(-1) === slug)
          .map((chunk) => chunk.chunk_text)
          .join('\n')
          .replace(/\s+/g, ' ')
          .trim();

      lines.push(`### Biggest gain — ${spotlight.section.label} (+${spotlight.gain} chars)`, '');
      lines.push('**Before:**', '', '```', pick(before).slice(0, 700) || '(nothing)', '```', '');
      lines.push('**After:**', '', '```', pick(after).slice(0, 700) || '(nothing)', '```', '');
    }

    console.log(
      `[${doc.band}] ${doc.title}: sections ${beforeCount}/16 -> ${afterCount}/16, ` +
        `chunks ${before.length} -> ${after.length}`,
    );
  }

  lines.splice(
    8,
    0,
    `Across these ${selected.length} documents: mean sections with content ` +
      `**${(beforeTotal / selected.length).toFixed(1)}/16 → ${(afterTotal / selected.length).toFixed(1)}/16**.`,
    '',
  );

  const target = path.join(args.workdir, 'before-after.md');
  await writeFile(target, lines.join('\n'));
  console.log(`\nBefore/after: ${target}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'plan') {
    await runPlan(args);
  } else if (args.mode === 'deltas') {
    await runDeltas(args);
  } else if (args.mode === 'rebuild') {
    await runRebuild(args);
  } else {
    await runCompare(args);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
