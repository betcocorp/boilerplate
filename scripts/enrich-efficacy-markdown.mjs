/**
 * B0-224 — Cross-checks and enriches the 70 already-converted efficacy
 * lab-report markdown files (s3://<AWS_S3_BUCKET_NAME>/efficacy/markdown/
 * hygiene-skin-care/**\/*.md) against the B0-223 version table
 * (src/lib/training/efficacy-version-table.json).
 *
 * This does NOT re-convert PDFs to markdown (that already happened). It only:
 *   1. Fills the `is_current` / `status` frontmatter fields — currently the
 *      literal string "UNKNOWN" in every one of the 70 files — by matching
 *      each file's own `source_pdf` frontmatter field against the version
 *      table's `source_pdf_filename` column (an exact S3-key/basename join,
 *      not a fuzzy formula+version guess). Only touches a field when its
 *      current value is exactly "UNKNOWN" — an already-populated value is
 *      NEVER overwritten, only flagged if it disagrees with the resolved
 *      value.
 *   2. Flags (does not silently "fix") table-jamming defects — organism name
 *      glued directly to a digit with no separator, e.g. "aeruginosa1 Minute"
 *      — and frontmatter formula_code values that don't match the S3 folder
 *      they live in (e.g. "796" instead of "M000796" under the "Unused
 *      Formulas Efficacy" subfolder).
 *   3. Writes a full per-file report to
 *      src/lib/training/efficacy-markdown-enrichment-report.json so a human
 *      can review every resolution/flag before anything is re-uploaded.
 *
 * product_name / epa_reg_no are intentionally left untouched: the Master
 * Efficacy Version Data workbook (B0-223's only source) carries neither
 * field, so there is no confident source to resolve them from here — they
 * stay whatever the original conversion set them to (already-populated,
 * null, or "UNKNOWN"), never guessed.
 *
 * Usage:
 *   node --env-file=.env.local scripts/enrich-efficacy-markdown.mjs [--dry-run]
 *
 * --dry-run: writes the report but does not PUT any corrected file back to S3.
 */

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFileSync, writeFileSync } from 'fs';
import yaml from 'js-yaml';
import { basename, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '..');
const VERSION_TABLE_PATH = resolve(REPO_ROOT, 'src/lib/training/efficacy-version-table.json');
const REPORT_PATH = resolve(REPO_ROOT, 'src/lib/training/efficacy-markdown-enrichment-report.json');

const DRY_RUN = process.argv.includes('--dry-run');
const MD_PREFIX = 'efficacy/markdown/hygiene-skin-care/';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function getS3Client() {
  const region = process.env.AWS_REGION?.trim();
  const accessKeyId = process.env.AWS_ACCESS_READ_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_READ_ACCESS_KEY?.trim();
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS_REGION / AWS_ACCESS_READ_KEY_ID / AWS_SECRET_READ_ACCESS_KEY in .env.local');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function getWriteS3Client() {
  const region = process.env.AWS_REGION?.trim();
  const accessKeyId = process.env.AWS_ACCESS_WRITE_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_WRITE_ACCESS_KEY?.trim();
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS_REGION / AWS_ACCESS_WRITE_KEY_ID / AWS_SECRET_WRITE_ACCESS_KEY in .env.local');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function getBucket() {
  const bucket = process.env.AWS_S3_BUCKET_NAME?.trim();
  if (!bucket) throw new Error('Missing AWS_S3_BUCKET_NAME in .env.local');
  return bucket;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function listMarkdownKeys(client, bucket) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: MD_PREFIX, ContinuationToken }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key && /\.md$/i.test(obj.Key)) keys.push(obj.Key);
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys.sort();
}

function splitFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('No YAML frontmatter block found');
  return { frontmatterBlock: match[1], frontmatterRaw: match[0], body: match[2] ?? '' };
}

