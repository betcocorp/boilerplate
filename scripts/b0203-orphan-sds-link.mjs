/**
 * B0-203 — Link orphan SDS documents (`rag.document` where `document_kind = 'sds'`
 * and `entity_id is null`) to their `rag.entity` product-line row.
 *
 * Re-runnable and idempotent: it only ever sets `entity_id` on rows that are still
 * NULL, so a second run after a successful apply matches nothing new and writes
 * nothing. Dry-run is the default; `--apply` is required to write.
 *
 * WHY THIS IS DELIBERATELY CONSERVATIVE
 * -------------------------------------
 * An SDS carries EPA/GHS-regulated safety data. A wrong link means Bex answers a
 * safety question from the wrong product's sheet, which is strictly worse than
 * answering "no source found". So every strategy below must resolve to exactly ONE
 * product-line entity; anything that resolves to zero or to more than one is left
 * unlinked and reported with a reason. Nothing is inferred, rounded or guessed.
 *
 * SCOPE GATES (applied before any strategy runs)
 * ----------------------------------------------
 *  1. Path policy — mirrors `src/app/(authenticated)/admin/sds/policy.ts`
 *     (`Betco SDS/` prefix, exclusion keywords, EN/CAN locales only).
 *  2. Content language — `franc` over the document's real extracted `body_text`.
 *     policy.ts names this the *authoritative* gate, because the path policy has a
 *     known false-negative class: French and Spanish SDS filed as `<code>FR.pdf` /
 *     `<code>SP.pdf` inside `Betco SDS/Chemtrec SDS files ready to transfer/` and
 *     `Betco SDS/Archive SDS/`, recorded with `language_code = 'EN'`. Those are the
 *     single largest group of orphans and they must NOT be linked: their base code
 *     usually does resolve to a real product line, so a naive "strip the FR/SP
 *     suffix" backfill would attach French/Spanish safety text to an English
 *     product line. This gate is intentionally slightly stricter than policy.ts:
 *     policy.ts only flags FR/ES, this also declines any other confidently detected
 *     non-English language (e.g. the Italian `GTS305EU_IT` document).
 *
 * MATCH STRATEGIES, most confident first (first hit wins)
 * ------------------------------------------------------
 *  1. `code_exact`     — the Betco product code taken from the source filename stem
 *                        equals `rag.entity.metadata->>'prod_line_id'` exactly.
 *                        `prod_line_id` is unique across the 1,703 product_line
 *                        entities, so this can never be ambiguous.
 *  2. `sds_number`     — a product-tier entity (`entity_type = 'product'`, seeded
 *                        from label ingestion) carries `metadata->>'sds_number'`
 *                        equal to that code, its `product_line_key` resolves to
 *                        exactly one product_line entity, AND the GHS product
 *                        identifier on the sheet equals that product's (or its
 *                        line's) title. The name check is not optional: a product
 *                        line's title is often a generic descriptor while the sheet
 *                        carries the marketing name (588 "Super Concentrated
 *                        Industrial Degreaser" vs. SKU SP58864 "Green Earth
 *                        Degreaser MB"), so without it there is nothing to
 *                        distinguish a correct link from a coincidental one.
 *                        Product entities whose own line link was made by the
 *                        `sds_number_heuristic` and left `link_needs_review = true`
 *                        are excluded outright — an unreviewed guess is not a
 *                        foundation to hang regulated safety data on.
 *  3. `ghs_title`      — the GHS product identifier parsed out of SDS section 1
 *                        uniquely equals a product_line title, AND the digits in the
 *                        filename code corroborate the digits in that line's
 *                        `prod_line_id` (e.g. SP0559 -> 559, WTP333 -> E333). The
 *                        corroboration requirement is what makes a name match safe;
 *                        an uncorroborated name match is reported for review, never
 *                        linked.
 *
 * Usage:
 *   node --env-file=.env.local scripts/b0203-orphan-sds-link.mjs            # dry run
 *   node --env-file=.env.local scripts/b0203-orphan-sds-link.mjs --apply    # write
 *   ... --sample 20        how many example matches to print per strategy (default 8)
 *   ... --report out.json  also write the full classification to a JSON file
 *
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import { writeFileSync } from 'fs';

import { createClient } from '@supabase/supabase-js';
import { franc } from 'franc-min';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Run with --env-file=.env.local.',
  );
}

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const SAMPLE_SIZE = readNumberFlag('--sample', 8);
const REPORT_PATH = readStringFlag('--report', null);

function readStringFlag(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function readNumberFlag(flag, fallback) {
  const raw = readStringFlag(flag, null);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// --- scope policy (mirrors src/app/(authenticated)/admin/sds/policy.ts defaults) ---

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

function classifyByPath(s3Key, languageCode) {
  const path = (s3Key || '').toLowerCase();
  if (!INCLUDE_PREFIXES.some((p) => path.startsWith(p))) {
    return { inScope: false, reason: 'out_of_scope_path:not_in_include_prefix' };
  }
  const kw = EXCLUDE_KEYWORDS.find((k) => path.includes(k));
  if (kw) return { inScope: false, reason: `out_of_scope_path:${kw}` };
  const locale = (languageCode || 'EN').toUpperCase();
  if (!ALLOWED_LOCALES.includes(locale)) {
    return { inScope: false, reason: `out_of_scope_path:locale_${locale}` };
  }
  return { inScope: true };
}

/**
 * Content-language gate over real extracted text. `und` (short or garbled OCR) is
 * never treated as a mismatch -- per org policy unreadable data is surfaced, not
 * guessed -- but it is also never linked, because we cannot prove it is English.
 */
