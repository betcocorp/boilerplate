/**
 * B0-797 — Re-converts the 70 hygiene/skin-care efficacy lab-report PDFs
 * (s3://retool-360/efficacy/raw/<formula> Efficacy Reports/*.pdf) into the
 * markdown that lives at the matching efficacy/markdown/hygiene-skin-care/*.md
 * key, this time WITH the per-exposure-time result tables.
 *
 * Why this exists: the original conversion captured only the YAML frontmatter
 * (70 docs / 70 chunks / ~334 chars avg body). The log-reduction, percent-
 * reduction and contact-time claims underneath were dropped, so get_efficacy_data
 * cannot reach them.
 *
 * REGULATED DATA — how values are read:
 *   47 of the 70 PDFs are scanner output (Canon iR-ADV / Xerox WorkCentre) whose
 *   embedded OCR text layer corrupts digits and exponents (observed: "8.8 x 10s"
 *   for 8.8 x 10^5, "l5 seconds" for 15 seconds, "Project No.429692" for A29692).
 *   Transcribing regulated efficacy values from that layer is unsafe, so this
 *   script does NOT use it for values. Instead each candidate page is rendered to
 *   a 170 dpi PNG (poppler pdftoppm) and transcribed by a vision model under a
 *   verbatim-only prompt, THREE times, independently. A cell is kept only if all
 *   three passes agree exactly; otherwise it is written as [ILLEGIBLE] and flagged.
 *   Never a majority vote — two passes once agreed on "1.14 x 10^5" where the page
 *   prints "1.14 x 10^6", which is why unanimity of three is the bar.
 *   The OCR text layer is used only to *choose* which pages to look at.
 *
 * Normalized claim rows are derived by column-header matching only (deterministic,
 * in this file — see buildNormalizedClaims); no value is ever recomputed, rounded
 * or unit-converted. Superscripts are written as "10^5" and "Log10" because
 * markdown has no superscript — digits are untouched.
 *
 * Usage:
 *   node scripts/convert-efficacy-hygiene-pdfs.mjs --dry-run [--limit N] [--only <substr>]
 *   node scripts/convert-efficacy-hygiene-pdfs.mjs --apply
 *
 * Dry run writes markdown + a report to --out-dir (default: .efficacy-convert-out,
 * gitignored) and uploads nothing. --apply additionally PUTs each .md back to its
 * original S3 key, but only when the new body is strictly richer than the old one
 * (never shrinks a document).
 *
 * Env (.env.local): AWS_360_READ_ACCESS_KEY_ID, AWS_360_READ_SECRET_ACCESS_KEY,
 *   AWS_360_WRITE_ACCESS_KEY_ID, AWS_360_WRITE_SECRET_ACCESS_KEY, AWS_360_REGION,
 *   OPENAI_API_KEY.
 * Requires poppler (`pdftoppm`, `pdftotext`) on PATH.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import OpenAI from 'openai';

const execFileAsync = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// .env.local loader (same first-wins loader as scripts/ingest-label-md.mjs —
// note .env.local defines AWS_S3_BUCKET_NAME twice, so never rely on it here)
// ---------------------------------------------------------------------------
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
  // already exported in the environment
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY_RUN = !APPLY;
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const LIMIT = argValue('--limit') ? Number(argValue('--limit')) : null;
const ONLY = argValue('--only', null);
const OUT_DIR = resolve(__dir, '..', argValue('--out-dir', '.efficacy-convert-out'));
const CACHE_DIR = argValue('--cache-dir', join(tmpdir(), 'b0797-efficacy-pdfs'));
const CONCURRENCY = Number(argValue('--concurrency', '4'));
const VISION_MODEL = argValue('--model', 'gpt-4.1');

const BUCKET = 'retool-360';
const MD_PREFIX = 'efficacy/markdown/hygiene-skin-care/';
const RAW_PREFIX = 'efficacy/raw/';
const RENDER_DPI = 170;
// Independent vision passes that must agree cell-for-cell before a value is kept.
const PASS_COUNT = 3;
// Bump when the prompt, page selection or reconciliation changes, so cached
// transcripts from an older (weaker) contract are never reused.
const TRANSCRIPT_CACHE_VERSION = 'v3-3pass-rawcache';

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
function s3Client(mode) {
  const region = process.env.AWS_360_REGION?.trim() || 'us-east-1';
  const accessKeyId =
    mode === 'write'
      ? process.env.AWS_360_WRITE_ACCESS_KEY_ID?.trim()
      : process.env.AWS_360_READ_ACCESS_KEY_ID?.trim();
  const secretAccessKey =
    mode === 'write'
      ? process.env.AWS_360_WRITE_SECRET_ACCESS_KEY?.trim()
      : process.env.AWS_360_READ_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`Missing AWS_360_${mode.toUpperCase()}_* credentials in .env.local`);
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let usdSpent = 0;
let visionCalls = 0;
// gpt-4.1 list price, USD per 1M tokens (2026-09).
const PRICE_IN = 2.0;
const PRICE_OUT = 8.0;

function recordUsage(usage) {
  if (!usage) return;
  usdSpent +=
    ((usage.prompt_tokens ?? 0) / 1e6) * PRICE_IN +
    ((usage.completion_tokens ?? 0) / 1e6) * PRICE_OUT;
}

// ---------------------------------------------------------------------------
// S3 helpers
// ---------------------------------------------------------------------------
async function listKeys(s3, prefix) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key && !obj.Key.endsWith('/')) keys.push(obj.Key);
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys.sort();
}

async function getObject(s3, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// PDF helpers (poppler)
// ---------------------------------------------------------------------------
async function pdfPageTexts(pdfPath) {
  const { stdout } = await execFileAsync(
    'pdftotext',
    ['-layout', pdfPath, '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.split('\f');
}

async function pdfPageCount(pdfPath) {
  const { stdout } = await execFileAsync('pdfinfo', [pdfPath], { maxBuffer: 1024 * 1024 });
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  return match ? Number(match[1]) : 0;
}

async function renderPage(pdfPath, pageNumber, outDir) {
  const stem = join(outDir, `p${String(pageNumber).padStart(3, '0')}`);
  await execFileAsync('pdftoppm', [
    '-r',
    String(RENDER_DPI),
    '-png',
    '-f',
    String(pageNumber),
    '-l',
    String(pageNumber),
    '-singlefile',
    pdfPath,
    stem,
  ]);
  return `${stem}.png`;
}

/**
 * Pages worth looking at. Uses the (untrusted, OCR-corrupted) text layer only as
 * a page selector — never as a value source. Pages with no text layer at all are
 * always candidates, because we cannot rule them out.
 */