// Folder-derived formula code, e.g. "M000796 Efficacy Reports" -> "M000796",
// "M000796 Efficacy Reports/Unused Formulas Efficacy" -> still "M000796"
// (the top-level folder, not the "Unused Formulas Efficacy" subfolder name).
function folderFormulaCode(key) {
  const relative = key.slice(MD_PREFIX.length);
  const topFolder = relative.split('/')[0] ?? '';
  const match = topFolder.match(/^(M[A-Z0-9]+)\s+Efficacy Reports$/i);
  return match ? match[1].toUpperCase() : topFolder.toUpperCase();
}

// Frontmatter formula_code sometimes drops the "M0.." prefix entirely (e.g.
// "796" instead of "M000796" — seen under M000796's "Unused Formulas
// Efficacy" subfolder). Treat a bare numeric code as equivalent to the
// corresponding M-prefixed code by zero-padding, purely for the consistency
// check below — the frontmatter value itself is never rewritten.
function normalizeFormulaCodeForComparison(code) {
  const trimmed = (code ?? '').trim().toUpperCase();
  if (/^M/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `M${trimmed.padStart(6, '0')}`;
  return trimmed;
}

// The exact table-jamming defect the ticket cites as precedent: an organism
// name glued directly to a digit with no separator (e.g.
// "Pseudomonas aeruginosa1 Minute" instead of "Pseudomonas aeruginosa | 1
// Minute"), which indicates a markdown table column boundary was lost.
const TABLE_JAM_RE = /\b(aeruginosa|aureus|enterica)\d/i;

function detectTableJamming(body) {
  const hits = [];
  const lines = body.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (TABLE_JAM_RE.test(line)) {
      hits.push({ line: i + 1, text: line.trim() });
    }
  }
  return hits;
}

