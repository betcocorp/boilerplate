/**
 * B0-223 — Parses "Master Efficacy Version Data.xlsx" (s3://<AWS_S3_BUCKET_NAME>/
 * efficacy/raw/Master Efficacy Version Data.xlsx) into a normalized version
 * table, cross-referenced against the 70 raw lab-report PDFs under
 * efficacy/raw/<Formula> Efficacy Reports/*.pdf.
 *
 * This is a standalone, idempotent, rerunnable batch job (same convention as
 * scripts/ingest-label-md.mjs) — it does NOT write to Supabase. It only reads
 * from S3 and writes two committed fixtures:
 *   - src/lib/training/efficacy-version-table.json
 *   - src/lib/training/efficacy-version-table.csv
 *
 * Every numeric/lab-report value (project numbers, dates, lab names,
 * descriptions) is transcribed VERBATIM from the workbook — never rounded,
 * reformatted, or inferred. Where the workbook and the raw PDF filenames
 * disagree, or a row/PDF has no confident match, this script records a flag
 * instead of guessing (see `flags` / `pdf_match_status` in the output).
 *
 * Usage:
 *   node --env-file=.env.local scripts/build-efficacy-version-table.mjs [--dry-run]
 *
 * Env (from .env.local): AWS_REGION, AWS_S3_BUCKET_NAME, AWS_ACCESS_READ_KEY_ID,
 *   AWS_SECRET_READ_ACCESS_KEY.
 */

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import XLSX from 'xlsx';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '..');
const OUT_JSON = join(REPO_ROOT, 'src/lib/training/efficacy-version-table.json');
const OUT_CSV = join(REPO_ROOT, 'src/lib/training/efficacy-version-table.csv');

const DRY_RUN = process.argv.includes('--dry-run');

const EFFICACY_PREFIX = 'efficacy/';
const XLSX_KEY = 'efficacy/raw/Master Efficacy Version Data.xlsx';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function getS3Client() {
  const region = process.env.AWS_REGION?.trim();
  const accessKeyId = process.env.AWS_ACCESS_READ_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_READ_ACCESS_KEY?.trim();
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Missing AWS_REGION / AWS_ACCESS_READ_KEY_ID / AWS_SECRET_READ_ACCESS_KEY in .env.local',
    );
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function getBucket() {
  const bucket = process.env.AWS_S3_BUCKET_NAME?.trim();
  if (!bucket) throw new Error('Missing AWS_S3_BUCKET_NAME in .env.local');
  return bucket;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function listAllRawPdfKeys(client, bucket) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${EFFICACY_PREFIX}raw/`,
        ContinuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key && /\.pdf$/i.test(obj.Key)) keys.push(obj.Key);
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

// ---------------------------------------------------------------------------
// Raw PDF filename parsing
// ---------------------------------------------------------------------------

/**
 * Extracts formula_code (top-level "<code> Efficacy Reports" folder),
 * whether it's under the "Unused Formulas Efficacy" subfolder, the raw
 * version token as printed in the filename (e.g. "3", "4a", "4 DF.FF", "NA",
 * "UA"), and any project-number-shaped tokens found in the filename.
 * Everything here is derived from the filename text only — no PDF content is
 * read by this script (B0-224 spot-checks PDF content separately).
 */
function parseRawPdfKey(key) {
  const relative = key.slice(`${EFFICACY_PREFIX}raw/`.length);
  const segments = relative.split('/');
  const folderName = segments[0] ?? '';
  const isUnusedFolder = segments.length > 2 && /unused formulas/i.test(segments[1] ?? '');
  const fileName = segments[segments.length - 1];
  const formulaFolderMatch = folderName.match(/^(M[A-Z0-9]+)\s+Efficacy Reports$/i);
  const formulaCode = formulaFolderMatch ? formulaFolderMatch[1] : folderName;

  const versionMatch = fileName.match(/Version\s+([A-Za-z0-9]+)/i);
  const rawVersionToken = versionMatch ? versionMatch[1] : null;
  // Base numeric version (so "4a"/"4b"/"4c" all compare-equal to master-sheet "4").
  const baseVersionMatch = rawVersionToken?.match(/^(\d+)/);
  const baseVersion = baseVersionMatch ? baseVersionMatch[1] : rawVersionToken;

  // Project-number-shaped tokens: A##### / V###-### / ###-### / "None Needed"
  // style codes. Strip the leading "<formulaCode> " prefix first (most
  // filenames start with it, e.g. "M000796 Version 6 ... Project A32791...")
  // so the formula code itself never gets misread as a lab project number.
  const fileNameForProjectSearch = fileName.replace(
    new RegExp(`^${formulaCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'),
    '',
  );
  const projectTokens = [
    ...fileNameForProjectSearch.matchAll(/\b[A-Z]{1,2}\d{3,6}\b/g),
    ...fileNameForProjectSearch.matchAll(/\bV?\d{2,3}-\d{2,3}\b/g),
  ]
    .map((m) => m[0])
    .filter((t) => !/^M\d{3,6}$/i.test(t)); // belt-and-suspenders vs. any other formula-code-shaped token

  const qualifierMatch = fileName.match(/\(([^)]+)\)/);
  const qualifier = qualifierMatch ? qualifierMatch[1] : null;

  const dffFlag = /DF\.?FF/i.test(fileName);

  const organismTokens = [];
  if (/\bPA\b/.test(fileName)) organismTokens.push('PA');
  if (/\bSA\b/.test(fileName)) organismTokens.push('SA');
  if (/\bSE\b/.test(fileName)) organismTokens.push('SE');
  if (/Multiple Species/i.test(fileName)) organismTokens.push('Multiple Species');

  const dedupedProjectTokens = [...new Set(projectTokens)];

  return {
    key,
    fileName,
    formulaCode,
    isUnusedFolder,
    rawVersionToken,
    baseVersion,
    projectTokens: dedupedProjectTokens,
    projectTokensNorm: dedupedProjectTokens.map(normalizeProjectToken),
    qualifier,
    dffFlag,
    organismTokens,
    hasParsedVersion: rawVersionToken !== null,
  };
}