// Claim-bearing pages only. The OCR layer garbles characters, so these patterns
// are deliberately loose ("logro"/"log ro" are common OCR renderings of Log10),
// but they still exclude protocol, signature and appendix pages that carry no
// reduction claim — pages whose only value is noise we would have to police.
const CLAIM_HINT =
  /(log\s*.{0,3}\s*reduction|percent\s+reduction|%\s*reduction|calculated\s+data|test\s+results\s+for|number\s+of\s+survivors|survivors)/i;

function selectPages(pageTexts, pageCount) {
  const claimPages = [];
  const untextedPages = [];
  for (let i = 0; i < pageCount; i += 1) {
    const text = pageTexts[i] ?? '';
    if (text.replace(/\s+/g, '').length < 40) {
      untextedPages.push(i + 1);
      continue;
    }
    if (CLAIM_HINT.test(text)) claimPages.push(i + 1);
  }
  return { claimPages, untextedPages };
}

// ---------------------------------------------------------------------------
// Vision transcription
// ---------------------------------------------------------------------------
const TRANSCRIBE_PROMPT = `You are transcribing one page image from a third-party antimicrobial efficacy lab report into a regulated (EPA / FDA / GHS) document corpus.

ABSOLUTE RULES — a transcription error here becomes a false regulated claim:
- Reproduce every value EXACTLY as printed. Never round, never convert units, never recalculate, never infer or complete a missing value.
- Preserve inequality signs (<, >, =<, >=), every decimal place including trailing zeros, commas, and % signs exactly as printed.
- Superscripts: write "9.2 x 10^5" for 9.2 x 10(superscript 5), and "Log10" for Log-subscript-10. The digits themselves must not change.
- If any character of a cell is not legible with certainty, output exactly [ILLEGIBLE] for that whole cell. Never guess, never interpolate from neighbouring rows.
- If a cell is genuinely blank on the page, output an empty string.
- A cell merged across several rows: repeat its printed value in every row it spans.
- Never add a row, column, organism, contact time or footnote that is not printed on this page.
- Transcribe the caption line above each table exactly as printed, including its table number.

WHICH TABLES TO RETURN
Return tables that report efficacy results, calculated data, or survivor counts for the test product(s). Do NOT return the table of contents, signature blocks, or narrative-only pages.

OUTPUT
Return ONLY JSON matching:
{"has_results_table": boolean, "tables": [{"caption": string, "columns": [string], "rows": [[string]], "footnotes": [string]}]}
Every row must have exactly as many cells as "columns".`;