async function main() {
  const versionTable = JSON.parse(readFileSync(VERSION_TABLE_PATH, 'utf8'));
  const rows = versionTable.rows;

  // basename(pdf key) -> version-table row. Multiple basenames can point to
  // the same row (a row can cite several sub-version PDFs); that's fine here
  // since is_current/status are constant across all PDFs a single row
  // covers.
  const pdfBasenameToRow = new Map();
  for (const row of rows) {
    if (!row.source_pdf_filename) continue;
    for (const key of row.source_pdf_filename.split('; ')) {
      pdfBasenameToRow.set(basename(key), row);
    }
  }

  const readClient = getS3Client();
  const bucket = getBucket();

  log(`Listing markdown under s3://${bucket}/${MD_PREFIX} ...`);
  const mdKeys = await listMarkdownKeys(readClient, bucket);
  log(`Found ${mdKeys.length} markdown file(s).`);

  const report = [];
  let toUpload = [];

  for (const key of mdKeys) {
    const res = await readClient.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const raw = await streamToString(res.Body);
    const { frontmatterBlock, frontmatterRaw, body } = splitFrontmatter(raw);
    const fm = yaml.load(frontmatterBlock) ?? {};

    const sourcePdf = typeof fm.source_pdf === 'string' ? fm.source_pdf.replace(/^"|"$/g, '') : null;
    const matchedRow = sourcePdf ? pdfBasenameToRow.get(sourcePdf) : undefined;

    const entry = {
      key,
      source_pdf: sourcePdf,
      matched_version_table_row: matchedRow
        ? { formula_code: matchedRow.formula_code, version: matchedRow.version, status: matchedRow.status, is_current: matchedRow.is_current }
        : null,
      resolution: 'unresolved',
      changes: [],
      flags: [],
    };

    let newFrontmatterBlock = frontmatterBlock;

    if (matchedRow) {
      const currentIsCurrentRaw = fm.is_current;
      const currentStatusRaw = fm.status;

      const isCurrentIsUnknown =
        typeof currentIsCurrentRaw === 'string' && currentIsCurrentRaw.trim().toUpperCase() === 'UNKNOWN';
      const statusIsUnknown =
        typeof currentStatusRaw === 'string' && currentStatusRaw.trim().toUpperCase() === 'UNKNOWN';

      if (isCurrentIsUnknown) {
        const replacement = `is_current: ${matchedRow.is_current}`;
        if (/^is_current:\s*UNKNOWN\s*$/m.test(newFrontmatterBlock)) {
          newFrontmatterBlock = newFrontmatterBlock.replace(/^is_current:\s*UNKNOWN\s*$/m, replacement);
          entry.changes.push({ field: 'is_current', from: 'UNKNOWN', to: matchedRow.is_current });
        }
      } else if (currentIsCurrentRaw !== matchedRow.is_current) {
        entry.flags.push(
          `is_current already set to ${JSON.stringify(currentIsCurrentRaw)}, but version table resolves to ${matchedRow.is_current} — NOT overwritten, needs human review`,
        );
      }

      if (statusIsUnknown) {
        const replacement = `status: ${matchedRow.status}`;
        if (/^status:\s*UNKNOWN\s*$/m.test(newFrontmatterBlock)) {
          newFrontmatterBlock = newFrontmatterBlock.replace(/^status:\s*UNKNOWN\s*$/m, replacement);
          entry.changes.push({ field: 'status', from: 'UNKNOWN', to: matchedRow.status });
        }
      } else if (currentStatusRaw !== matchedRow.status) {
        entry.flags.push(
          `status already set to ${JSON.stringify(currentStatusRaw)}, but version table resolves to ${matchedRow.status} — NOT overwritten, needs human review`,
        );
      }

      entry.resolution = entry.changes.length > 0 ? 'enriched' : 'already_populated_or_unchanged';
    } else {
      entry.flags.push(
        `No version-table row cites this source_pdf ("${sourcePdf}") — is_current/status left as-is, needs manual cross-reference`,
      );
    }

    // Formula-code consistency check (frontmatter vs. S3 folder).
    const folderCode = folderFormulaCode(key);
    const fmCode = typeof fm.formula_code === 'string' ? fm.formula_code : null;
    if (fmCode && normalizeFormulaCodeForComparison(fmCode) !== folderCode) {
      entry.flags.push(
        `frontmatter formula_code ("${fmCode}") does not match the S3 folder's formula code ("${folderCode}") — verify which is correct`,
      );
    }

    // Table-jamming check (organism name glued to a digit with no separator).
    const jamHits = detectTableJamming(body);
    if (jamHits.length > 0) {
      entry.flags.push(
        `TABLE_JAMMING_SUSPECTED: organism name immediately followed by a digit (no separator) on line(s) ${jamHits
          .map((h) => h.line)
          .join(', ')} — re-derive this table from the source PDF, do not guess the split point`,
      );
      entry.table_jam_hits = jamHits;
    }

    if (newFrontmatterBlock !== frontmatterBlock) {
      const newRaw = raw.replace(frontmatterRaw, `---\n${newFrontmatterBlock}\n---\n`);
      toUpload.push({ key, content: newRaw });
    }

    report.push(entry);
  }

  const summary = {
    generated_at: new Date().toISOString(),
    total_markdown_files: mdKeys.length,
    enriched: report.filter((r) => r.resolution === 'enriched').length,
    unresolved: report.filter((r) => r.resolution === 'unresolved').length,
    already_populated_or_unchanged: report.filter((r) => r.resolution === 'already_populated_or_unchanged').length,
    files_with_flags: report.filter((r) => r.flags.length > 0).length,
    files_with_suspected_table_jamming: report.filter((r) => r.table_jam_hits?.length).length,
  };

  log(`Summary: ${JSON.stringify(summary, null, 2)}`);

  writeFileSync(REPORT_PATH, JSON.stringify({ summary, files: report }, null, 2));
  log(`Wrote ${REPORT_PATH}`);

  if (DRY_RUN) {
    log(`--dry-run set: ${toUpload.length} file(s) would be re-uploaded to S3 — skipping upload.`);
    return;
  }

  if (toUpload.length === 0) {
    log('No frontmatter changes to upload.');
    return;
  }

  const writeClient = getWriteS3Client();
  log(`Uploading ${toUpload.length} corrected file(s) back to S3 ...`);
  for (const { key, content } of toUpload) {
    await writeClient.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, ContentType: 'text/markdown' }),
    );
  }
  log('Upload complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