// ---------------------------------------------------------------------------
// Workbook parsing
// ---------------------------------------------------------------------------

// Microbac-style project numbers appear as "V566-121" in the workbook but as
// "566-121" (no leading V) in the actual PDF filenames. Normalize (comparison
// only — never used for display) so this benign formatting difference
// doesn't produce false-positive mismatch flags.
function normalizeProjectToken(token) {
  return token.replace(/^V(?=\d{2,3}-\d{2,3}$)/i, '').toUpperCase();
}

function forwardFill(rows, colIndex) {
  let current = null;
  return rows.map((row) => {
    const val = row[colIndex];
    if (val !== null && val !== undefined && String(val).trim() !== '') {
      current = val;
    }
    return current;
  });
}

// Only checks the meaningful data columns (0-6: Formula/Version/Lab/Project/
// Date/Current/Description) — trailing columns hold stray legend text/notes
// (e.g. a lone ":" character) that would otherwise make an empty separator
// row look non-blank and get misread as a real data row with a
// forward-filled formula code and a null version.
function isBlankRow(row) {
  return row
    .slice(0, 8)
    .every((cell) => cell === null || cell === undefined || String(cell).trim() === '');
}

function parseMasterVersionTable(workbook) {
  const sheetName = workbook.SheetNames.find((n) => /master version table/i.test(n));
  if (!sheetName) throw new Error('Could not find "Master Version Table" sheet');
  const ws = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
  const dataRows = rows.slice(1).filter((r) => !isBlankRow(r));

  const formulaFilled = forwardFill(dataRows, 0);

  return dataRows.map((row, i) => ({
    formula_code: formulaFilled[i]?.trim() ?? null,
    version: row[1] != null ? String(row[1]).trim() : null,
    third_party_lab: row[2] != null ? String(row[2]).trim() : null,
    project_number: row[3] != null ? String(row[3]).trim() : null,
    date_changed: row[4] != null ? String(row[4]).trim() : null,
    is_current: String(row[5] ?? '').trim().toLowerCase() === 'yes',
    description_of_change: row[6] != null ? String(row[6]).trim() : null,
  }));
}