async function transcribePage(pngPath, contextLine) {
  const b64 = readFileSync(pngPath).toString('base64');
  const response = await openai.chat.completions.create({
    model: VISION_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: TRANSCRIBE_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: contextLine },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${b64}`, detail: 'high' },
          },
        ],
      },
    ],
  });
  visionCalls += 1;
  recordUsage(response.usage);
  const raw = response.choices[0]?.message?.content ?? '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return { has_results_table: false, tables: [], product_identity_text: '' };
  }
}

const normCell = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * All PASS_COUNT independent transcription passes must agree cell-for-cell.
 * Disagreement is never reconciled and never resolved by majority vote — the
 * cell becomes [ILLEGIBLE] and the document is flagged. Two passes proved too
 * weak here: on one scanned control table two passes agreed on "1.14 x 10^5"
 * where the page prints "1.14 x 10^6". Unanimity across three passes turns that
 * class of failure into a visible [ILLEGIBLE] instead of a silent wrong number.
 */
function reconcileTables(passes, flags, pageNumber) {
  const tableLists = passes.map((pass) => (Array.isArray(pass?.tables) ? pass.tables : []));
  const counts = [...new Set(tableLists.map((list) => list.length))];
  if (counts.length > 1) {
    flags.push(
      `page ${pageNumber}: passes disagreed on table count (${tableLists.map((l) => l.length).join(' vs ')}) — page dropped`,
    );
    return [];
  }

  const out = [];
  for (let t = 0; t < tableLists[0].length; t += 1) {
    const variants = tableLists.map((list) => list[t]);
    const columnSets = variants.map((v) => (v?.columns ?? []).map(normCell));
    if (new Set(columnSets.map((cols) => cols.length)).size > 1) {
      flags.push(
        `page ${pageNumber}: table ${t + 1} column count disagreed (${columnSets.map((c) => c.length).join(' vs ')}) — table dropped`,
      );
      continue;
    }

    // Header WORDING is reconciled per cell rather than all-or-nothing. These
    // lab tables use stacked/merged headers ("Initial Count CFU/mL" over
    // "Contact Time") that passes legitimately flatten differently, and dropping
    // the whole table for that threw away M000759's own claim table. An
    // unresolved header becomes [ILLEGIBLE], which also stops
    // buildNormalizedClaims mapping that column — the safe failure: values stay
    // verbatim in the printed table, but nothing is asserted about what the
    // column means.
    const columns = columnSets[0].map((header, index) => {
      const unanimous = columnSets.every((cols) => cols[index] === header);
      if (unanimous) return header;
      flags.push(
        `page ${pageNumber}: table ${t + 1} column ${index + 1} header disagreed between passes — header marked illegible, values kept`,
      );
      return '[ILLEGIBLE]';
    });

    const rowSets = variants.map((v) => (v?.rows ?? []).map((row) => row.map(normCell)));
    if (new Set(rowSets.map((rows) => rows.length)).size > 1) {
      flags.push(
        `page ${pageNumber}: table ${t + 1} row count disagreed (${rowSets.map((r) => r.length).join(' vs ')}) — table dropped`,
      );
      continue;
    }

    let illegible = 0;
    const rows = rowSets[0].map((row, r) =>
      row.map((cell, c) => {
        const unanimous = rowSets.every((rows2) => (rows2[r]?.[c] ?? '') === cell);
        if (!unanimous || cell === '[ILLEGIBLE]') {
          illegible += 1;
          return '[ILLEGIBLE]';
        }
        return cell;
      }),
    );
    if (illegible > 0) {
      flags.push(`page ${pageNumber}: table ${t + 1} has ${illegible} illegible/disputed cell(s)`);
    }

    const captions = variants.map((v) => normCell(v?.caption));
    const captionAgrees = captions.every((caption) => caption === captions[0]);
    if (!captionAgrees) {
      flags.push(`page ${pageNumber}: table ${t + 1} caption disagreed between passes`);
    }

    const footnoteSets = variants.map((v) => (v?.footnotes ?? []).map(normCell).filter(Boolean));
    const footnotes = footnoteSets[0].filter((note) =>
      footnoteSets.every((set) => set.includes(note)),
    );

    out.push({
      caption: captionAgrees ? captions[0] : '[ILLEGIBLE]',
      columns,
      rows,
      footnotes,
      illegibleCells: illegible,
      pageNumber,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalized claim rows — column-header matching only. No value is transformed.
// ---------------------------------------------------------------------------
const COLUMN_MATCHERS = {
  organism: /organism|microorganism/i,
  atcc: /^atcc/i,
  contactTime: /(exposure|contact)\s*time/i,
  logReduction: /log.{0,4}\s*reduction/i,
  percentReduction: /(percent|%)\s*reduction/i,
};

function indexOfColumn(columns, matcher) {
  for (let i = 0; i < columns.length; i += 1) {
    if (matcher.test(columns[i])) return i;
  }
  return -1;
}

function buildNormalizedClaims(table) {
  const cols = table.columns;
  const iOrganism = indexOfColumn(cols, COLUMN_MATCHERS.organism);
  const iAtcc = indexOfColumn(cols, COLUMN_MATCHERS.atcc);
  const iTime = indexOfColumn(cols, COLUMN_MATCHERS.contactTime);
  const iLog = indexOfColumn(cols, COLUMN_MATCHERS.logReduction);
  const iPct = indexOfColumn(cols, COLUMN_MATCHERS.percentReduction);

  if (iOrganism === -1 || iTime === -1 || (iLog === -1 && iPct === -1)) return null;

  const rows = [];
  let lastOrganism = '';
  for (const row of table.rows) {
    const organismCell = normCell(row[iOrganism]) || lastOrganism;
    if (organismCell) lastOrganism = organismCell;
    const time = normCell(row[iTime]);
    if (!organismCell || !time) continue;

    // ATCC is either its own column or printed inside the organism cell as
    // "(ATCC 6538)" — pulling it out is a split of printed text, not a lookup.
    let atcc = iAtcc !== -1 ? normCell(row[iAtcc]) : '';
    let organism = organismCell;
    if (!atcc) {
      const inline = organismCell.match(/\(?\bATCC\s*(?:No\.?)?\s*([A-Za-z0-9-]+)\)?/i);
      if (inline) {
        atcc = inline[1];
        organism = organismCell.replace(inline[0], '').replace(/\s+/g, ' ').trim();
      }
    }

    rows.push([
      organism,
      atcc,
      time,
      iLog !== -1 ? normCell(row[iLog]) : '',
      iPct !== -1 ? normCell(row[iPct]) : '',
    ]);
  }
  return rows.length > 0 ? rows : null;
}

// ---------------------------------------------------------------------------
// Markdown assembly
// ---------------------------------------------------------------------------
const escapePipes = (value) => String(value ?? '').replaceAll('|', '\\|');

function renderMarkdownTable(columns, rows) {
  const header = `| ${columns.map(escapePipes).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(escapePipes).join(' | ')} |`).join('\n');
  return `${header}\n${divider}\n${body}`;
}

const CLAIM_COLUMNS = ['Organism', 'ATCC', 'Contact Time', 'Log Reduction', 'Percent Reduction'];

// A table more than half of whose cells the passes could not agree on is noise,
// not evidence — publishing it would put a wall of [ILLEGIBLE] into retrieval
// where a reader expects data. Dropped tables are counted in the report so the
// loss is visible rather than silent.
const MAX_ILLEGIBLE_SHARE = 0.5;

function isMostlyIllegible(table) {
  const cells = table.rows.reduce((sum, row) => sum + row.length, 0);
  return cells > 0 && table.illegibleCells / cells > MAX_ILLEGIBLE_SHARE;
}

/**
 * Restates the document's own frontmatter facts inside the body so they land in
 * a chunk. Purely a copy of fields already on this document — nothing is joined,
 * inferred, or matched to a table row.
 */
function buildScopeSection(frontmatter) {
  const wanted = [
    'formula_code',
    'product_name',
    'version',
    'project_number',
    'epa_reg_no',
    'lab',
    'report_date',
    'organisms',
    'assay_types',
  ];
  const lines = [];
  for (const line of frontmatter.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (!wanted.includes(key) || !value || value === 'null') continue;
    lines.push(`- ${key.replaceAll('_', ' ')}: ${value}`);
  }
  return lines.length > 0 ? `## Report scope\n\n${lines.join('\n')}` : null;
}

function buildBody(tables, sourcePdfKey, frontmatter) {
  const sections = [];

  const scope = buildScopeSection(frontmatter);
  if (scope) sections.push(scope);

  for (const table of tables) {
    // An unread caption becomes a neutral positional heading rather than a
    // literal "## [ILLEGIBLE]", which reads as if the data were unreadable when
    // only the caption was.
    const caption =
      !table.caption || table.caption === '[ILLEGIBLE]'
        ? `Table on page ${table.pageNumber} (caption not legible)`
        : table.caption;
    // The caption names the test product the table belongs to; it stays in the
    // heading so the chunker's breadcrumb carries it into chunk_text. Multi-
    // formula panel reports file the same PDF under several formula folders,
    // so the reader must be able to see which table is which product.
    const heading = `## ${caption}`;
    const parts = [heading, ''];

    const claims = buildNormalizedClaims(table);
    if (claims) {
      parts.push(renderMarkdownTable(CLAIM_COLUMNS, claims), '');
    }

    parts.push('Source table as printed:', '');
    parts.push(renderMarkdownTable(table.columns, table.rows));
    if (table.footnotes.length > 0) {
      parts.push('', table.footnotes.map((note) => `- ${note}`).join('\n'));
    }
    sections.push(parts.join('\n').trim());
  }

  if (sections.length <= (scope ? 1 : 0)) return null;

  sections.push(
    `## Source\n\nTranscribed verbatim from the page images of s3://${BUCKET}/${sourcePdfKey} (${PASS_COUNT} independent transcription passes; any cell the passes did not agree on exactly is marked [ILLEGIBLE]).`,
  );
  return sections.join('\n\n');
}

function splitFrontmatter(markdown) {
  const match = markdown.match(/^(---\r?\n[\s\S]*?\r?\n---)\r?\n?([\s\S]*)$/);
  if (!match) return null;
  return { frontmatter: match[1], body: match[2] ?? '' };
}

// ---------------------------------------------------------------------------
// Per-PDF transcription, cached on the PDF's own content hash. 70 markdown
// documents resolve to only ~50 unique PDFs (multi-formula panel reports are
// filed under every formula's folder), and re-runs should be free.
//
// The cache holds the RAW per-page passes, not the reconciled tables, so
// tightening or loosening reconcileTables costs nothing to re-apply. Only a
// prompt / page-selection / pass-count change needs new vision calls — bump
// TRANSCRIPT_CACHE_VERSION for those.
// ---------------------------------------------------------------------------
const inFlightTranscripts = new Map();

async function transcribePdf(pdfPath) {
  const contentHash = createHash('sha256').update(readFileSync(pdfPath)).digest('hex');
  const cachePath = join(CACHE_DIR, '_transcripts', `${TRANSCRIPT_CACHE_VERSION}-${contentHash}.json`);

  const reconcile = (raw) => {
    const flags = [...raw.flags];
    const tables = [];
    for (const page of raw.pages) {
      tables.push(...reconcileTables(page.passes, flags, page.pageNumber));
    }
    return { pageCount: raw.pageCount, candidates: raw.candidates, tables, flags };
  };

  if (existsSync(cachePath)) {
    return reconcile(JSON.parse(readFileSync(cachePath, 'utf8')));
  }
  const pending = inFlightTranscripts.get(contentHash);
  if (pending) return pending;

  const promise = (async () => {
    const flags = [];
    const pageCount = await pdfPageCount(pdfPath);
    const pageTexts = await pdfPageTexts(pdfPath);
    const { claimPages, untextedPages } = selectPages(pageTexts, pageCount);
    const candidates = [...new Set([...claimPages, ...untextedPages])].sort((a, b) => a - b);
    if (untextedPages.length === pageCount && pageCount > 0) {
      flags.push(`PDF has no text layer at all (${pageCount} pages) — every page transcribed by vision`);
    }

    const renderDir = join(CACHE_DIR, '_render', contentHash);
    mkdirSync(renderDir, { recursive: true });
    const pages = [];

    for (const pageNumber of candidates) {
      const png = await renderPage(pdfPath, pageNumber, renderDir);
      const context = `Page ${pageNumber} of ${pageCount}.`;
      const passes = await Promise.all(
        Array.from({ length: PASS_COUNT }, () => transcribePage(png, context)),
      );
      rmSync(png, { force: true });
      pages.push({ pageNumber, passes });
    }
    rmSync(renderDir, { recursive: true, force: true });

    const raw = { pageCount, candidates, pages, flags };
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(raw));
    return reconcile(raw);
  })();

  inFlightTranscripts.set(contentHash, promise);
  try {
    return await promise;
  } finally {
    inFlightTranscripts.delete(contentHash);
  }
}