function classifyByContentLanguage(bodyText) {
  const text = (bodyText || '').trim();
  if (!text) return { ok: false, reason: 'content_language:no_body_text' };
  const code = franc(text, { minLength: 20 });
  if (code === 'und') return { ok: false, reason: 'content_language:undetermined' };
  if (code !== 'eng') return { ok: false, reason: `content_language:${code}` };
  return { ok: true };
}

// --- filename / code parsing ---

function fileStem(s3Key) {
  const parts = String(s3Key || '').split('/');
  const file = parts[parts.length - 1] || '';
  return file.replace(/\.pdf$/i, '').trim().toUpperCase();
}

/**
 * Strip the archival/duplicate bookkeeping suffixes Betco appends to SDS filenames
 * ("133 ARCHIVE", "795SP (2)") and the trailing CAN locale marker, leaving the
 * product code. Language markers (FR/SP) are deliberately NOT stripped: a document
 * carrying one is a foreign-language sheet and is declined by the content gate
 * above, not silently folded into its English sibling.
 */
function fileCode(s3Key) {
  let base = fileStem(s3Key);
  base = base.replace(/\s*\(\d+\)\s*$/, '');
  base = base.replace(/\s*ARCHIVE\s*$/, '');
  base = base.replace(/[\s_]*CAN$/, '');
  return base.trim();
}

