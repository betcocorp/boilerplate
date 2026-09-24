#!/usr/bin/env -S npx tsx
/**
 * Compare the current label/efficacy corpus with Docling conversions of the same source PDFs.
 *
 * This complements compare-docling-chunks.ts, whose sampling and metrics are SDS-specific.
 * It is read-only against Supabase.
 *
 *   --plan --kind efficacy   Map raw PDFs to rag.document and select a stratified sample.
 *   --plan --kind label      Same, using conservative brand + SKU + title matching.
 *   --compare --kind <kind>  Compare stored chunks, a fresh current-path rechunk, and
 *                            Docling markdown chunked by both the current and proposed paths.
 *
 * Defaults: --limit 40 and --workdir tmp/docling-compare/<kind>.
 */

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chunkMarkdown, estimateTokens } from '~/lib/rag/markdown-chunking';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

const KINDS = ['efficacy', 'label'] as const;
type CorpusKind = (typeof KINDS)[number];
type Mode = 'plan' | 'compare';

type Args = {
  mode: Mode;
  kind: CorpusKind;
  root: string;
  workdir: string;
  limit: number;
};

type JsonObject = Record<string, unknown>;

type DocumentRow = {
  id: string;
  title: string;
  document_key: string;
  document_kind: string;
  body_text: string | null;
  body_markdown: string | null;
  metadata: JsonObject | null;
};

type ChunkRow = {
  document_id: string;
  chunk_text: string;
  heading: string | null;
  section_path: string[] | null;
  token_count: number | null;
};

type AnyChunk = {
  chunk_text: string;
  heading?: string | null;
  section_path?: string[] | null;
  token_count?: number | null;
};

type PdfCandidate = {
  relativePath: string;
  absolutePath: string;
  bytes: number;
};

type MatchedPdf = PdfCandidate & {
  document: DocumentRow;
  matchMethod: string;
  group: string;
  sourceMarkdownPath?: string;
};

type ManifestDocument = {
  caseId: string;
  kind: CorpusKind;
  stratum: string;
  documentId: string;
  documentKey: string;
  title: string;
  pdfPath: string;
  pdfPathAbsolute: string;
  pdfBytes: number;
  matchMethod: string;
  sourceMarkdownPath?: string;
};

type Manifest = {
  generatedAt: string;
  kind: CorpusKind;
  sourceRoot: string;
  documents: ManifestDocument[];
  unmatched: Array<{ pdfPath: string; reason: string }>;
};

type QueryResult = Promise<{ data: unknown[] | null; error: { message: string } | null }>;
type LooseFilter = {
  eq(col: string, value: unknown): LooseFilter;
  in(col: string, values: readonly unknown[]): LooseFilter;
  limit(n: number): QueryResult;
};