// ---------------------------------------------------------------------------
// Per-document conversion
// ---------------------------------------------------------------------------
async function convertOne(s3, mdKey, rawKey) {
  const flags = [];

  const existingMd = (await getObject(s3, mdKey)).toString('utf8');
  const split = splitFrontmatter(existingMd);
  if (!split) {
    return { mdKey, rawKey, status: 'skipped', reason: 'existing markdown has no YAML frontmatter block', flags };
  }

  const pdfPath = join(CACHE_DIR, rawKey.slice(RAW_PREFIX.length));
  if (!existsSync(pdfPath)) {
    mkdirSync(dirname(pdfPath), { recursive: true });
    writeFileSync(pdfPath, await getObject(s3, rawKey));
  }

  const transcript = await transcribePdf(pdfPath);
  flags.push(...transcript.flags);
  const { pageCount, candidates } = transcript;

  if (candidates.length === 0) {
    return { mdKey, rawKey, status: 'skipped', reason: 'no candidate pages found in PDF', pageCount, flags };
  }

  const tables = transcript.tables.filter((table) => {
    if (!isMostlyIllegible(table)) return true;
    flags.push(
      `page ${table.pageNumber}: "${table.caption}" dropped — ${table.illegibleCells} of ${table.rows.reduce((sum, row) => sum + row.length, 0)} cells could not be read consistently`,
    );
    return false;
  });

  const body = buildBody(tables, rawKey, split.frontmatter);
  if (!body) {
    return {
      mdKey,
      rawKey,
      status: 'no-tables',
      reason: `no result tables could be transcribed from ${candidates.length} candidate page(s)`,
      pageCount,
      candidatePages: candidates.length,
      flags,
    };
  }

  const markdown = `${split.frontmatter}\n\n${body}\n`;

  // Safety: never replace a document with something poorer than what is there.
  if (markdown.length <= existingMd.length) {
    return {
      mdKey,
      rawKey,
      status: 'kept-old',
      reason: `new markdown (${markdown.length} chars) is not larger than existing (${existingMd.length} chars)`,
      flags,
    };
  }

  return {
    mdKey,
    rawKey,
    status: 'converted',
    pageCount,
    candidatePages: candidates.length,
    tableCount: tables.length,
    claimTables: tables.filter((t) => buildNormalizedClaims(t)).length,
    illegibleCells: tables.reduce((sum, t) => sum + t.illegibleCells, 0),
    oldChars: existingMd.length,
    newChars: markdown.length,
    markdown,
    flags,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  for (const binary of ['pdftoppm', 'pdftotext', 'pdfinfo']) {
    try {
      await execFileAsync(binary, ['-v']);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`${binary} not found on PATH (install poppler).`);
    }
  }

  const s3Read = s3Client('read');
  const s3Write = APPLY ? s3Client('write') : null;

  log(`Listing s3://${BUCKET}/${MD_PREFIX} …`);
  const mdKeys = (await listKeys(s3Read, MD_PREFIX)).filter((key) => key.endsWith('.md'));
  const rawKeys = new Set(await listKeys(s3Read, RAW_PREFIX));
  log(`${mdKeys.length} hygiene/skin-care markdown documents.`);

  let pairs = mdKeys.map((mdKey) => ({
    mdKey,
    rawKey: `${RAW_PREFIX}${mdKey.slice(MD_PREFIX.length).replace(/\.md$/, '.pdf')}`,
  }));

  const missing = pairs.filter((pair) => !rawKeys.has(pair.rawKey));
  pairs = pairs.filter((pair) => rawKeys.has(pair.rawKey));
  if (ONLY) pairs = pairs.filter((pair) => pair.mdKey.includes(ONLY));
  if (LIMIT) pairs = pairs.slice(0, LIMIT);
  log(`${pairs.length} to process, ${missing.length} without a raw PDF.`);

  mkdirSync(OUT_DIR, { recursive: true });

  const results = missing.map((pair) => ({
    ...pair,
    status: 'skipped',
    reason: 'no matching raw PDF in s3://retool-360/efficacy/raw/',
    flags: [],
  }));

  let cursor = 0;
  let done = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= pairs.length) return;
      const pair = pairs[index];
      try {
        const result = await convertOne(s3Read, pair.mdKey, pair.rawKey);
        results.push(result);
        if (result.status === 'converted') {
          const outPath = join(OUT_DIR, result.mdKey.slice(MD_PREFIX.length));
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, result.markdown);
          if (APPLY) {
            await s3Write.send(
              new PutObjectCommand({
                Bucket: BUCKET,
                Key: result.mdKey,
                Body: result.markdown,
                ContentType: 'text/markdown; charset=utf-8',
              }),
            );
          }
        }
      } catch (error) {
        results.push({
          ...pair,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          flags: [],
        });
      }
      done += 1;
      log(`  ${done}/${pairs.length} — ${basename(pair.mdKey)} (~$${usdSpent.toFixed(2)} so far)`);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));

  const summary = {
    generated_at: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    vision_model: VISION_MODEL,
    render_dpi: RENDER_DPI,
    vision_calls: visionCalls,
    estimated_usd: Number(usdSpent.toFixed(4)),
    totals: results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {}),
    // `markdown` is deliberately dropped — the report is a manifest, the
    // converted files themselves are written to OUT_DIR.
    documents: results
      .map((result) => Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'markdown')))
      .sort((a, b) => a.mdKey.localeCompare(b.mdKey)),
  };
  const reportPath = join(OUT_DIR, 'conversion-report.json');
  writeFileSync(reportPath, JSON.stringify(summary, null, 2));

  log(`Done. ${JSON.stringify(summary.totals)}`);
  log(`Vision calls: ${visionCalls}; estimated spend $${usdSpent.toFixed(2)}`);
  log(`Report: ${reportPath}`);
  if (DRY_RUN) log('Dry run — nothing uploaded to S3. Re-run with --apply to publish.');
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