/** Digits of a code with leading zeros dropped, used only to corroborate a name match. */
function digitCore(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.replace(/^0+/, '');
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The GHS product identifier is the first field of SDS section 1 and, in this
 * corpus, the very start of the extracted text. Everything after the first
 * boilerplate marker ("Not available", "Chemtrec", "SAFETY DATA SHEET") is header
 * furniture, not the name.
 */
function parseGhsProductName(bodyText) {
  const head = String(bodyText || '')
    .slice(0, 400)
    .replace(/\s+/g, ' ')
    .trim();
  if (!head) return null;
  const cut = head.split(
    /\s(?:Not available|Chemtrec|SAFETY DATA SHEET|Section 1|GHS product identifier)/i,
  )[0];
  const name = (cut || '').trim();
  if (name.length < 3 || name.length > 90) return null;
  return name;
}

// --- data loading (PostgREST caps a page at 1000 rows) ---

async function fetchAllPaged(query, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { db: { schema: 'rag' } });
  const rag = () => supabase.schema('rag');

  console.log(`B0-203 orphan SDS backfill — mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN'}`);

  const entities = await fetchAllPaged(
    rag().from('entity').select('id, entity_type, title, product_line_key, metadata'),
  );
  const productLines = entities.filter((e) => e.entity_type === 'product_line');
  const products = entities.filter((e) => e.entity_type === 'product');

  const byCode = new Map();
  const byTitle = new Map();
  const byLineKey = new Map();
  for (const e of productLines) {
    const code = String(e.metadata?.prod_line_id ?? '').trim().toUpperCase();
    if (code) pushIndex(byCode, code, e);
    const title = normalizeTitle(e.title);
    if (title) pushIndex(byTitle, title, e);
    if (e.product_line_key) pushIndex(byLineKey, String(e.product_line_key).toUpperCase(), e);
  }

  // Product-tier entities carry the SDS number the sheet was filed under. Skip any
  // whose own product-line link was an unreviewed `sds_number_heuristic` guess.
  const bySdsNumber = new Map();
  let heuristicSkipped = 0;
  for (const p of products) {
    const sds = String(p.metadata?.sds_number ?? '').trim().toUpperCase();
    if (!sds || !p.product_line_key) continue;
    if (p.metadata?.link_needs_review === true) {
      heuristicSkipped += 1;
      continue;
    }
    const lines = byLineKey.get(String(p.product_line_key).toUpperCase()) ?? [];
    for (const line of lines) pushIndex(bySdsNumber, sds, { product: p, line });
  }

  const orphans = await fetchAllPaged(
    rag()
      .from('document')
      .select('id, title, language_code, metadata, body_text')
      .eq('document_kind', 'sds')
      .is('entity_id', null),
  );

  console.log(
    `product_line entities: ${productLines.length}  product entities: ${products.length}  orphan SDS: ${orphans.length}`,
  );
  console.log(
    `product entities excluded from sds_number index (unreviewed heuristic line link): ${heuristicSkipped}`,
  );

  const matches = [];
  const skipped = [];

  for (const doc of orphans) {
    const s3Key = doc.metadata?.s3_key ?? null;
    const record = { documentId: doc.id, title: doc.title, s3Key };

    const pathDecision = classifyByPath(s3Key, doc.language_code);
    if (!pathDecision.inScope) {
      skipped.push({ ...record, reason: pathDecision.reason, inScopeByPath: false });
      continue;
    }

    const langDecision = classifyByContentLanguage(doc.body_text);
    if (!langDecision.ok) {
      skipped.push({ ...record, reason: langDecision.reason, inScopeByPath: true });
      continue;
    }

    const code = fileCode(s3Key);
    const resolved = resolve(code, doc, { byCode, bySdsNumber, byTitle });
    if (resolved.entity) {
      matches.push({
        ...record,
        code,
        strategy: resolved.strategy,
        entityId: resolved.entity.id,
        entityCode: resolved.entity.metadata?.prod_line_id ?? null,
        entityTitle: resolved.entity.title,
      });
    } else {
      skipped.push({ ...record, code, reason: resolved.reason, inScopeByPath: true });
    }
  }

  report(matches, skipped, orphans.length);

  if (REPORT_PATH) {
    writeFileSync(
      REPORT_PATH,
      JSON.stringify({ generatedAt: new Date().toISOString(), matches, skipped }, null, 2) + '\n',
    );
    console.log(`\nFull classification written to ${REPORT_PATH}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply once the samples look correct.');
    return;
  }

  let linked = 0;
  for (const m of matches) {
    // `.is('entity_id', null)` keeps this idempotent and makes a concurrent linker win
    // rather than being overwritten.
    const { data, error } = await rag()
      .from('document')
      .update({ entity_id: m.entityId })
      .eq('id', m.documentId)
      .is('entity_id', null)
      .select('id');
    if (error) throw new Error(`Link failed for ${m.documentId}: ${error.message}`);
    linked += data.length;
  }
  console.log(`\nAPPLIED — documents linked: ${linked} (of ${matches.length} matched).`);
}

function pushIndex(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Returns the single unambiguous product-line entity for a document, or a decline reason. */
function resolve(code, doc, idx) {
  if (!code) return { entity: null, reason: 'no_candidate:unparsable_filename' };

  const exact = idx.byCode.get(code) ?? [];
  if (exact.length === 1) return { entity: exact[0], strategy: 'code_exact' };
  if (exact.length > 1) return { entity: null, reason: 'ambiguous:code_exact' };

  const name = parseGhsProductName(doc.body_text);

  const bySds = idx.bySdsNumber.get(code) ?? [];
  if (bySds.length > 1) return { entity: null, reason: 'ambiguous:sds_number' };
  if (bySds.length === 1) {
    const { product, line } = bySds[0];
    const sheetName = normalizeTitle(name);
    // The sheet must name either the SKU or the line; otherwise we cannot tell a
    // correct link from a coincidence of SDS numbering.
    if (
      sheetName &&
      (sheetName === normalizeTitle(product.title) || sheetName === normalizeTitle(line.title))
    ) {
      return { entity: line, strategy: 'sds_number' };
    }
    return { entity: null, reason: 'review:sds_number_uncorroborated' };
  }

  if (name) {
    const byName = idx.byTitle.get(normalizeTitle(name)) ?? [];
    if (byName.length > 1) return { entity: null, reason: 'ambiguous:ghs_title' };
    if (byName.length === 1) {
      const candidate = byName[0];
      const docDigits = digitCore(code);
      const entityDigits = digitCore(candidate.metadata?.prod_line_id);
      if (docDigits && entityDigits && docDigits === entityDigits) {
        return { entity: candidate, strategy: 'ghs_title' };
      }
      return { entity: null, reason: 'review:ghs_title_uncorroborated' };
    }
  }

  return { entity: null, reason: 'no_candidate:no_product_line_for_code' };
}

function report(matches, skipped, orphanTotal) {
  const inScope = matches.length + skipped.filter((s) => s.inScopeByPath).length;
  console.log(`\n--- Classification of ${orphanTotal} orphan SDS documents ---`);
  console.log(`in scope by path policy: ${inScope}`);
  console.log(`matched (linkable):      ${matches.length}`);

  console.log('\nMatches by strategy:');
  for (const [strategy, list] of groupBy(matches, (m) => m.strategy)) {
    console.log(`  ${strategy}: ${list.length}`);
    for (const m of list.slice(0, SAMPLE_SIZE)) {
      console.log(`      ${m.code}  ->  [${m.entityCode}] ${m.entityTitle}   (${m.s3Key})`);
    }
    if (list.length > SAMPLE_SIZE) console.log(`      ... and ${list.length - SAMPLE_SIZE} more`);
  }
  if (matches.length === 0) console.log('  (none)');

  console.log('\nUnlinked by reason:');
  const groups = [...groupBy(skipped, (s) => s.reason)].sort((a, b) => b[1].length - a[1].length);
  for (const [reason, list] of groups) {
    console.log(`  ${reason}: ${list.length}`);
    if (reason.startsWith('content_language') || reason.startsWith('ambiguous') || reason.startsWith('review')) {
      for (const s of list.slice(0, Math.min(SAMPLE_SIZE, 5))) console.log(`      ${s.s3Key}`);
    }
  }
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) pushIndex(map, keyFn(row), row);
  return map;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