const PROBES: Record<CorpusKind, Array<{ id: string; test: (text: string) => boolean }>> = {
  efficacy: [
    { id: 'contact_time', test: (text) => /\b\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?)\b/i.test(text) },
    { id: 'log_reduction', test: (text) => /\blog(?:10)?\s*(?:reduction|value)?|\b\d+(?:\.\d+)?\s*log\b/i.test(text) },
    { id: 'percent_reduction', test: (text) => /\b\d+(?:\.\d+)?\s*%\s*(?:reduction|reduced|kill)/i.test(text) },
    { id: 'organism', test: (text) => /staphylococcus|pseudomonas|salmonella|influenza|candida|aspergillus/i.test(text) },
    { id: 'control_count', test: (text) => /(?:control|inoculum).{0,40}\b\d+(?:\.\d+)?\s*(?:x|×)\s*10\^?\d+/i.test(text) },
  ],
  label: [
    {
      id: 'directions_or_application',
      test: (text) => /\b(?:directions?(?:\s+for\s+use)?|applications?|dosage|dosing)\b/i.test(text),
    },
    { id: 'first_aid', test: (text) => /\bfirst[- ]aid(?:\s+measures)?\b/i.test(text) },
    { id: 'signal_word', test: (text) => /\b(?:danger|warning|caution)\b[!:]?/i.test(text) },
    { id: 'precautionary_statement', test: (text) => /\b(?:keep out of reach of children|wear protective|poison center|avoid contact with)\b/i.test(text) },
    { id: 'epa_registration', test: (text) => /EPA\s*(?:Reg(?:istration)?\.?\s*(?:No\.?)?)?\s*[:#]?\s*\d{2,7}-\d{1,7}/i.test(text) },
    { id: 'din', test: (text) => /\bDIN\s*[:#]?\s*\d{8}\b/i.test(text) },
    { id: 'dilution_ratio', test: (text) => /\b1\s*[:/]\s*\d+\b/i.test(text) },
    {
      id: 'use_rate',
      test: (text) => /\b\d+(?:\.\d+)?\s*(?:fl\.?\s*)?(?:oz|ounces?|g|kg)\b.{0,30}\b(?:gal(?:lon)?|lit(?:er|re)s?|ha|water)\b/i.test(text),
    },
    {
      id: 'contact_or_dwell_time',
      test: (text) => /\b(?:contact|dwell)\s+time\b|\b(?:allow|leave|let)\b.{0,35}\b\d+(?:\.\d+)?\s*(?:seconds?|minutes?)\b/i.test(text),
    },
    { id: 'active_ingredient', test: (text) => /\bactive ingredients?\b/i.test(text) },
    { id: 'cas_number', test: (text) => /\bCAS(?:\s+(?:No\.?|number))?\s*[:#]?\s*\d{2,7}-\d{2}-\d\b/i.test(text) },
    { id: 'ingredient_percentage', test: (text) => /\b\d{1,3}(?:\.\d+)?\s*%/i.test(text) },
    { id: 'coverage_rate', test: (text) => /\b(?:coverage|covers?)\b.{0,40}\b\d[\d,]*(?:\s*-\s*\d[\d,]*)?\s*(?:sq\.?\s*ft|ft²|m²)/i.test(text) },
    { id: 'ph_value', test: (text) => /\bpH\b.{0,20}\b\d+(?:\.\d+)?\b/i.test(text) },
    { id: 'voc', test: (text) => /\bVOC\b|volatile organic compounds?/i.test(text) },
  ],
};

function parseArgs(argv: string[]): Args {
  const mode: Mode | null = argv.includes('--plan') ? 'plan' : argv.includes('--compare') ? 'compare' : null;
  if (!mode) throw new Error('Pass --plan or --compare.');

  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const rawKind = value('--kind');
  if (!KINDS.includes(rawKind as CorpusKind)) {
    throw new Error(`Pass --kind efficacy or --kind label, got ${rawKind ?? '(missing)'}.`);
  }
  const kind = rawKind as CorpusKind;
  const rawLimit = value('--limit') ?? '40';
  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error(`--limit must be positive, got ${rawLimit}.`);

  return {
    mode,
    kind,
    limit,
    root: path.resolve(value('--root') ?? `dump/${kind === 'label' ? 'labels-raw' : 'efficacy-raw'}`),
    workdir: path.resolve(value('--workdir') ?? `tmp/docling-compare/${kind}`),
  };
}

function ragTable(table: string): { select(columns: string): LooseFilter } {
  const client = getSupabaseServiceRoleClient().schema('rag') as unknown as {
    from(name: string): { select(columns: string): LooseFilter };
  };
  return client.from(table);
}

async function fetchDocuments(kind: CorpusKind): Promise<DocumentRow[]> {
  const { data, error } = await ragTable('document')
    .select('id, title, document_key, document_kind, body_text, body_markdown, metadata')
    .eq('document_kind', kind)
    .limit(10_000);
  if (error) throw new Error(`Failed to load ${kind} documents: ${error.message}`);
  return (data ?? []) as DocumentRow[];
}

async function fetchChunks(documentIds: string[]): Promise<Map<string, ChunkRow[]>> {
  const result = new Map<string, ChunkRow[]>();
  if (documentIds.length === 0) return result;
  const { data, error } = await ragTable('document_chunk')
    .select('document_id, chunk_text, heading, section_path, token_count')
    .in('document_id', documentIds)
    .limit(100_000);
  if (error) throw new Error(`Failed to load chunks: ${error.message}`);
  for (const row of (data ?? []) as ChunkRow[]) {
    const rows = result.get(row.document_id) ?? [];
    rows.push(row);
    result.set(row.document_id, rows);
  }
  return result;
}

async function walkPdfs(root: string): Promise<PdfCandidate[]> {
  await access(root);
  const output: PdfCandidate[] = [];
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf') {
        output.push({
          relativePath: path.relative(root, absolutePath).split(path.sep).join('/'),
          absolutePath,
          bytes: (await stat(absolutePath)).size,
        });
      }
    }
  };
  await visit(root);
  return output;
}

function normalizePath(value: string) {
  return value.replaceAll('\\', '/').replace(/^s3:\/\/[^/]+\//i, '').replace(/^\/+/, '').toLowerCase();
}

function basenameKey(value: string) {
  return path.posix.basename(normalizePath(value));
}

function extractSourcePdf(markdown: string | null): string | null {
  if (!markdown) return null;
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const source = frontmatter?.[1]?.match(/^source_pdf:\s*["']?(.+?)["']?\s*$/im)?.[1]?.trim();
  if (source) return source;
  return markdown.match(/s3:\/\/[^\s)`]+\/efficacy\/raw\/[^\n)]+\.pdf/i)?.[0] ?? null;
}

function efficacyMatches(pdfs: PdfCandidate[], documents: DocumentRow[]) {
  const byS3Key = new Map<string, DocumentRow[]>();
  const byDisinfectantUuid = new Map<string, DocumentRow[]>();
  for (const document of documents) {
    const s3Key = String(document.metadata?.s3_key ?? '');
    if (!s3Key) continue;
    byS3Key.set(s3Key, [...(byS3Key.get(s3Key) ?? []), document]);
    const uuid = s3Key.match(/^efficacy\/markdown\/disinfectants\/[^/]+_([0-9a-f-]{36})\.md$/i)?.[1]?.toLowerCase();
    if (uuid) byDisinfectantUuid.set(uuid, [...(byDisinfectantUuid.get(uuid) ?? []), document]);
  }

  const matched: MatchedPdf[] = [];
  const unmatched: Array<{ pdfPath: string; reason: string }> = [];
  for (const pdf of pdfs) {
    const nested = pdf.relativePath.includes('/');
    const expectedS3Key = nested
      ? `efficacy/markdown/hygiene-skin-care/${pdf.relativePath.replace(/\.pdf$/i, '.md')}`
      : null;
    const uuid = !nested ? path.basename(pdf.relativePath, path.extname(pdf.relativePath)).toLowerCase() : null;
    const rows = expectedS3Key ? (byS3Key.get(expectedS3Key) ?? []) : uuid ? (byDisinfectantUuid.get(uuid) ?? []) : [];
    if (rows.length !== 1) {
      unmatched.push({
        pdfPath: pdf.relativePath,
        reason: rows.length === 0 ? 'no deterministic efficacy document match' : `ambiguous efficacy match (${rows.length})`,
      });
      continue;
    }
    const document = rows[0];
    const sourcePdf = extractSourcePdf(document.body_markdown);
    if (sourcePdf && basenameKey(sourcePdf) !== basenameKey(pdf.relativePath)) {
      unmatched.push({ pdfPath: pdf.relativePath, reason: 'matched document source_pdf disagrees with raw filename' });
      continue;
    }
    matched.push({
      ...pdf,
      document,
      matchMethod: nested ? 'parallel_markdown_s3_key' : 'disinfectant_uuid_suffix',
      group: nested ? 'formula-report' : 'uuid-export',
    });
  }
  return { matched, unmatched };
}

const RAW_LABEL_BRANDS: Record<string, string> = {
  betco: 'betco',
  envirozyme: 'envirozyme',
  'basic coatings': 'basic_coatings',
  '1950 brands': '1950',
};
const MARKDOWN_LABEL_BRANDS: Record<string, string> = {
  betco: 'betco',
  envirozyme: 'envirozyme',
  'basic-coatings': 'basic_coatings',
  '1950-brands': '1950',
};

async function walkMarkdown(root: string) {
  const output: Array<{ relativePath: string; absolutePath: string }> = [];
  const visit = async (directory: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md' && !entry.name.startsWith('_')) {
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
        if (relativePath.includes('/')) output.push({ relativePath, absolutePath });
      }
    }
  };
  await visit(root);
  return output;
}

function labelSourcePdf(markdown: string) {
  return markdown.match(/^source_pdf:\s*["']?(.+?)["']?\s*$/im)?.[1]?.trim() ?? null;
}

async function labelMatches(pdfs: PdfCandidate[], documents: DocumentRow[]) {
  const markdownRoot = path.resolve('dump/labels');
  const markdownFiles = await walkMarkdown(markdownRoot);
  const documentsByKey = new Map<string, DocumentRow[]>();
  const documentsByPath = new Map<string, DocumentRow[]>();
  for (const document of documents) {
    documentsByKey.set(document.document_key, [...(documentsByKey.get(document.document_key) ?? []), document]);
    const labelPath = String(document.metadata?.label_md_path ?? '').toLowerCase();
    if (labelPath) documentsByPath.set(labelPath, [...(documentsByPath.get(labelPath) ?? []), document]);
  }

  const rawByBrandBasename = new Map<string, PdfCandidate[]>();
  for (const pdf of pdfs) {
    const rawFolder = pdf.relativePath.split('/')[0]?.toLowerCase() ?? '';
    const brand = RAW_LABEL_BRANDS[rawFolder];
    if (!brand) continue;
    const key = `${brand}:${path.basename(pdf.relativePath)}`;
    rawByBrandBasename.set(key, [...(rawByBrandBasename.get(key) ?? []), pdf]);
  }

  const matched: MatchedPdf[] = [];
  const unmatched: Array<{ pdfPath: string; reason: string }> = [];
  for (const markdownFile of markdownFiles) {
    const folder = markdownFile.relativePath.split('/')[0]?.toLowerCase() ?? '';
    const brand = MARKDOWN_LABEL_BRANDS[folder];
    const stem = path.basename(markdownFile.relativePath, path.extname(markdownFile.relativePath));
    if (!brand) {
      unmatched.push({ pdfPath: markdownFile.relativePath, reason: 'unrecognized canonical markdown brand' });
      continue;
    }
    const markdown = await readFile(markdownFile.absolutePath, 'utf8');
    const sourcePdf = labelSourcePdf(markdown);
    if (!sourcePdf) {
      unmatched.push({ pdfPath: markdownFile.relativePath, reason: 'canonical markdown has no source_pdf' });
      continue;
    }
    const rawRows = rawByBrandBasename.get(`${brand}:${sourcePdf}`) ?? [];
    if (rawRows.length !== 1) {
      unmatched.push({
        pdfPath: markdownFile.relativePath,
        reason: rawRows.length === 0 ? `no brand-scoped raw PDF named ${sourcePdf}` : `ambiguous brand-scoped raw PDF (${rawRows.length})`,
      });
      continue;
    }

    const expectedKey = `label_md:${brand}:${stem}:en`;
    let documentRows = documentsByKey.get(expectedKey) ?? [];
    if (documentRows.length !== 1 && brand === '1950') {
      documentRows = documentsByKey.get(`label_md:1950_brands:${stem}:en`) ?? [];
    }
    if (documentRows.length !== 1) {
      documentRows = documentsByPath.get(markdownFile.relativePath.toLowerCase()) ?? [];
    }
    if (documentRows.length !== 1) {
      unmatched.push({
        pdfPath: markdownFile.relativePath,
        reason: documentRows.length === 0 ? 'no current label document match' : `ambiguous label document match (${documentRows.length})`,
      });
      continue;
    }

    matched.push({
      ...rawRows[0],
      document: documentRows[0],
      matchMethod: 'canonical_markdown_source_pdf',
      group: brand,
      sourceMarkdownPath: path.relative(process.cwd(), markdownFile.absolutePath),
    });
  }
  return { matched, unmatched };
}

const SIZE_BANDS = ['small', 'medium', 'large', 'very-large'] as const;

function assignSizeBands(rows: MatchedPdf[]) {
  const result = new Map<string, (typeof SIZE_BANDS)[number]>();
  const groups = [...new Set(rows.map((row) => row.group))];
  for (const group of groups) {
    const members = rows
      .filter((row) => row.group === group)
      .sort((a, b) => a.bytes - b.bytes || a.relativePath.localeCompare(b.relativePath));
    members.forEach((row, index) => {
      result.set(row.relativePath, SIZE_BANDS[Math.min(3, Math.floor((index * 4) / members.length))]);
    });
  }
  return result;
}

/** Give each source family/brand an equal quota, then round-robin through its size quartiles. */
function stratifiedSample(rows: MatchedPdf[], limit: number) {
  const target = Math.min(limit, rows.length);
  const sizeBands = assignSizeBands(rows);
  const groups = [...new Set(rows.map((row) => row.group))].sort();
  const selected: Array<{ row: MatchedPdf; stratum: string }> = [];

  groups.forEach((group, groupIndex) => {
    const quota = Math.floor(target / groups.length) + (groupIndex < target % groups.length ? 1 : 0);
    const byBand = new Map<string, MatchedPdf[]>();
    for (const row of rows.filter((candidate) => candidate.group === group)) {
      const band = sizeBands.get(row.relativePath)!;
      const members = byBand.get(band) ?? [];
      members.push(row);
      byBand.set(band, members);
    }
    for (const members of byBand.values()) members.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    for (let round = 0; selected.filter((entry) => entry.row.group === group).length < quota; round += 1) {
      let added = false;
      for (const band of SIZE_BANDS) {
        const row = byBand.get(band)?.[round];
        if (!row) continue;
        selected.push({ row, stratum: `${group}/${band}` });
        added = true;
        if (selected.filter((entry) => entry.row.group === group).length >= quota) break;
      }
      if (!added) break;
    }
  });
  return selected;
}

function caseId(kind: CorpusKind, relativePath: string) {
  return `${kind}-${createHash('sha1').update(relativePath).digest('hex').slice(0, 16)}`;
}

async function runPlan(args: Args) {
  const [pdfs, documents] = await Promise.all([walkPdfs(args.root), fetchDocuments(args.kind)]);
  const mapping = args.kind === 'efficacy' ? efficacyMatches(pdfs, documents) : await labelMatches(pdfs, documents);
  const selected = stratifiedSample(mapping.matched, args.limit);
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    kind: args.kind,
    sourceRoot: args.root,
    documents: selected.map(({ row, stratum }) => ({
      caseId: caseId(args.kind, row.relativePath),
      kind: args.kind,
      stratum,
      documentId: row.document.id,
      documentKey: row.document.document_key,
      title: row.document.title,
      pdfPath: path.relative(process.cwd(), row.absolutePath),
      pdfPathAbsolute: row.absolutePath,
      pdfBytes: row.bytes,
      matchMethod: row.matchMethod,
      ...(row.sourceMarkdownPath ? { sourceMarkdownPath: row.sourceMarkdownPath } : {}),
    })),
    unmatched: mapping.unmatched,
  };
  await mkdir(args.workdir, { recursive: true });
  await writeFile(path.join(args.workdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const byStratum = new Map<string, number>();
  for (const document of manifest.documents) byStratum.set(document.stratum, (byStratum.get(document.stratum) ?? 0) + 1);
  console.log(`${args.kind}: ${pdfs.length} PDFs, ${mapping.matched.length} mapped, ${mapping.unmatched.length} unmatched, ${manifest.documents.length} selected.`);
  for (const [stratum, count] of [...byStratum].sort()) console.log(`  ${stratum}: ${count}`);
  console.log(`\nManifest: ${path.join(args.workdir, 'manifest.json')}`);
  console.log(`Next: uv run --with docling scripts/docling/convert-sds-pdfs.py ${args.workdir}`);
}

type SqlChunk = {
  chunk_index: number;
  heading: string | null;
  section_path: string[] | null;
  chunk_text: string;
  token_count: number | null;
};

async function chunkEfficacyWithSql(markdown: string, title: string): Promise<SqlChunk[]> {
  const client = getSupabaseServiceRoleClient();
  const { data, error } = await (
    client.schema('rag') as unknown as {
      rpc(name: string, args: Record<string, unknown>): Promise<{ data: SqlChunk[] | null; error: { message: string } | null }>;
    }
  ).rpc('chunk_efficacy_document_text', {
    p_body_markdown: markdown,
    p_max_chars: 2200,
    p_overlap_chars: 150,
    p_title: title,
  });
  if (error) throw new Error(`chunk_efficacy_document_text failed: ${error.message}`);
  return data ?? [];
}

function markdownChunks(markdown: string): AnyChunk[] {
  return chunkMarkdown(markdown).map((chunk) => ({
    chunk_text: chunk.text,
    heading: chunk.heading,
    section_path: chunk.sectionPath,
    token_count: estimateTokens(chunk.text),
  }));
}

function labelChunkingBody(document: DocumentRow, markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.startsWith('# '));
  const body = (headingIndex === -1 ? lines : lines.slice(headingIndex + 1)).join('\n').trim();
  const metadata = document.metadata ?? {};
  const identity = [
    `Product: ${document.title}`,
    metadata.brand ? `Brand: ${String(metadata.brand)}` : null,
    metadata.sku ? `SKU: ${String(metadata.sku)}` : null,
    metadata.epa_reg_no ? `EPA Reg. No.: ${String(metadata.epa_reg_no)}` : null,
    metadata.din_no ? `DIN: ${String(metadata.din_no)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return `${identity}\n\n${body}`.trim();
}

async function currentChunks(kind: CorpusKind, markdown: string, document: DocumentRow): Promise<AnyChunk[]> {
  return kind === 'efficacy'
    ? chunkEfficacyWithSql(markdown, document.title)
    : markdownChunks(labelChunkingBody(document, markdown));
}

function chunkSearchText(chunk: AnyChunk) {
  return [chunk.chunk_text, chunk.heading ?? '', (chunk.section_path ?? []).join(' ')].join('\n');
}

function summarize(chunks: AnyChunk[], sourceChars: number, kind: CorpusKind) {
  const chars = chunks.reduce((sum, chunk) => sum + chunk.chunk_text.length, 0);
  const haystack = chunks.map(chunkSearchText).join('\n');
  return {
    chunks: chunks.length,
    chars,
    coverage: sourceChars ? chars / sourceChars : 0,
    probes: Object.fromEntries(PROBES[kind].map((probe) => [probe.id, probe.test(haystack)])),
  };
}

type ReportRow = {
  caseId: string;
  stratum: string;
  title: string;
  pdfPath: string;
  currentMarkdownChars: number;
  doclingMarkdownChars: number;
  sourceProbes: Record<string, boolean>;
  doclingProbes: Record<string, boolean>;
  live: ReturnType<typeof summarize>;
  currentFresh: ReturnType<typeof summarize>;
  doclingCurrent: ReturnType<typeof summarize>;
  doclingMarkdown: ReturnType<typeof summarize>;
};

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function renderReport(kind: CorpusKind, rows: ReportRow[]) {
  const variants = ['live', 'currentFresh', 'doclingCurrent', 'doclingMarkdown'] as const;
  const lines = [`# Docling ${kind} PDF comparison`, '', `Documents compared: ${rows.length}`, ''];
  lines.push('Coverage is chunk-text characters divided by the characters in that variant’s source markdown.', 'Headings stored outside chunk_text make the markdown chunker read low by construction.', '');
  lines.push('| variant | mean coverage | mean chunks | under 50% |');
  lines.push('| --- | --- | --- | --- |');
  for (const variant of variants) {
    lines.push(`| ${variant} | ${pct(mean(rows.map((row) => row[variant].coverage)))} | ${mean(rows.map((row) => row[variant].chunks)).toFixed(1)} | ${rows.filter((row) => row[variant].coverage < 0.5).length} |`);
  }
  lines.push('', '## Probe survival', '');
  const changedProbes = PROBES[kind].filter((probe) =>
    rows.some((row) => {
      const outcomes = [
        row.sourceProbes[probe.id],
        row.doclingProbes[probe.id],
        row.live.probes[probe.id],
        row.currentFresh.probes[probe.id],
        row.doclingCurrent.probes[probe.id],
        row.doclingMarkdown.probes[probe.id],
      ];
      return outcomes.some((outcome) => outcome !== outcomes[0]);
    }),
  );
  const omittedProbeCount = PROBES[kind].length - changedProbes.length;
  lines.push(
    `Only probes with at least one document-level change are shown; ${omittedProbeCount} unchanged probe${omittedProbeCount === 1 ? '' : 's'} omitted.`,
    '',
  );
  if (changedProbes.length === 0) {
    lines.push('No probe changes detected.');
  } else {
    lines.push('| probe | current source | Docling source | live | current fresh | Docling current | Docling markdown |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const probe of changedProbes) {
      const count = (predicate: (row: ReportRow) => boolean) => rows.filter(predicate).length;
      lines.push(`| ${probe.id} | ${count((row) => row.sourceProbes[probe.id])} | ${count((row) => row.doclingProbes[probe.id])} | ${count((row) => row.live.probes[probe.id])} | ${count((row) => row.currentFresh.probes[probe.id])} | ${count((row) => row.doclingCurrent.probes[probe.id])} | ${count((row) => row.doclingMarkdown.probes[probe.id])} |`);
    }
  }
  lines.push('', '## Per document', '');
  lines.push('| stratum | document | current chars | Docling chars | live | current fresh | Docling current | Docling markdown | chunks live/fresh/current/md |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    lines.push(`| ${row.stratum} | ${row.title.replaceAll('|', '\\|')} | ${row.currentMarkdownChars} | ${row.doclingMarkdownChars} | ${pct(row.live.coverage)} | ${pct(row.currentFresh.coverage)} | ${pct(row.doclingCurrent.coverage)} | ${pct(row.doclingMarkdown.coverage)} | ${row.live.chunks}/${row.currentFresh.chunks}/${row.doclingCurrent.chunks}/${row.doclingMarkdown.chunks} |`);
  }
  lines.push('');
  return lines.join('\n');
}

async function runCompare(args: Args) {
  const manifest = JSON.parse(await readFile(path.join(args.workdir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.kind !== args.kind) throw new Error(`Manifest kind is ${manifest.kind}, not ${args.kind}.`);
  const documents = new Map((await fetchDocuments(args.kind)).map((document) => [document.id, document]));
  const liveChunks = await fetchChunks(manifest.documents.map((document) => document.documentId));
  const rows: ReportRow[] = [];

  for (const entry of manifest.documents) {
    const document = documents.get(entry.documentId);
    if (!document) {
      console.warn(`skip ${entry.caseId}: document ${entry.documentId} no longer exists`);
      continue;
    }
    const mdPath = path.join(args.workdir, 'md', `${entry.caseId}.md`);
    const docling = await readFile(mdPath, 'utf8').catch(() => null);
    if (!docling) {
      console.warn(`skip ${entry.caseId}: no Docling markdown`);
      continue;
    }
    const currentSource = document.body_markdown ?? document.body_text ?? '';
    if (!currentSource) {
      console.warn(`skip ${entry.caseId}: current document has no source text`);
      continue;
    }
    const currentChunkingSource = args.kind === 'label' ? labelChunkingBody(document, currentSource) : currentSource;
    const doclingChunkingSource = args.kind === 'label' ? labelChunkingBody(document, docling) : docling;
    const [fresh, doclingThroughCurrent] = await Promise.all([
      currentChunks(args.kind, currentSource, document),
      currentChunks(args.kind, docling, document),
    ]);
    rows.push({
      caseId: entry.caseId,
      stratum: entry.stratum,
      title: document.title,
      pdfPath: entry.pdfPath,
      currentMarkdownChars: currentChunkingSource.length,
      doclingMarkdownChars: doclingChunkingSource.length,
      sourceProbes: Object.fromEntries(PROBES[args.kind].map((probe) => [probe.id, probe.test(currentChunkingSource)])),
      doclingProbes: Object.fromEntries(PROBES[args.kind].map((probe) => [probe.id, probe.test(doclingChunkingSource)])),
      live: summarize(liveChunks.get(document.id) ?? [], currentChunkingSource.length, args.kind),
      currentFresh: summarize(fresh, currentChunkingSource.length, args.kind),
      doclingCurrent: summarize(doclingThroughCurrent, doclingChunkingSource.length, args.kind),
      doclingMarkdown: summarize(markdownChunks(doclingChunkingSource), doclingChunkingSource.length, args.kind),
    });
  }
  if (rows.length === 0) throw new Error('No cases had both current corpus text and Docling markdown.');
  await writeFile(path.join(args.workdir, 'per-document.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await writeFile(path.join(args.workdir, 'report.md'), renderReport(args.kind, rows));
  console.log(`Compared ${rows.length} ${args.kind} documents.`);
  console.log(`Report: ${path.join(args.workdir, 'report.md')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'plan') await runPlan(args);
  else await runCompare(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
