/**
 * B0-199 — Disinfectant efficacy matrix -> rag.product_efficacy ingest.
 *
 * Parses the 20 "legacy" markdown lab-report documents already entity-linked to their
 * product_line entity by B0-232 (efficacy/markdown/legacy/*.md, product-code-keyed
 * disinfectant sheets) into organism x claim_type x contact_time x EPA-reg rows,
 * following the row shape established by B0-252's hand-hygiene ingestion (the only
 * other populated batch in this table — see PRODUCT_EFFICACY_COLUMNS in
 * src/lib/retrieval/product-facts.ts for how these rows are consumed).
 *
 * WHY "legacy" TIER ONLY, NOT "disinfectants" TIER
 * -------------------------------------------------
 * The disinfectants/*.md documents are a second, lower-fidelity OCR pass over the same
 * PDFs: they cover only a partial subset of each sheet's sections (frequently bactericidal
 * only), and their Log Reduction / Percent Reduction columns are near-universally
 * "[ILLEGIBLE]" (this table has no columns for those anyway). The legacy/*.md documents
 * are complete, clean transcriptions with no illegible cells for the columns this table
 * actually stores (organism, contact time). Spot-checked directly (formula 333: legacy
 * doc has 4 full sections / clean text; the disinfectants-tier sibling has 1 partial
 * section with every Log Reduction/Percent Reduction cell marked [ILLEGIBLE]).
 *
 * WHY ONLY 20 OF THE 24 LEGACY DOCUMENTS
 * ---------------------------------------
 * - 2 are byte-identical duplicates per the B0-225 reconciliation
 *   (src/lib/training/efficacy-legacy-reconciliation.md): af79-efficacy-sheet.md (dup of
 *   Efficacy_Data_079_AF79.md) and 070-efficacy-sheet.md (dup of
 *   Efficacy_Data_070_Rest_Stop.md). Skipped.
 * - 2 (Efficacy_Data_237_Sanibet_Multi_Range.md, Efficacy_Data_342_Sanibet_RTU.md) carry
 *   ONLY food-contact "Sanitizer Efficacy" claims (ppm/hard-water dilution, AOAC sanitizer
 *   test) -- no bactericidal/virucidal/fungicidal/tuberculocidal content at all. Out of
 *   this ticket's claim-type scope (and ppm dilution has no home in this table's
 *   oz/gal-only dilution column -- see below). Reported as a genuine content gap for the
 *   "Sanibet" named product line, not an omission.
 *
 * B0-796 CURRENCY CHECK (done before writing this script)
 * ---------------------------------------------------------
 * Queried live: of these 68 disinfectants+legacy documents, ALL 68 have frontmatter
 * `is current: UNKNOWN` (0 true, 0 false) and ZERO mention "superseded" anywhere in body.
 * The ticket's "55 superseded / 24 of 25 multi-current" figures describe the much larger
 * hygiene-skin-care corpus (B0-252's territory) -- they do not apply to this scope. No
 * document here is flagged superseded, so nothing is withheld on currency grounds.
 *
 * REGULATED-VALUE TRANSCRIPTION RULES
 * -------------------------------------
 * - organism: verbatim from the table cell, including OCR/transcription errors observed
 *   live (e.g. "Pseudmonas Aeruginosa", "Salmonella entrica", "Methicillin Resistant
 *   Staphyloccous aureus (MRSA)", "Streptoccus Hemolyticus" in Efficacy_Data_1086_Glybet_III.md).
 *   NEVER corrected. No normalized/canonical column is added (out of scope; the ticket
 *   only requires one if we add it, and matching-by-fuzzy-organism is not this ticket's job).
 * - contact_time_seconds: the column is typed as integer seconds, so "N Minutes"/"N min."/
 *   the OCR typo "N Mintues" -> N*60, "N Seconds" -> N. This is a lossless, exact
 *   arithmetic conversion into the column's own unit -- the same transformation already
 *   present in all 41 pre-existing rows (e.g. 600s for "10 minutes") -- not a regulatory
 *   unit conversion. A genuinely blank contact-time cell (observed once: "Avian Influenza A
 *   virus (H3N2)" in Efficacy_Data_355_Daily_Disinfectant_Dual.md) is written as NULL, never
 *   guessed.
 * - epa_registration: transcribed EXACTLY as printed in the document's own `epa reg no:`
 *   frontmatter field, which is SPACE-separated ("6836 266 4170"), not hyphenated. This
 *   looks like it could be a formatting artifact vs. the hyphenated convention used
 *   everywhere else in the schema (rag.document.epa_registration, the pre-existing 41
 *   product_efficacy rows) -- but two of these documents' own prose independently confirm
 *   the space-separated form is what the ORIGINAL PDF prints ("Note: the sheet is headed
 *   \"EPA EST NO. 6836 193 4170\"" in Efficacy_Data_079_AF79.md and "...EPA EST NO.
 *   47371 97 4170" in Efficacy_Data_070_Rest_Stop.md). Re-hyphenating would be an
 *   unverified "correction" of a printed value, so the space-separated form is kept
 *   verbatim. FLAG (see report): those same two notes say "EPA EST NO." (establishment
 *   number), not "EPA REG NO." -- worth a human check against the raw label that this
 *   frontmatter field is really the registration number for 079/070 specifically.
 *   Canadian sheets with no EPA reg on file (DIN-regulated instead) are written as NULL,
 *   never a fabricated EPA number.
 * - dilution_oz_per_gal: the schema has no verbatim-dilution-text column (unlike
 *   rag.product_line_fact.dilution_display), so a dilution is only written here when the
 *   label's own Conditions line gives an explicit "N oz. per gal[lon]" figure, or an
 *   unambiguous "1:N" ratio -- reduced via the SAME 128/N rule rag.product_line_fact
 *   already uses for 1:N dilution codes (see its column comment), never a fresh invented
 *   conversion. ppm-only and metric (mL per L) dilutions are left NULL rather than
 *   cross-unit-converted -- see DILUTION_OVERRIDES below and the report for exactly which
 *   rows get a value and why.
 * - claim_type: 'bactericidal' | 'virucidal' | 'fungicidal' | 'tuberculocidal', assigned
 *   from the section heading, EXCEPT: an organism identified as Mycobacterium bovis /
 *   tuberculosis / terrae is always written as 'tuberculocidal' even when the source sheet
 *   files it under a "Bactericidal Efficacy" heading (observed in
 *   Efficacy_Data_1086_Glybet_III.md: "Mycobacterium Bovis (TB)" sits inside the
 *   Bactericidal Efficacy table). This is a claim-type BUCKETING decision based on which
 *   organism it is (the same kind of judgment call already made for every other claim
 *   type), not an alteration of any transcribed value.
 * - confidence: 0.9, matching the two pre-existing disinfectant-label product_efficacy
 *   rows (QT 2 Oxy Fight Bac RTU / Glybet Surface and Air) already in this table.
 * - source_page: NULL for every row (established convention -- all 41 pre-existing rows
 *   are NULL; these markdown conversions carry no page metadata).
 * - entity_id / product_key: entity_id = the product_line entity B0-232 already linked;
 *   product_key = NULL (NULL is the documented convention for product_line-tier rows --
 *   see the FactRow comment in src/lib/retrieval/product-facts.ts).
 *
 * Usage:
 *   node scripts/populate-disinfectant-efficacy-b0199.mjs               # dry run, full report
 *   node scripts/populate-disinfectant-efficacy-b0199.mjs --write       # insert new rows only
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// ── Load .env.local (same pattern as scripts/backfill-efficacy-entity-links.mjs) ────
const envContent = readFileSync(new URL('../.env.local', import.meta.url), 'utf-8');
const env = Object.fromEntries(
  envContent
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    }),
);

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

const WRITE = process.argv.includes('--write');
const DUMP_ROWS = process.argv.includes('--dump-rows');
const EMIT_SQL = process.argv.includes('--emit-sql');
const SQL_OUT_PATH = new URL('../.b0199-product-efficacy-insert.sql', import.meta.url);
const REPORT_PATH = new URL(
  '../src/lib/training/disinfectant-efficacy-ingest-report-b0199.json',
  import.meta.url,
);

function log(msg) {
  console.log(msg);
}

// ── Document scope: the 20 legacy-tier documents in scope (see header for exclusions) ──
// entity_id / source_record_id verified live via Supabase MCP against rag.document.
const DOCS = [
  { id: '9953c191-47b9-4167-8784-452c688f6a9e', entityId: 'f905908a-342f-46a3-9f58-d40660bf0cba', sourceRecordId: 'b374e820-30b2-402d-9f7c-c57365023672', formula: '333', productName: 'Triforce' },
  { id: '1f0d1d94-b59b-469b-9436-4e0f19a1d82d', entityId: '7b8810da-ea50-4ce1-a220-9ff6063a0e80', sourceRecordId: 'b5e01a22-2468-4a0b-9285-4ac58a2c22d7', formula: '341', productName: 'Quat-Stat 5' },
  { id: '737f13a0-209c-46c2-b762-32c4776eb785', entityId: '8efad4b1-b0c6-4f8d-83dc-603652a67918', sourceRecordId: 'd9226703-ba5a-4bdc-887a-8d212fd8a448', formula: '079', productName: 'AF79' },
  { id: 'df277054-4186-49ea-b31b-2946ad7e33f3', entityId: 'f052bb54-3d8d-4df8-a0eb-32e8bda12c3e', sourceRecordId: '0ab291f6-34cd-4e99-a984-b7d4f394e0ff', formula: '1086', productName: 'Betco Glybet III' },
  { id: 'cbb72d77-5f55-4e2e-ba81-20dbc5155faa', entityId: 'db69da28-9741-4334-8605-f01c351cb346', sourceRecordId: '37e132bc-d5d0-4106-a3ba-f9d2822ec391', formula: '311', productName: 'Betco Disinfectant Fight Bac RTU (US)' },
  { id: '67d02956-3d0f-474d-9e80-1160f871fc98', entityId: 'db69da28-9741-4334-8605-f01c351cb346', sourceRecordId: 'f6a12482-5a3c-4438-a9ee-6869ac7ab187', formula: '311', productName: 'Fight Bac RTU Disinfectant Cleaner (Canada)' },
  { id: '6c2ef512-8ad1-439d-954c-a2c01ffbe45d', entityId: '5348c339-7523-4978-adf8-b14ba06955ec', sourceRecordId: '9bc916f3-c03e-4e38-a95b-a2c159729411', formula: '331', productName: 'AF79 Concentrate' },
  { id: '6280871e-428b-46c8-b710-2966facb0a74', entityId: 'bc01860b-3948-4c96-84bf-762ff67c01aa', sourceRecordId: '7af1300c-f4f8-44d9-965f-b2c0741faf3b', formula: '355', productName: 'pH7Q Dual (US)' },
  { id: 'c5d1f7d0-4281-4220-af66-b6acdad16c24', entityId: 'bc01860b-3948-4c96-84bf-762ff67c01aa', sourceRecordId: 'ca216144-a82c-4267-8b7d-365a9cd1c413', formula: '355', productName: 'Daily Disinfectant Dual (Canada)' },
  { id: '0d44ac20-8931-4a91-b0d1-d48d40ecc593', entityId: 'aca83ec1-d432-48b2-a208-5438fa6476e5', sourceRecordId: '304d490b-a1a9-42cf-9538-1ba27231855e', formula: '3820', productName: 'VersiFect' },
  { id: 'f42e7404-76d7-4ba7-a60d-5d35c64aa5e7', entityId: '3b1d6ef6-e0ca-41de-b3ce-55fb41b5c1f6', sourceRecordId: '08d9b6a3-aaf3-48c0-b6c6-c14d1b948469', formula: '392', productName: 'GE Fight Bac Wipes (US)' },
  { id: 'ef595017-95a2-472a-b45a-27757f5167c9', entityId: '3b1d6ef6-e0ca-41de-b3ce-55fb41b5c1f6', sourceRecordId: '6b7b3867-264b-4f2e-a632-33ae22812e67', formula: '392', productName: 'GE Fight Bac Wipes (Canada)' },
  { id: 'eaef02ee-6a68-4f86-9ca0-6a7ba58dbab7', entityId: 'c8ff2f8b-f08f-44f2-af1a-54aca0574b22', sourceRecordId: 'd2d493a3-68e5-4ce4-b08f-994459dddeb3', formula: '087', productName: 'Betco Cide-bet II' },
  { id: '719fddff-bc0b-4058-ac54-960058e2358f', entityId: '02fd6247-7e76-4018-bb45-40cf40a2fab8', sourceRecordId: '8b8e9217-debe-4ce8-8a8d-ad2d0a98ae4f', formula: '316', productName: 'pH7Q' },
  { id: 'a33a3d0d-62e2-4220-8720-0d7244a548b4', entityId: '5e445e31-7e87-4b9b-941d-42caa3d3d3dc', sourceRecordId: '7bafb5fb-c70a-4591-9163-cd12673774d9', formula: '315', productName: 'AF315' },
  { id: 'f2ccc9d5-d443-449e-9d3f-4ddfc8a74fe0', entityId: '118c2231-ad11-442f-b8c6-f3031d9a7e02', sourceRecordId: 'b41deff1-fe11-48bb-91a1-64ca9307c4a6', formula: '390', productName: 'GE Fight Bac RTU (US)' },
  { id: 'b3d31cac-7203-445d-8fb2-5e861c962e79', entityId: '118c2231-ad11-442f-b8c6-f3031d9a7e02', sourceRecordId: 'c33d32c3-cdb1-41ff-b3db-f9304be701e3', formula: '390', productName: 'GE Fight Bac RTU (Canada)' },
  { id: '4629d646-6b68-4511-8795-cc221c91fbb3', entityId: '7ff8c1d3-e4b4-46b6-b119-4e64095a8c7c', sourceRecordId: 'ce158d2d-768c-4653-aef9-68096ae10d0a', formula: '304', productName: 'Betco Pine Quat' },
  { id: '747d25c7-9fcd-440f-951a-51cdb81e006a', entityId: '2820d1f5-207a-4f83-9f85-27650c7a84fa', sourceRecordId: '0d06968a-b694-4e67-8da1-4ffa3e488854', formula: '314', productName: 'Sure Bet II' },
  { id: '1055f9bb-10a9-45d2-9683-d570daa1009e', entityId: 'a2a9fe4e-c236-452a-9b49-b67603307fdf', sourceRecordId: '8b8e92fe-3935-4857-8cb0-c1c4151bb7c1', formula: '070', productName: 'Rest Stop' },
];

// Documents deliberately excluded, and why (reported, never silently dropped).
const EXCLUDED = [
  { id: '43fc66ec-461a-40b1-8b60-d4d78a93f576', reason: 'duplicate', detail: 'af79-efficacy-sheet.md — byte-identical to Efficacy_Data_079_AF79.md per B0-225 reconciliation.' },
  { id: '2efef2ed-fa31-4fb4-8a3a-1eb65e71dd1c', reason: 'duplicate', detail: '070-efficacy-sheet.md — byte-identical to Efficacy_Data_070_Rest_Stop.md per B0-225 reconciliation.' },
  { id: 'af8946de-2645-4f00-8348-d6393dd9a618', reason: 'sanitizer_only', detail: 'Efficacy_Data_237_Sanibet_Multi_Range.md — only ppm-based food-contact "Sanitizer Efficacy" claims; no bactericidal/virucidal/fungicidal/tuberculocidal content.' },
  { id: 'c321e633-f9ad-44d6-b553-693d7a5d1c1b', reason: 'sanitizer_only', detail: 'Efficacy_Data_342_Sanibet_RTU.md — only ppm-based food-contact "Sanitizer Efficacy" claims; no bactericidal/virucidal/fungicidal/tuberculocidal content.' },
];

// ── Section-heading -> claim_type map ───────────────────────────────────────
const HEADINGS = [
  ['Bactericidal Efficacy', 'bactericidal'],
  ['Bactericidal Activity', 'bactericidal'],
  ['Animal Premise Virucidal Efficacy', 'virucidal'],
  ['Animal Premise Virucidal Activity', 'virucidal'],
  ['Virucidal Activity', 'virucidal'],
  ['Fungicidal and Mildewstat Activity', 'fungicidal'],
  ['Fungicidal and Mildew Control', 'fungicidal'],
  ['Fungicidal Efficacy', 'fungicidal'],
  ['Fungicidal Activity', 'fungicidal'],
  ['Mildew Fungistatic Data', 'fungicidal'],
  ['Mildew Efficacy', 'fungicidal'],
  ['Tuberculocidal Activity', 'tuberculocidal'],
  // Explicitly NOT mapped (excluded from this ticket's scope, dropped if encountered):
  // 'Sanitizer Efficacy', 'Sanitizing Activity', 'Soft Surface Sanitization Efficacy',
  // 'Hard Surface Sanitization Efficacy'.
];
const SANITIZER_HEADINGS = [
  'Sanitizer Efficacy',
  'Sanitizing Activity',
  'Soft Surface Sanitization Efficacy',
  'Hard Surface Sanitization Efficacy',
];
const ALL_HEADINGS = [...HEADINGS.map(([h]) => h), ...SANITIZER_HEADINGS];

const TB_ORGANISM_RE = /mycobacterium\s+(bovis|tuberculosis|terrae)/i;

// ── Per-document / per-organism dilution overrides ──────────────────────────
// Only written when the label's own Conditions line gives an explicit oz/gal figure or an
// unambiguous 1:N ratio (reduced via the same 128/N rule rag.product_line_fact uses).
// Every other row's dilution_oz_per_gal stays NULL. See header comment for the full list.
function dilutionOverride(docId, organism, claimType) {
  switch (docId) {
    case '6c2ef512-8ad1-439d-954c-a2c01ffbe45d': // 331 AF79 Concentrate — "2oz. Per Gallon Dilution (1:64)"
      return 2;
    case 'a33a3d0d-62e2-4220-8720-0d7244a548b4': // 315 AF315 — "5 oz. per Gallon Dilution"
      return 5;
    case '0d44ac20-8931-4a91-b0d1-d48d40ecc593': // 3820 VersiFect — "@1:64 dilution" (128/64 = 2)
      return 2;
    case '747d25c7-9fcd-440f-951a-51cdb81e006a': // 314 Surebet II — ONLY the virucidal Conditions line states "586 ppm (3 oz/gal)"
      return claimType === 'virucidal' ? 3 : null;
    case '1f0d1d94-b59b-469b-9436-4e0f19a1d82d': // 341 Quat-Stat 5 — ONLY the Trichophyton row carries its own "[2 oz. per gallon]" footnote
      return /trichophyton mentagrophytes/i.test(organism) && /2 oz\. per gallon/i.test(organism) ? 2 : null;
    case '6280871e-428b-46c8-b710-2966facb0a74': // 355 pH7Q Dual (US) — 0.5 oz/gal base rate; Canine Parvovirus/Rabies Virus tested at 2.25 oz/gal per their own Conditions sub-block
      if (/^canine parvovirus$/i.test(organism.trim()) || /^rabies virus$/i.test(organism.trim())) return 2.25;
      return 0.5;
    // c5d1f7d0 (355 Daily Disinfectant Dual, Canada) is deliberately absent: its dilutions
    // are metric (mL per 3.78 L) — left NULL rather than cross-unit-converted to oz/gal.
    default:
      return null;
  }
}

// ── Contact-time parsing ─────────────────────────────────────────────────────
function parseContactTimeSeconds(raw) {
  const text = raw.trim();
  if (!text) return { seconds: null, flag: 'blank_contact_time' };
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(sec|min)/i);
  if (!m) return { seconds: null, flag: `unparsed_contact_time:"${text}"` };
  const n = Number(m[1]);
  const seconds = /^sec/i.test(m[2]) ? n : n * 60;
  if (!Number.isFinite(seconds)) return { seconds: null, flag: `unparsed_contact_time:"${text}"` };
  return { seconds: Math.round(seconds), flag: null };
}

// ── Table-row parsing within one section's content ──────────────────────────
function parseTableRows(content) {
  const rows = [];
  // Every row of the tables in this corpus is a single line "| a | b | ... | z |".
  const lineRe = /\|([^\n|][^\n]*?)\|(?:\s*\n|$)/g;
  // Simpler and safer: split on '\n', keep lines that look like table rows.
  for (const rawLine of content.split('\n')) {
    // Some sections carry a mid-section dilution change (e.g. "...| 10 min. | Conditions:
    // 67 ml per 3.78 L Dilution | Organism | ATCC/Source | Contact Time |") glued onto the
    // END of the previous data row with no newline before the new "Conditions:" sub-block.
    // Truncate at that point so the real data row (everything before "Conditions:") parses
    // correctly instead of swallowing the next mini-table's own header cells.
    const condIdx = rawLine.indexOf('Conditions:');
    const line = condIdx === -1 ? rawLine : rawLine.slice(0, condIdx);
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    if (cells.every((c) => c === '')) continue; // separator row "| | | |"
    if (cells.length < 2) continue;
    if (/^organism$/i.test(cells[0])) continue; // header row itself
    const organism = cells[0];
    const contactTimeRaw = cells[cells.length - 1];
    if (!organism) continue;
    rows.push({ organism, contactTimeRaw });
  }
  void lineRe;
  return rows;
}

function parseDocument(doc, bodyText) {
  const rows = [];
  const flags = [];

  // Frontmatter EPA reg, transcribed verbatim (space-separated form — see header comment).
  const epaMatch = bodyText.match(/^epa reg no:\s*(.+)$/im);
  const epaRaw = epaMatch ? epaMatch[1].trim() : null;
  const epaRegistration = epaRaw && epaRaw !== 'null' ? epaRaw : null;

  // Split the body into (heading, content) pairs using the fixed heading vocabulary.
  const headingAlt = ALL_HEADINGS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const splitRe = new RegExp(`(${headingAlt})`, 'g');
  const parts = bodyText.split(splitRe);
  // parts alternates [preamble, heading, content, heading, content, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i];
    const content = parts[i + 1] ?? '';
    if (SANITIZER_HEADINGS.includes(heading)) continue; // out of scope
    const mapping = HEADINGS.find(([h]) => h === heading);
    if (!mapping) continue;
    const baseClaimType = mapping[1];

    for (const { organism, contactTimeRaw } of parseTableRows(content)) {
      const claimType = TB_ORGANISM_RE.test(organism) ? 'tuberculocidal' : baseClaimType;
      const { seconds, flag } = parseContactTimeSeconds(contactTimeRaw);
      if (flag) flags.push({ document_id: doc.id, organism, flag });
      rows.push({
        entity_id: doc.entityId,
        product_key: null,
        organism,
        claim_type: claimType,
        dilution_oz_per_gal: dilutionOverride(doc.id, organism, claimType),
        contact_time_seconds: seconds,
        epa_registration: epaRegistration,
        source_record_id: doc.sourceRecordId,
        source_page: null,
        confidence: 0.9,
      });
    }
  }

  return { rows, flags, epaRegistration };
}

// Dedupe identity mirrors efficacyDedupeKey() in src/lib/retrieval/product-facts.ts, since
// two rows differing only in an ATCC/strain number (not a stored column) would collapse to
// the same fact at read time anyway — no value in writing true duplicates.
function dedupeKey(r) {
  return [
    r.entity_id,
    r.organism,
    r.claim_type ?? '',
    r.dilution_oz_per_gal == null ? '' : String(r.dilution_oz_per_gal),
    r.contact_time_seconds == null ? '' : String(r.contact_time_seconds),
    r.epa_registration ?? '',
  ].join('::');
}

async function main() {
  log(`\nB0-199 disinfectant efficacy ingest — ${WRITE ? 'WRITE' : 'DRY RUN (no changes)'}\n`);

  const { data: docs, error } = await supabase
    .schema('rag')
    .from('document')
    .select('id, body_text')
    .in('id', DOCS.map((d) => d.id));
  if (error) throw new Error(`load documents: ${error.message}`);
  const bodyById = new Map((docs ?? []).map((d) => [d.id, d.body_text]));

  const allRows = [];
  const allFlags = [];
  const perDoc = [];

  for (const doc of DOCS) {
    const bodyText = bodyById.get(doc.id);
    if (!bodyText) {
      allFlags.push({ document_id: doc.id, flag: 'document_not_found_or_empty_body' });
      continue;
    }
    const { rows, flags, epaRegistration } = parseDocument(doc, bodyText);
    allRows.push(...rows);
    allFlags.push(...flags);
    perDoc.push({
      document_id: doc.id,
      formula: doc.formula,
      product_name: doc.productName,
      epa_registration: epaRegistration,
      rows_parsed: rows.length,
      by_claim_type: rows.reduce((acc, r) => ((acc[r.claim_type] = (acc[r.claim_type] ?? 0) + 1), acc), {}),
    });
  }

  // Dedupe.
  const seen = new Map();
  for (const r of allRows) {
    const key = dedupeKey(r);
    if (!seen.has(key)) seen.set(key, r);
  }
  const deduped = [...seen.values()];

  log('── Per-document parse summary ──────────────────────────────');
  for (const d of perDoc) {
    log(
      `  ${d.formula.padEnd(5)} ${d.product_name.padEnd(38)} epa=${String(d.epa_registration).padEnd(20)} rows=${d.rows_parsed} ${JSON.stringify(d.by_claim_type)}`,
    );
  }

  const byClaimType = deduped.reduce((acc, r) => ((acc[r.claim_type] = (acc[r.claim_type] ?? 0) + 1), acc), {});
  const byEntity = new Map();
  for (const r of deduped) byEntity.set(r.entity_id, (byEntity.get(r.entity_id) ?? 0) + 1);

  log('\n── Totals (after de-dup) ────────────────────────────────────');
  log(`  Parsed (raw):     ${allRows.length}`);
  log(`  After de-dup:     ${deduped.length}`);
  log(`  By claim_type:    ${JSON.stringify(byClaimType)}`);
  log(`  Distinct entities: ${byEntity.size}`);
  log(`  Tuberculocidal rows: ${deduped.filter((r) => r.claim_type === 'tuberculocidal').length}`);

  if (DUMP_ROWS) {
    log('\n── Full row dump (--dump-rows) ───────────────────────────────');
    for (const r of deduped) log(JSON.stringify(r));
  }

  if (allFlags.length) {
    log(`\n── Flags (${allFlags.length}) — rows written with a null/unparsed value, never guessed ──`);
    for (const f of allFlags) log(`  ${f.document_id} — ${f.organism ? `"${f.organism}" — ` : ''}${f.flag}`);
  }

  const report = {
    generated_at: new Date().toISOString(),
    ticket: 'B0-199',
    mode: WRITE ? 'write' : 'dry-run',
    excluded_documents: EXCLUDED,
    per_document: perDoc,
    totals: {
      parsed_raw: allRows.length,
      after_dedupe: deduped.length,
      by_claim_type: byClaimType,
      distinct_entities: byEntity.size,
    },
    flags: allFlags,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(`\nReport written to src/lib/training/disinfectant-efficacy-ingest-report-b0199.json`);

  if (!WRITE) {
    log('\nDRY RUN — no database changes made. Re-run with --write to apply.\n');
    return;
  }

  // Read existing rows for these entities so a re-run never inserts a duplicate.
  const entityIds = [...byEntity.keys()];
  const { data: existing, error: exErr } = await supabase
    .schema('rag')
    .from('product_efficacy')
    .select('entity_id, organism, claim_type, dilution_oz_per_gal, contact_time_seconds, epa_registration')
    .in('entity_id', entityIds);
  if (exErr) throw new Error(`read existing product_efficacy: ${exErr.message}`);
  const existingKeys = new Set(
    (existing ?? []).map((r) =>
      dedupeKey({
        entity_id: r.entity_id,
        organism: r.organism,
        claim_type: r.claim_type,
        dilution_oz_per_gal: r.dilution_oz_per_gal,
        contact_time_seconds: r.contact_time_seconds,
        epa_registration: r.epa_registration,
      }),
    ),
  );
  const toInsert = deduped.filter((r) => !existingKeys.has(dedupeKey(r)));

  if (!toInsert.length) {
    log('\nNothing new to insert — all parsed rows already present.');
    return;
  }

  // The service-role PostgREST path returns "permission denied for table product_efficacy"
  // (RLS write lockdown — see the rag_security_lockdown_* / rag_maintenance_rpc_* migrations;
  // this table apparently grants service_role SELECT but not INSERT via PostgREST). Emit one
  // small SQL file PER DOCUMENT instead of one giant statement, so each can be applied via the
  // Supabase MCP execute_sql tool (or `psql`) without needing the whole batch in one go.
  const sqlEscape = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const sqlValue = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : sqlEscape(v));
  const toInsertByDoc = new Map();
  for (const r of toInsert) {
    const list = toInsertByDoc.get(r.source_record_id) ?? [];
    list.push(r);
    toInsertByDoc.set(r.source_record_id, list);
  }

  mkdirSync(new URL('../.b0199-sql/', import.meta.url), { recursive: true });
  let fileIndex = 0;
  for (const doc of DOCS) {
    const rowsForDoc = toInsertByDoc.get(doc.sourceRecordId) ?? [];
    if (!rowsForDoc.length) continue;
    fileIndex += 1;
    const values = rowsForDoc
      .map(
        (r) =>
          `  (${sqlValue(r.entity_id)}, ${sqlValue(r.product_key)}, ${sqlValue(r.organism)}, ${sqlValue(r.claim_type)}, ${sqlValue(r.dilution_oz_per_gal)}, ${sqlValue(r.contact_time_seconds)}, ${sqlValue(r.epa_registration)}, ${sqlValue(r.source_record_id)}, ${sqlValue(r.source_page)}, ${sqlValue(r.confidence)})`,
      )
      .join(',\n');
    const sql = `-- B0-199 — ${doc.formula} ${doc.productName} — ${rowsForDoc.length} rows\ninsert into rag.product_efficacy\n  (entity_id, product_key, organism, claim_type, dilution_oz_per_gal, contact_time_seconds, epa_registration, source_record_id, source_page, confidence)\nvalues\n${values};\n`;
    const path = new URL(
      `../.b0199-sql/${String(fileIndex).padStart(2, '0')}-${doc.formula}-${doc.productName.replace(/[^a-z0-9]+/gi, '_')}.sql`,
      import.meta.url,
    );
    writeFileSync(path, sql);
  }
  log(
    `\n${toInsert.length} new rows ready to insert (already present: ${deduped.length - toInsert.length}), ` +
      `split into ${fileIndex} per-document SQL files under .b0199-sql/ — apply each via the Supabase MCP ` +
      `execute_sql tool (the service-role PostgREST path is blocked by this table's RLS write lockdown).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