function parseCurrentVersionEfficacy(workbook) {
  const sheetName = workbook.SheetNames.find((n) => /current version efficacy/i.test(n));
  if (!sheetName) throw new Error('Could not find "Current Version Efficacy" sheet');
  const ws = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
  const dataRows = rows.slice(1).filter((r) => !isBlankRow(r));

  const formulaFilled = forwardFill(dataRows, 0);
  const currentVersionFilled = forwardFill(dataRows, 1);
  const labFilled = forwardFill(dataRows, 2);
  const projectFilled = forwardFill(dataRows, 3);

  // Group organism rows under their formula.
  const byFormula = new Map();
  dataRows.forEach((row, i) => {
    const formula = formulaFilled[i]?.trim();
    if (!formula) return;
    if (!byFormula.has(formula)) {
      const rawCurrentVersion = currentVersionFilled[i] != null ? String(currentVersionFilled[i]).trim() : null;
      // Greedy `.*` (not `[^)]+`) so nested parens — e.g. "7 (V6 (-5% eth)
      // data)" — capture the full outer parenthetical instead of stopping at
      // the first inner ")".
      const citesMatch = rawCurrentVersion?.match(/^([^(]+?)\s*\((.*)\)\s*$/);
      byFormula.set(formula, {
        formula_code: formula,
        current_version_raw: rawCurrentVersion,
        current_version_numeric: citesMatch ? citesMatch[1].trim() : rawCurrentVersion,
        cites_earlier_version_data: citesMatch ? citesMatch[2].trim() : null,
        third_party_lab: labFilled[i] != null ? String(labFilled[i]).trim() : null,
        project_number: projectFilled[i] != null ? String(projectFilled[i]).trim() : null,
        organisms: [],
      });
    }
    const entry = byFormula.get(formula);
    if (row[4] != null && String(row[4]).trim() !== '') {
      entry.organisms.push({
        organism: String(row[4]).trim(),
        optimal_contact_time: row[5] != null ? String(row[5]).trim() : null,
        log_reduction: row[6] != null ? String(row[6]).trim() : null,
        percent_reduction: row[7] != null ? String(row[7]).trim() : null,
      });
    }
  });

  return byFormula;
}

// ---------------------------------------------------------------------------
// Status classification (verbatim-preserving — see AGENTS.md regulated-data
// rule: never round/convert/infer numeric or claim data).
// ---------------------------------------------------------------------------
function classifyStatus(row) {
  const desc = (row.description_of_change ?? '').toLowerCase();
  if (row.is_current) return 'active';
  if (/never activat/.test(desc)) return 'never_activated';
  if (/^no version\s+\d+/i.test((row.description_of_change ?? '').trim())) return 'never_activated';
  return 'superseded';
}

// Splits a composite project-number cell ("A29692, A29693, A29694", "V566-121
// or A17851", "With Fragrance (A29283, A29284, A29285) Without Fragrance
// (A30701), -5% less ethanol (A32791)") into individual project tokens for
// matching against PDF filenames. Preserves the original string separately —
// this is only used for cross-referencing, never displayed as "the" value.
function extractProjectTokens(projectNumberRaw) {
  if (!projectNumberRaw) return [];
  const tokens = [
    ...projectNumberRaw.matchAll(/\bV?\d{2,3}-\d{2,3}\b/g),
    ...projectNumberRaw.matchAll(/\b[A-Z]{1,2}\d{3,6}\b/g),
  ].map((m) => m[0]);
  const unique = [...new Set(tokens)];
  // Drop shorter tokens that are strict substrings of a longer token already
  // captured (e.g. "V566" subsumed by "V566-121") — these are the same
  // underlying project number, not two separate ones.
  return unique.filter((t) => !unique.some((other) => other !== t && other.startsWith(t)));
}

const NO_TESTING_COMMISSIONED_RE = /^(none needed|n\/a)$/i;

async function main() {
  const client = getS3Client();
  const bucket = getBucket();

  log(`Listing raw PDFs under s3://${bucket}/${EFFICACY_PREFIX}raw/ ...`);
  const rawPdfKeys = await listAllRawPdfKeys(client, bucket);
  log(`Found ${rawPdfKeys.length} raw PDF(s).`);
  const parsedPdfs = rawPdfKeys.map(parseRawPdfKey);

  log(`Downloading ${XLSX_KEY} ...`);
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: XLSX_KEY }));
  const buf = await streamToBuffer(res.Body);
  const localTmp = join(mkdtempSync(join(tmpdir(), 'efficacy-xlsx-')), 'master-efficacy.xlsx');
  writeFileSync(localTmp, buf);

  const workbook = XLSX.readFile(localTmp);
  const masterRows = parseMasterVersionTable(workbook);
  const currentEfficacyByFormula = parseCurrentVersionEfficacy(workbook);
  log(`Parsed ${masterRows.length} Master Version Table row(s), ${currentEfficacyByFormula.size} Current Version Efficacy formula group(s).`);

  // Finds every PDF anywhere in the corpus whose normalized project tokens
  // intersect the given set — used to explain "not found in matched PDFs"
  // cases (same formula/different version, or a different formula entirely
  // sharing one combined lab panel — e.g. project A32791 covers M000795,
  // M000796, and MCA0795 in one submitted report).
  function findPdfsByProjectToken(tokenNorm) {
    return parsedPdfs.filter((p) => p.projectTokensNorm.includes(tokenNorm));
  }

  const matchedPdfKeys = new Set();
  const outputRows = masterRows.map((row) => {
    const formulaPdfs = parsedPdfs.filter(
      (p) => p.formulaCode.toUpperCase() === (row.formula_code ?? '').toUpperCase() && !p.isUnusedFolder,
    );
    const rowProjectTokens = extractProjectTokens(row.project_number);
    const rowProjectTokensNorm = rowProjectTokens.map(normalizeProjectToken);
    const flags = [];

    // Primary match: same formula, same base version number ("4a"/"4b"/"4c"
    // all match sheet version "4").
    let matchedPdfs = formulaPdfs.filter((p) => p.baseVersion === row.version);
    let matchStrategy = 'formula+version';

    // Fallback: some folders (e.g. M000797's "Skin Care Efficacy <project>
    // 797 <organism>.pdf") never put a "Version N" token in the filename at
    // all. When the version-based match is empty, fall back to matching by
    // project-number token within the same formula folder.
    if (matchedPdfs.length === 0 && rowProjectTokensNorm.length > 0) {
      const sameFormulaByProject = formulaPdfs.filter((p) =>
        p.projectTokensNorm.some((t) => rowProjectTokensNorm.includes(t)),
      );
      if (sameFormulaByProject.length > 0) {
        matchedPdfs = sameFormulaByProject;
        matchStrategy = 'formula+project_number(no_version_token_in_filename)';
      }
    }

    matchedPdfs.forEach((p) => matchedPdfKeys.add(p.key));

    if (matchedPdfs.length === 0) {
      const projectRaw = (row.project_number ?? '').trim();
      if (!projectRaw || NO_TESTING_COMMISSIONED_RE.test(projectRaw)) {
        flags.push(
          'NO_TESTING_COMMISSIONED: sheet lists no lab/project for this version (e.g. "None Needed"/"N/A"/blank) — no PDF expected, not a data gap',
        );
      } else {
        // Last resort: does this project number show up ANYWHERE in the
        // corpus (possibly under a different formula's folder — a shared
        // multi-formula lab panel)?
        const crossFormulaHits = rowProjectTokensNorm.flatMap((t) => findPdfsByProjectToken(t));
        if (crossFormulaHits.length > 0) {
          const otherFormulas = [...new Set(crossFormulaHits.map((p) => p.formulaCode))];
          matchedPdfs = crossFormulaHits;
          matchedPdfs.forEach((p) => matchedPdfKeys.add(p.key));
          matchStrategy = 'cross_formula_shared_project';
          flags.push(
            `CROSS_FORMULA_SHARED_REPORT: project number "${projectRaw}" is not filed under ${row.formula_code}'s own folder — it is filed under ${otherFormulas.join(
              ', ',
            )}'s folder instead (shared/combined lab panel) — verify the shared report actually covers ${row.formula_code}`,
          );
        } else {
          flags.push(
            `NO_PDF_MATCH: sheet lists a real lab/project ("${row.third_party_lab ?? ''}" / "${projectRaw}") for this version but no raw PDF filename matched it anywhere in the corpus — real gap, needs review`,
          );
        }
      }
    }

    const distinctRawVersionTokens = [...new Set(matchedPdfs.map((p) => p.rawVersionToken).filter(Boolean))];
    if (distinctRawVersionTokens.length > 1) {
      flags.push(
        `MULTIPLE_SUB_VERSIONS: raw PDFs distinguish sub-versions ${distinctRawVersionTokens
          .map((v) => `"${v}"`)
          .join(', ')} that this single Master-sheet row ("${row.version}") does not differentiate — review individually`,
      );
    }

    if (rowProjectTokens.length > 0 && matchedPdfs.length > 0) {
      const pdfProjectTokensNorm = new Set(matchedPdfs.flatMap((p) => p.projectTokensNorm));
      const unmatchedRowTokens = rowProjectTokens.filter(
        (t, i) => !pdfProjectTokensNorm.has(rowProjectTokensNorm[i]),
      );
      for (const unmatchedToken of unmatchedRowTokens) {
        const tokenNorm = normalizeProjectToken(unmatchedToken);
        const elsewhere = findPdfsByProjectToken(tokenNorm).filter((p) => !matchedPdfKeys.has(p.key) || !matchedPdfs.includes(p));
        if (elsewhere.length > 0) {
          const locations = [...new Set(elsewhere.map((p) => `${p.formulaCode} "${p.fileName}"`))];
          flags.push(
            `PROJECT_NUMBER_FILED_ELSEWHERE: sheet lists project token "${unmatchedToken}" for ${row.formula_code} v${row.version}, but that project number is only found in filename(s): ${locations.join(
              '; ',
            )} — sheet text may be misattributed to this version`,
          );
        } else {
          flags.push(
            `PROJECT_NUMBER_NOT_FOUND_ANYWHERE: sheet lists project token "${unmatchedToken}" for ${row.formula_code} v${row.version}, not present in any raw PDF filename in the corpus — verify manually, do not assume it matches`,
          );
        }
      }
    }

    const currentEfficacy = row.is_current ? currentEfficacyByFormula.get(row.formula_code) : undefined;

    return {
      formula_code: row.formula_code,
      version: row.version,
      third_party_lab: row.third_party_lab,
      project_number: row.project_number,
      date_changed: row.date_changed,
      is_current: row.is_current,
      description_of_change: row.description_of_change,
      status: classifyStatus(row),
      organisms_tested_source: currentEfficacy
        ? 'current_version_efficacy_sheet'
        : matchedPdfs.some((p) => p.organismTokens.length > 0)
          ? 'pdf_filename_abbrev'
          : 'none_found',
      organisms_tested: currentEfficacy
        ? currentEfficacy.organisms.map((o) => o.organism).join('; ')
        : [...new Set(matchedPdfs.flatMap((p) => p.organismTokens))].join('; ') || null,
      current_version_efficacy_detail: currentEfficacy
        ? JSON.stringify(currentEfficacy.organisms)
        : null,
      cites_earlier_version_data: currentEfficacy?.cites_earlier_version_data ?? null,
      source_pdf_filename: matchedPdfs.map((p) => p.key).join('; ') || null,
      pdf_match_count: matchedPdfs.length,
      pdf_match_strategy: matchedPdfs.length > 0 ? matchStrategy : null,
      product_sku: '', // populated by a different epic later
      flags: flags.join(' | ') || null,
      sheet_source: 'master_version_table',
    };
  });

  // Reverse lookup: which formula+version did each *matched* project token
  // end up attributed to? Lets orphan PDFs explain themselves when they
  // share a project number with a report some other row already claims
  // (e.g. M000752's "Version NA" PDFs carry project numbers A29692/A29693/
  // A29694 — the same numbers M000141 v4 cites and matches its own files
  // with) instead of just saying "unmatched".
  const matchedTokenOwners = new Map(); // tokenNorm -> [{formula, version}]
  outputRows.forEach((row) => {
    if (!row.source_pdf_filename) return;
    const pdfsForRow = row.source_pdf_filename
      .split('; ')
      .map((key) => parsedPdfs.find((p) => p.key === key))
      .filter(Boolean);
    for (const p of pdfsForRow) {
      for (const t of p.projectTokensNorm) {
        if (!matchedTokenOwners.has(t)) matchedTokenOwners.set(t, []);
        matchedTokenOwners
          .get(t)
          .push({ formula: row.formula_code, version: row.version, isCurrent: row.is_current });
      }
    }
  });

  // Rows for raw PDFs that never matched ANY master-sheet row (e.g. the
  // "Unused Formulas Efficacy" / "Version UA" sub-folder, "Version NA"
  // stragglers, and any other orphan report).
  const orphanPdfRows = parsedPdfs
    .filter((p) => !matchedPdfKeys.has(p.key))
    .map((p) => {
      const sharedOwners = [
        ...new Map(
          p.projectTokensNorm
            .flatMap((t) => matchedTokenOwners.get(t) ?? [])
            .filter((owner) => owner.formula !== p.formulaCode)
            .map((owner) => [`${owner.formula} v${owner.version}`, owner]),
        ).values(),
      ];
      const sharedWith = sharedOwners.map((owner) => `${owner.formula} v${owner.version}`);
      const sharesCurrentData = sharedOwners.some((owner) => owner.isCurrent);
      const baseDescription = p.isUnusedFolder
        ? 'No Master Version Table row — PDF lives under "Unused Formulas Efficacy" subfolder'
        : 'No Master Version Table row — PDF version token did not match any sheet row';
      const description =
        sharedWith.length > 0
          ? `${baseDescription}. Its project number(s) (${p.projectTokens.join(
              ', ',
            )}) are the same ones the Master Version Table already attributes to ${sharedWith.join(
              ', ',
            )} — likely a combined/shared lab panel filed redundantly under this formula's folder too, not a distinct untracked test.${
              sharesCurrentData
                ? ' NOTE: at least one of those rows is the CURRENT version — this report is live supporting data, not "unused".'
                : ''
            } Verify against PDF content before assuming equivalence.`
          : baseDescription;
      return {
        formula_code: p.formulaCode,
        version: p.rawVersionToken,
        third_party_lab: null,
        project_number: p.projectTokens.join('; ') || null,
        date_changed: null,
        is_current: sharesCurrentData,
        description_of_change: description,
        status: sharesCurrentData ? 'active' : 'unused',
        organisms_tested_source: p.organismTokens.length > 0 ? 'pdf_filename_abbrev' : 'none_found',
        organisms_tested: p.organismTokens.join('; ') || null,
        current_version_efficacy_detail: null,
        cites_earlier_version_data: null,
        source_pdf_filename: p.key,
        pdf_match_count: 1,
        pdf_match_strategy: null,
        product_sku: '',
        flags: [
          p.hasParsedVersion
            ? 'ORPHAN_PDF: no Master Version Table row references this formula+version'
            : `ORPHAN_PDF_UNPARSEABLE_FILENAME: filename does not contain a "Version <n>" token at all ("${p.fileName}") — needs manual review, not guessed`,
          sharedWith.length > 0
            ? `SHARES_PROJECT_NUMBER_WITH: ${sharedWith.join(', ')}`
            : null,
          sharesCurrentData
            ? 'ACTIVE_SUPPORTING_DATA: this report backs a CURRENT formula version elsewhere — classified active, not unused'
            : null,
        ]
          .filter(Boolean)
          .join(' | '),
        sheet_source: 'inferred_from_orphan_pdf',
      };
    });

  const allRows = [...outputRows, ...orphanPdfRows];

  const summary = {
    generated_at: new Date().toISOString(),
    source_xlsx_key: XLSX_KEY,
    master_version_table_rows: masterRows.length,
    current_version_efficacy_formula_groups: currentEfficacyByFormula.size,
    raw_pdf_count: rawPdfKeys.length,
    rows_with_flags: allRows.filter((r) => r.flags).length,
    orphan_pdfs: orphanPdfRows.length,
  };

  log(`Summary: ${JSON.stringify(summary, null, 2)}`);

  if (DRY_RUN) {
    log('--dry-run set: not writing output files.');
    return;
  }

  writeFileSync(OUT_JSON, JSON.stringify({ summary, rows: allRows }, null, 2));
  log(`Wrote ${OUT_JSON}`);

  const csvColumns = [
    'formula_code',
    'version',
    'third_party_lab',
    'project_number',
    'date_changed',
    'is_current',
    'description_of_change',
    'status',
    'organisms_tested',
    'organisms_tested_source',
    'cites_earlier_version_data',
    'source_pdf_filename',
    'pdf_match_count',
    'pdf_match_strategy',
    'product_sku',
    'flags',
    'sheet_source',
  ];
  const csvEscape = (val) => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };
  const csvLines = [
    csvColumns.join(','),
    ...allRows.map((row) => csvColumns.map((col) => csvEscape(row[col])).join(',')),
  ];
  writeFileSync(OUT_CSV, csvLines.join('\n') + '\n');
  log(`Wrote ${OUT_CSV}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
