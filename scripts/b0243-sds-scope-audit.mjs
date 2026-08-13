/**
 * B0-243 — Read-only audit of the already-embedded SDS corpus (`rag.document` where
 * `document_kind = 'sds'`) against the scope policy in
 * `src/app/(authenticated)/admin/sds/policy.ts`.
 *
 * This does NOT modify any data. It reproduces the ticket's own filename-based
 * in-scope/out-of-scope split against LIVE data, then goes further: it re-checks
 * every document's *actual* extracted PDF text (already stored in `body_text` from
 * ingestion) with a real content-based language detector (`franc`), because the
 * ticket's own acceptance criteria call out that the filename-only figure risks
 * false negatives. It does — see `docsWithConfirmedLanguageMismatch` below.
 *
 * Output: src/lib/training/sds-scope-audit-report.json — a candidate list for the
 * eventual purge step (B0-243's step 2), NOT an instruction to purge. Deactivating
 * or deleting any of these rows is a separate, explicitly-confirmed action.
 *
 * Usage:
 *   node --env-file=.env.local scripts/b0243-sds-scope-audit.mjs
 *
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import { writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { createClient } from '@supabase/supabase-js';
import { franc } from 'franc-min';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '..');
const OUT_JSON = join(REPO_ROOT, 'src/lib/training/sds-scope-audit-report.json');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Run with --env-file=.env.local.',
  );
}

// Mirrors src/app/(authenticated)/admin/sds/policy.ts defaults exactly. Kept as a
// plain copy here (not imported) so this script has zero dependency on Next.js
// module resolution / the app's TS path aliases and can run standalone.
const INCLUDE_PREFIXES = ['betco sds/'];
const EXCLUDE_KEYWORDS = [
  'raw material',
  'private label',
  'intermediate',
  'premix',
  'basic sds',
  'prop 65',
  'envirozyme',
  '1950 sds',
  'battery',
  'wastewater',
  'experimental',
  'spanish',
  'french canadian',
  'mexican form sds',
];
const ALLOWED_LOCALES = ['EN', 'CAN'];
const FRANC_TO_LOCALE = { eng: 'EN', fra: 'FR', spa: 'ES' };

function classifyByPath(s3Key, languageCode) {
  const path = (s3Key || '').toLowerCase();
  if (!INCLUDE_PREFIXES.some((p) => path.startsWith(p))) {
    return { inScope: false, reason: 'not_in_include_prefix' };
  }
  const matchedKeyword = EXCLUDE_KEYWORDS.find((k) => path.includes(k));
  if (matchedKeyword) {
    return { inScope: false, reason: `exclude_keyword:${matchedKeyword}` };
  }
  const locale = (languageCode || 'EN').toUpperCase();
  if (!ALLOWED_LOCALES.includes(locale)) {
    return { inScope: false, reason: `excluded_locale:${locale}` };
  }
  return { inScope: true };
}

async function fetchAllSdsDocuments(supabase) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  for (;;) {
    const { data, error } = await supabase
      .schema('rag')
      .from('document')
      .select('id, source_record_id, title, language_code, metadata, body_text')
      .eq('document_kind', 'sds')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Fetch failed: ${error.message}`);
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { db: { schema: 'rag' } });
  const rows = await fetchAllSdsDocuments(supabase);

  const inScopeRows = [];
  const outOfScopeByPath = [];
  const excludedByReason = {};

  for (const row of rows) {
    const s3Key = row.metadata?.s3_key;
    const decision = classifyByPath(s3Key, row.language_code);
    if (decision.inScope) {
      inScopeRows.push(row);
    } else {
      outOfScopeByPath.push({ ...row, reason: decision.reason });
      excludedByReason[decision.reason] = (excludedByReason[decision.reason] ?? 0) + 1;
    }
  }

  // Authoritative content-based check on the path-classified "in scope" set: does
  // real extracted text actually look like French/Spanish despite an EN/CAN tag?
  const docsWithConfirmedLanguageMismatch = [];
  let inconclusiveCount = 0;
  for (const row of inScopeRows) {
    const text = row.body_text || '';
    if (!text.trim()) continue;
    const francCode = franc(text, { minLength: 20 });
    if (francCode === 'und') {
      inconclusiveCount += 1;
      continue;
    }
    const detected = FRANC_TO_LOCALE[francCode] ?? null;
    const expected = (row.language_code || 'EN').toUpperCase();
    if (detected && detected !== expected && (detected === 'FR' || detected === 'ES')) {
      docsWithConfirmedLanguageMismatch.push({
        documentId: row.id,
        sourceRecordId: row.source_record_id,
        title: row.title,
        s3Key: row.metadata?.s3_key ?? null,
        recordedLocale: expected,
        detectedLocale: detected,
        francCode,
      });
    }
  }

  const purgeCandidates = [
    ...outOfScopeByPath.map((r) => ({
      documentId: r.id,
      sourceRecordId: r.source_record_id,
      title: r.title,
      s3Key: r.metadata?.s3_key ?? null,
      recordedLocale: (r.language_code || 'EN').toUpperCase(),
      reason: r.reason,
    })),
    ...docsWithConfirmedLanguageMismatch.map((m) => ({
      documentId: m.documentId,
      sourceRecordId: m.sourceRecordId,
      title: m.title,
      s3Key: m.s3Key,
      recordedLocale: m.recordedLocale,
      reason: `content_language_mismatch:${m.detectedLocale}`,
    })),
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    totalSdsDocuments: rows.length,
    pathClassification: {
      inScope: inScopeRows.length,
      outOfScope: outOfScopeByPath.length,
      excludedByReason,
    },
    contentLanguageValidation: {
      checked: inScopeRows.length,
      inconclusive: inconclusiveCount,
      confirmedMismatches: docsWithConfirmedLanguageMismatch.length,
      note:
        'Documents in this list are path-classified as in-scope (EN/CAN, Betco SDS/, no ' +
        'exclude keyword) but their actual extracted PDF text detects as French or ' +
        'Spanish. This is the false-negative gap the ticket warned about -- filename/' +
        'folder heuristics alone would have kept these in the corpus.',
      docs: docsWithConfirmedLanguageMismatch,
    },
    purgeCandidateCount: purgeCandidates.length,
    purgeCandidateNote:
      'This list is a CANDIDATE set for the destructive step (deactivate/delete out-of-' +
      'policy source_record + document rows). Generating this report performs no writes. ' +
      'Do not act on it without explicit, separate confirmation.',
    purgeCandidates,
  };

  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n');

  console.log('Total SDS documents:', rows.length);
  console.log('In-scope (path classification):', inScopeRows.length);
  console.log('Out-of-scope (path classification):', outOfScopeByPath.length);
  console.log('Confirmed content-language mismatches (false negatives in the "keep" set):', docsWithConfirmedLanguageMismatch.length);
  console.log('Total purge candidates (path-excluded + content-mismatch):', purgeCandidates.length);
  console.log('Report written to', OUT_JSON);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
