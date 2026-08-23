/**
 * B0-484 — Corpus-scan script to mine acronym / parenthetical / informal-name
 * aliases for rag.product_alias.
 *
 * Scans product-descriptive text (rag.document_chunk + rag.document.body_text
 * for document_kind IN ('label', 'product_line_profile', 'knowledge'), and
 * legacy.products_descr) for three families of candidate aliases:
 *
 *   1. corpus_scan_parenthetical — "Phrase (ACRONYM)" where the parenthetical
 *      content is an all-caps acronym whose letters match the initials of the
 *      preceding phrase (e.g. "Hard As Nails (HAN)"). alias_type='acronym'.
 *   2. corpus_scan_cooccurrence — bare all-caps short tokens (2-6 letters)
 *      found in the same entity-tied passage as (a meaningful chunk of) the
 *      product's own title. alias_type='synonym'.
 *   3. corpus_scan_noun_phrase — the "head" of a product title (the part
 *      before a trailing suffix/descriptor, e.g. dash/parenthetical/comma
 *      clause) when that shorter phrase is separately corroborated by a
 *      standalone appearance in the corpus (not just as a prefix of the full
 *      title string). alias_type='common_name'.
 *
 * Every row is inserted as verified=false — this script never sets
 * verified=true. Trusted promotion happens through the (separate, B0-487)
 * admin review queue. Idempotent: upserts on (alias_norm, product_line_key),
 * the table's real unique constraint (confirmed live, B0-481). To protect
 * existing data, a candidate is only ever inserted or updated when there is no
 * existing row for that (alias_norm, product_line_key) pair, or the existing
 * row was itself written by this script (source LIKE 'corpus_scan_%') and is
 * still unverified — anything verified, or owned by another source, is left
 * untouched.
 *
 * SDS documents (document_kind='sds') are deliberately excluded from the scan:
 * their text is GHS/regulatory boilerplate (HMIS, SCBA, CWA, TSCA, HAPs, ...)
 * that would otherwise dominate the parenthetical/co-occurrence patterns with
 * acronyms that have nothing to do with the product's own name.
 *
 * Usage:
 *   node --env-file=.env.local scripts/mine-corpus-alias-candidates.mjs --dry-run
 *   node --env-file=.env.local scripts/mine-corpus-alias-candidates.mjs
 *
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
function loadEnvLocal() {
  try {
    const envContent = readFileSync(new URL('../.env.local', import.meta.url), 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // already set in environment (e.g. --env-file was used, or CI env vars)
  }
}
loadEnvLocal();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
/** Optional `--json=<path>`: also write the full deduped candidate list to disk for review. */
const JSON_OUT = args.find((a) => a.startsWith('--json='))?.slice('--json='.length) ?? null;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Mirrors normalizeAlias in ~/lib/rag/entity-context.ts (B0-200) — duplicated
 * here deliberately, same reasoning as scripts/b0243-sds-scope-audit.mjs: this
 * script runs as plain `node`, not through the Next.js/TS module graph. */
export function normalizeAlias(value) {
  return value
    .replace(/[®™]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'with', 'in', 'on', 'to', 'is', 'are', '&',
]);

export function significantTitleTokens(title) {
  return title
    .replace(/[®™]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 4 && !STOPWORDS.has(tok));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Generic acronyms that show up constantly in regulatory/marketing prose but are never
 * a product-specific alias. Kept deliberately conservative/short — this is a blocklist for
 * precision, not an attempt to enumerate every industry acronym. */
const GENERIC_ACRONYM_BLOCKLIST = new Set([
  'SDS', 'MSDS', 'GHS', 'PPE', 'EPA', 'CAS', 'DIN', 'LLC', 'INC', 'LTD', 'CO',
  'HMIS', 'SCBA', 'TSCA', 'CWA', 'DEA', 'NFPA', 'OSHA', 'WHMIS', 'RCRA', 'VOC',
  'UN', 'US', 'USA', 'USDA', 'FDA', 'GMP', 'CFR', 'PDF', 'URL', 'HTML', 'SKU',
  'GTIN', 'RTU', 'UPC', 'NAICS', 'SIC', 'PPM', 'GHG', 'LEED', 'ANSI', 'ISO',
  'MSRP', 'AOAC', 'ATCC', 'AATCC', 'CDC',
  'ADA', 'CDC', 'FIFRA', 'NSF', 'UL', 'CE', 'REACH', 'WHO', 'USP', 'FAQ', 'CEO',
  'CFO', 'CGMP', 'NOTE', 'CAUTION', 'DANGER', 'WARNING', 'NET', 'WT', 'LB',
  'LBS', 'OZ', 'GAL', 'ML', 'KG', 'CAN', 'EST', 'FL', 'CFC', 'HCFC', 'IATA',
  'IMDG', 'ATE', 'BCF', 'IBC', 'SGG', 'DOT', 'FTC', 'CPSC', 'HAP', 'HAPS',
  // Common short English (and a few Spanish) words that routinely appear in ALL-CAPS
  // label/warning copy ("FOR PROFESSIONAL USE ONLY", "KEEP OUT OF REACH", ...) and are
  // never a product alias on their own.
  'FOR', 'USE', 'ONLY', 'NOT', 'AND', 'THE', 'WITH', 'FROM', 'INTO', 'ALL',
  'ANY', 'OUT', 'OFF', 'NEW', 'PER', 'MAX', 'MIN', 'TOP', 'END', 'KEEP',
  'AWAY', 'THIS', 'THAT', 'WILL', 'CAN', 'MAY', 'MUST', 'SHALL', 'EACH',
  'MORE', 'MOST', 'SOME', 'SUCH', 'WHEN', 'THEN', 'ALSO', 'EVEN', 'JUST',
  'BOTH', 'YES', 'NO', 'OK', 'NOTA', 'AVISO', 'PARA', 'CON', 'SIN', 'ANTES',
  'SEE', 'READ', 'BEFORE', 'AFTER', 'OVER', 'UNDER', 'OPEN', 'CLOSE', 'SHAKE',
  'RINSE', 'WASH', 'WEAR', 'AVOID', 'STORE', 'DILUTE', 'APPLY', 'ROOM', 'AREA',
]);

/** Every whitespace-delimited token's first letter, uppercased, concatenated —
 * intentionally NOT filtering stopwords, since informal acronyms often include the
 * initial of a small connector word (e.g. "Hard As Nails" -> HAN). */
export function initialsOf(phrase) {
  return phrase
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, '').charAt(0))
    .filter(Boolean)
    .join('')
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// Pattern 1 — parenthetical acronym extraction
// ---------------------------------------------------------------------------
const PHRASE_ACRONYM_RE = /((?:[A-Za-z][A-Za-z0-9&'’.-]*\s+){1,5}[A-Za-z][A-Za-z0-9&'’.-]*)\s*\(([A-Z]{2,6})\)/g;

export function detectParenthetical(records, entityTitleTokens) {
  const candidates = [];
  for (const rec of records) {
    if (!rec.text) continue;
    const titleTokens = entityTitleTokens.get(rec.entityId);
    PHRASE_ACRONYM_RE.lastIndex = 0;
    let m;
    while ((m = PHRASE_ACRONYM_RE.exec(rec.text))) {
      const phrase = m[1].trim();
      const acronym = m[2];
      if (!/^[A-Z]/.test(phrase)) continue; // require a proper-noun-like phrase
      if (GENERIC_ACRONYM_BLOCKLIST.has(acronym)) continue;
      if (initialsOf(phrase) !== acronym) continue;
      // Require the defined phrase to share real vocabulary with the product's own title —
      // filters out things like "Hepatitis B Virus (HBV)" (an organism the product treats,
      // not a name for the product itself) that would otherwise pass the initials check.
      if (titleTokens && titleTokens.length > 0) {
        const phraseTokens = significantTitleTokens(phrase);
        const overlaps = phraseTokens.some((t) => titleTokens.includes(t));
        if (!overlaps) continue;
      }
      candidates.push({
        aliasNorm: normalizeAlias(acronym),
        alias: acronym,
        entityId: rec.entityId,
        productLineKey: rec.productLineKey,
        source: 'corpus_scan_parenthetical',
        aliasType: 'acronym',
        confidence: 0.65,
        evidence: `"${phrase} (${acronym})"`,
      });
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Pattern 2 — all-caps token co-occurring with the product's own title
// ---------------------------------------------------------------------------

/** product_line_profile chunks embed structured identifier lines verbatim —
 * "Product key: AFFE515B-53A8-4D2C-ABE2-C5698A554082", "SKU: E87383-00",
 * "Inventory ID: E010507EQP0600BE1200". Hyphens are word boundaries, so the
 * alpha-only segments of a GUID (ABDA, CEEB, BDFC, ...) match the all-caps token
 * regex and were by far the largest source of junk candidates. Mask every
 * identifier out before tokenizing. */
export function maskIdentifiers(text) {
  return text
    .replace(/\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g, ' ')
    .replace(/^[ \t]*(?:Product key|SKU|Inventory ID|Item|UPC|GTIN)[ \t]*:.*$/gim, ' ')
    .replace(/\b[A-Z]{1,2}\d{5,}[A-Z0-9]*\b/g, ' '); // bare InvtID / SKU codes
}

/** True when `token` is exactly the initials of some contiguous run of words in
 * the product's own title (e.g. "Hard As Nails" -> HAN). This is the same
 * name-derivation test pattern 1 applies, minus the parentheses. Without it,
 * "co-occurs with the title" admits every pathogen (HIV, MRSA, VRE), standards
 * body (ASTM, NWFA), and unit (GPM, PSI, CFU) that legitimately appears in
 * product copy but is never a name for the product. */
export function matchesTitleInitials(token, title) {
  const words = title.replace(/[®™]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const n = token.length;
  if (n < 2 || words.length < n) return false;
  for (let i = 0; i + n <= words.length; i++) {
    if (initialsOf(words.slice(i, i + n).join(' ')) === token) return true;
  }
  return false;
}

// Minimum length 3 (not 2) for this pattern specifically: 2-letter all-caps tokens (IN, ID,
// AC, OF, OR, TO, ...) occur so often by incidental capitalization/emphasis in running text
// that they swamp this already-lowest-confidence pattern with noise the other two patterns
// don't have (they're gated by the initials-match / title-derivation checks instead).
const ALLCAPS_TOKEN_RE = /\b[A-Z]{3,6}\b/g;

/** True when the matched all-caps token is embedded in a longer "shouting" run (a
 * neighboring word is itself all-caps) — i.e. label boilerplate like "FOR PROFESSIONAL
 * USE ONLY" rather than a genuine isolated acronym sitting in otherwise mixed-case prose. */
function isPartOfAllCapsRun(text, index, length) {
  const before = text.slice(Math.max(0, index - 20), index);
  const after = text.slice(index + length, index + length + 20);
  const prevWord = before.match(/([A-Za-z]+)\s*$/)?.[1] ?? '';
  const nextWord = after.match(/^\s*([A-Za-z]+)/)?.[1] ?? '';
  const isShouting = (w) => w.length >= 2 && w === w.toUpperCase();
  return isShouting(prevWord) || isShouting(nextWord);
}

export function detectCooccurrence(records, entityTitleTokens, excludeKeys, entities) {
  // First pass: collect every (alias, product line) hit along with which distinct records it
  // showed up in. "Co-occurrence" implies a recurring association, not a one-off — a token that
  // only ever appears once in a single chunk (e.g. one cell of a wiring-diagram table) is much
  // more likely incidental capitalization than a genuine informal product name, so the second
  // pass below requires at least two independent record hits before promoting a candidate.
  const hits = new Map(); // key -> { alias, entityId, productLineKey, titleTokens, recordIds: Set }
  records.forEach((rec, recordIdx) => {
    if (!rec.text) return;
    const titleTokens = entityTitleTokens.get(rec.entityId);
    // Require a genuinely multi-word title as the co-occurrence anchor. A single-token title
    // (e.g. a bare product_line entity named "Electrical") is trivially "found" in nearly any
    // entity-tied passage, which stops being a meaningful co-occurrence signal at all and, in
    // practice, was the single biggest source of noise seen while tuning this pattern (a large
    // spare-parts catalog product line whose profile document is full of generic part jargon).
    if (!titleTokens || titleTokens.length < 2) return;
    const entityTitle = entities?.get(rec.entityId)?.title;
    if (!entityTitle) return;
    const text = maskIdentifiers(rec.text);
    const textLower = text.toLowerCase();
    const overlap = titleTokens.filter((t) => textLower.includes(t)).length;
    const requiredOverlap = Math.min(2, titleTokens.length);
    if (overlap < requiredOverlap) return;

    ALLCAPS_TOKEN_RE.lastIndex = 0;
    let m;
    const seenInRecord = new Set();
    while ((m = ALLCAPS_TOKEN_RE.exec(text))) {
      const token = m[0];
      if (GENERIC_ACRONYM_BLOCKLIST.has(token)) continue;
      if (seenInRecord.has(token)) continue;
      if (isPartOfAllCapsRun(text, m.index, token.length)) continue;
      if (!matchesTitleInitials(token, entityTitle)) continue;
      seenInRecord.add(token);
      const aliasNorm = normalizeAlias(token);
      const key = `${aliasNorm}::${rec.productLineKey}`;
      if (excludeKeys.has(key)) continue;
      if (!hits.has(key)) {
        hits.set(key, { alias: token, entityId: rec.entityId, productLineKey: rec.productLineKey, entityTitle, recordIds: new Set() });
      }
      hits.get(key).recordIds.add(recordIdx);
    }
  });

  const candidates = [];
  for (const hit of hits.values()) {
    if (hit.recordIds.size < 2) continue;
    candidates.push({
      aliasNorm: normalizeAlias(hit.alias),
      alias: hit.alias,
      entityId: hit.entityId,
      productLineKey: hit.productLineKey,
      source: 'corpus_scan_cooccurrence',
      aliasType: 'synonym',
      confidence: 0.35,
      evidence: `"${hit.alias}" = initials of "${hit.entityTitle}", in ${hit.recordIds.size} passages`,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Pattern 3 — noun-phrase / common-name variant of an existing title
// ---------------------------------------------------------------------------
const TITLE_SUFFIX_SEPARATORS = [' — ', ' – ', ' - ', ' (', ', '];

export function deriveHeadPhrase(title) {
  const cleaned = title.replace(/[®™]/g, '').trim();
  let cut = cleaned.length;
  for (const sep of TITLE_SUFFIX_SEPARATORS) {
    const idx = cleaned.indexOf(sep);
    if (idx > -1 && idx < cut) cut = idx;
  }
  const head = cleaned.slice(0, cut).trim().replace(/[!?.,;:]+$/, '');
  return head;
}

/** True when `head` appears in `text` at an occurrence that is NOT simply the start of the
 * full title string (i.e. genuinely standalone corpus usage, not just a prefix match of the
 * title itself sitting in the same text). */
export function hasStandaloneOccurrence(text, head, fullTitle) {
  const re = new RegExp(`\\b${escapeRegExp(head)}\\b`, 'gi');
  const rest = fullTitle.slice(head.length).trimStart();
  const nextWordMatch = rest.match(/^[A-Za-z0-9]+/);
  const nextWord = nextWordMatch ? nextWordMatch[0] : null;
  let m;
  while ((m = re.exec(text))) {
    if (!nextWord) return true;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + nextWord.length + 3);
    const continuesTitle = new RegExp(`^\\s*[\\(\\-–—,]?\\s*${escapeRegExp(nextWord)}`, 'i').test(after);
    if (!continuesTitle) return true;
  }
  return false;
}

/** Suffixes that carry REGION or LIFECYCLE STATUS. Dropping one of these to form a
 * "shorter name" would produce an alias that silently erases the very distinction the
 * suffix exists to make — e.g. "Neutral Disinfectant Cleaner (Canada Only)" -> "Neutral
 * Disinfectant Cleaner". Per the org-wide regulated-data rule, active/discontinued status
 * and region are never inferred away, so these titles yield no head-phrase alias. */
const REGION_OR_STATUS_SUFFIX_RE =
  /\b(canada|canadian|us|usa|united states|mexico|export|overseas|only|discontinued|obsolete|inactive|nla|do not use|replaced)\b/i;

/** Catalog bookkeeping buckets, not products. Their titles head-phrase into generic
 * strings ("Demo Kits", "RAW MATERIAL", "Unclassified NS Parts") that would collide
 * across many unrelated product lines. */
const CATALOG_BUCKET_RE =
  /\b(unclass|unclassified|raw materials?|demo kits?|costing|packaging|price lists?|support materials?|misc|miscellaneous|samples?|billing)\b/i;

export function detectNounPhraseVariants(entities, recordsByEntity) {
  const candidates = [];
  for (const [entityId, entity] of entities) {
    const head = deriveHeadPhrase(entity.title);
    if (!head || head.length < 4) continue;
    if (head.split(/\s+/).filter(Boolean).length < 2) continue;
    if (CATALOG_BUCKET_RE.test(entity.title)) continue;
    // Only the dropped remainder is checked: a region/status word inside the head itself
    // is retained by the alias, so it loses nothing.
    const dropped = entity.title.slice(head.length);
    if (REGION_OR_STATUS_SUFFIX_RE.test(dropped)) continue;
    // Compare against the title with the same trailing punctuation stripped, so a title that
    // merely ends in "...product." doesn't produce a "new" head phrase that's really identical.
    const normalizedTitle = entity.title.trim().replace(/[!?.,;:]+$/, '').toLowerCase();
    if (head.toLowerCase() === normalizedTitle) continue;

    const recs = recordsByEntity.get(entityId) ?? [];
    const supported = recs.some((rec) => hasStandaloneOccurrence(rec.text, head, entity.title));
    if (!supported) continue;

    candidates.push({
      aliasNorm: normalizeAlias(head),
      alias: head,
      entityId,
      productLineKey: entity.productLineKey,
      source: 'corpus_scan_noun_phrase',
      aliasType: 'common_name',
      confidence: 0.45,
      evidence: `title "${entity.title}" -> head "${head}"`,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Supabase data loading
// ---------------------------------------------------------------------------
async function fetchAllRows(schema, table, select, applyFilters, pageSize = 1000) {
  const rows = [];
  let from = 0;
  for (;;) {
    let q = supabase.schema(schema).from(table).select(select).range(from, from + pageSize - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`${schema}.${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function loadEntities() {
  const rows = await fetchAllRows('rag', 'entity', 'id,title,product_line_key,entity_type,metadata', (q) =>
    q.in('entity_type', ['product', 'product_line']).not('title', 'is', null).not('product_line_key', 'is', null),
  );
  const entities = new Map();
  const invtIdToEntity = new Map();
  for (const row of rows) {
    entities.set(row.id, {
      title: row.title,
      productLineKey: row.product_line_key,
      entityType: row.entity_type,
    });
    if (row.entity_type === 'product' && row.metadata && typeof row.metadata === 'object') {
      const invtId = row.metadata.InvtID;
      if (invtId) invtIdToEntity.set(String(invtId).trim(), row.id);
    }
  }
  return { entities, invtIdToEntity };
}

async function loadDocuments() {
  const rows = await fetchAllRows('rag', 'document', 'id,entity_id,document_kind,title,body_text', (q) =>
    q.in('document_kind', ['label', 'product_line_profile', 'knowledge']).not('entity_id', 'is', null),
  );
  return rows;
}

async function loadChunksForDocuments(documentIds) {
  const chunks = [];
  const batchSize = 150;
  for (let i = 0; i < documentIds.length; i += batchSize) {
    const batchIds = documentIds.slice(i, i + batchSize);
    const rows = await fetchAllRows('rag', 'document_chunk', 'id,document_id,chunk_text', (q) =>
      q.in('document_id', batchIds),
    );
    chunks.push(...rows);
  }
  return chunks;
}

async function loadLegacyDescriptions(invtIdToEntity, entities) {
  if (invtIdToEntity.size === 0) return [];
  const productRows = await fetchAllRows('legacy', 'products', 'ProductsKey,InvtID', (q) =>
    q.not('InvtID', 'is', null),
  );
  const productsKeyToInvtId = new Map();
  for (const row of productRows) {
    if (row.ProductsKey && row.InvtID) productsKeyToInvtId.set(row.ProductsKey, String(row.InvtID).trim());
  }

  const descrRows = await fetchAllRows(
    'legacy',
    'products_descr',
    'ProductsKey,ShortDescr,FullDescr,LanguageCD',
    (q) => q.eq('LanguageCD', 'EN'),
  );

  const records = [];
  for (const row of descrRows) {
    const invtId = productsKeyToInvtId.get(row.ProductsKey);
    if (!invtId) continue;
    const entityId = invtIdToEntity.get(invtId);
    if (!entityId) continue;
    const entity = entities.get(entityId);
    if (!entity) continue;
    const text = [row.ShortDescr, row.FullDescr ? stripHtml(row.FullDescr) : null]
      .filter(Boolean)
      .join('\n');
    if (!text) continue;
    records.push({ entityId, productLineKey: entity.productLineKey, text, sourceLabel: 'legacy.products_descr' });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Safe, idempotent upsert (never touches verified rows or other sources' rows)
// ---------------------------------------------------------------------------
async function safeUpsertCandidates(candidates) {
  const uniqueNorms = [...new Set(candidates.map((c) => c.aliasNorm))];
  const existing = new Map(); // `${alias_norm}::${product_line_key}` -> { source, verified }
  const batchSize = 200;
  for (let i = 0; i < uniqueNorms.length; i += batchSize) {
    const batch = uniqueNorms.slice(i, i + batchSize);
    const { data, error } = await supabase
      .schema('rag')
      .from('product_alias')
      .select('alias_norm, product_line_key, source, verified')
      .in('alias_norm', batch);
    if (error) throw new Error(`product_alias lookup failed: ${error.message}`);
    for (const row of data ?? []) {
      existing.set(`${row.alias_norm}::${row.product_line_key}`, row);
    }
  }

  const toInsert = [];
  const toUpdate = [];
  let skippedProtected = 0;
  for (const c of candidates) {
    const key = `${c.aliasNorm}::${c.productLineKey}`;
    const existingRow = existing.get(key);
    if (!existingRow) {
      toInsert.push(c);
    } else if (existingRow.verified === false && typeof existingRow.source === 'string' && existingRow.source.startsWith('corpus_scan_')) {
      toUpdate.push(c);
    } else {
      skippedProtected++;
    }
  }

  const toRow = (c) => ({
    alias_norm: c.aliasNorm,
    alias: c.alias,
    entity_id: c.entityId,
    product_line_key: c.productLineKey,
    source: c.source,
    confidence: c.confidence,
    alias_type: c.aliasType,
    verified: false,
  });

  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < toInsert.length; i += batchSize) {
    const batch = toInsert.slice(i, i + batchSize).map(toRow);
    const { error } = await supabase.schema('rag').from('product_alias').insert(batch);
    if (error) throw new Error(`insert failed: ${error.message}`);
    inserted += batch.length;
  }
  for (let i = 0; i < toUpdate.length; i += batchSize) {
    const batch = toUpdate.slice(i, i + batchSize).map(toRow);
    const { error } = await supabase
      .schema('rag')
      .from('product_alias')
      .upsert(batch, { onConflict: 'alias_norm,product_line_key' });
    if (error) throw new Error(`upsert failed: ${error.message}`);
    updated += batch.length;
  }

  return { inserted, updated, skippedProtected };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function summarize(candidates) {
  const byPattern = new Map();
  for (const c of candidates) {
    if (!byPattern.has(c.source)) byPattern.set(c.source, []);
    byPattern.get(c.source).push(c);
  }
  for (const [source, list] of byPattern) {
    log(`  ${source}: ${list.length} candidate(s)`);
    for (const c of list.slice(0, 5)) {
      log(`    - "${c.alias}" -> product_line_key=${c.productLineKey} (confidence=${c.confidence}) ${c.evidence ?? ''}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log(`Starting B0-484 corpus alias mining${DRY_RUN ? ' (DRY RUN)' : ''}...`);

  log('Loading known product / product_line entities...');
  const { entities, invtIdToEntity } = await loadEntities();
  log(`  ${entities.size} entities loaded (${invtIdToEntity.size} with an InvtID for legacy join).`);

  const entityTitleTokens = new Map();
  for (const [id, entity] of entities) {
    entityTitleTokens.set(id, significantTitleTokens(entity.title));
  }

  log('Loading entity-tied rag.document rows (label / product_line_profile / knowledge)...');
  const documents = await loadDocuments();
  log(`  ${documents.length} documents.`);
  const documentById = new Map(documents.map((d) => [d.id, d]));

  log('Loading rag.document_chunk rows for those documents...');
  const chunks = await loadChunksForDocuments(documents.map((d) => d.id));
  log(`  ${chunks.length} chunks.`);

  log('Loading legacy.products_descr rows mapped to known product entities...');
  const legacyRecords = await loadLegacyDescriptions(invtIdToEntity, entities);
  log(`  ${legacyRecords.length} legacy description rows mapped.`);

  // Build the unified scan-record pool: one record per (document body_text), one per chunk,
  // one per legacy description row.
  const records = [];
  for (const doc of documents) {
    if (doc.body_text) {
      const entity = entities.get(doc.entity_id);
      if (entity) {
        records.push({ entityId: doc.entity_id, productLineKey: entity.productLineKey, text: doc.body_text, sourceLabel: 'rag.document.body_text', documentKind: doc.document_kind });
      }
    }
  }
  for (const chunk of chunks) {
    const doc = documentById.get(chunk.document_id);
    if (!doc) continue;
    const entity = entities.get(doc.entity_id);
    if (!entity || !chunk.chunk_text) continue;
    records.push({ entityId: doc.entity_id, productLineKey: entity.productLineKey, text: chunk.chunk_text, sourceLabel: 'rag.document_chunk.chunk_text', documentKind: doc.document_kind });
  }
  records.push(...legacyRecords.map((r) => ({ ...r, documentKind: 'legacy_descr' })));
  log(`Scan pool: ${records.length} text records across ${entities.size} entities.`);

  // Pattern 1
  const parenthetical = detectParenthetical(records, entityTitleTokens);

  // Pattern 2 (skip anything already claimed by pattern 1 for the same alias/product line).
  // Restricted to product_line_profile + legacy descriptions: 'label' documents are legally
  // required multi-language (EN/FR/ES) text crammed into one blob regardless of the recorded
  // language_code, and their warning/directions boilerplate ("MODE D'EMPLOI", "NOTA", ...)
  // swamps this pattern with non-product noise far more than the other two patterns, which are
  // guarded by the initials/title-overlap and title-derivation checks respectively.
  const claimedKeys = new Set(parenthetical.map((c) => `${c.aliasNorm}::${c.productLineKey}`));
  const cooccurrenceRecords = records.filter((r) => r.documentKind !== 'label');
  const cooccurrence = detectCooccurrence(cooccurrenceRecords, entityTitleTokens, claimedKeys, entities);

  // Pattern 3
  const recordsByEntity = new Map();
  for (const rec of records) {
    if (!recordsByEntity.has(rec.entityId)) recordsByEntity.set(rec.entityId, []);
    recordsByEntity.get(rec.entityId).push(rec);
  }
  const nounPhrase = detectNounPhraseVariants(entities, recordsByEntity);

  const allCandidates = [...parenthetical, ...cooccurrence, ...nounPhrase];

  // De-dupe across patterns/records on (alias_norm, product_line_key), keeping the
  // highest-confidence candidate for any pair that collides.
  const bestByKey = new Map();
  for (const c of allCandidates) {
    const key = `${c.aliasNorm}::${c.productLineKey}`;
    const current = bestByKey.get(key);
    if (!current || c.confidence > current.confidence) bestByKey.set(key, c);
  }
  let deduped = [...bestByKey.values()];

  // Drop aliases mined for more than one product line. resolveProductEntityByName only
  // resolves an ambiguous alias_norm when exactly one candidate line is verified, and these
  // all land unverified — so a multi-line mined alias can never resolve, and would only add
  // review-queue noise (e.g. "Demo Kits" derived from six unrelated catalog lines).
  const linesPerAlias = new Map();
  for (const c of deduped) {
    if (!linesPerAlias.has(c.aliasNorm)) linesPerAlias.set(c.aliasNorm, new Set());
    linesPerAlias.get(c.aliasNorm).add(c.productLineKey);
  }
  const ambiguous = deduped.filter((c) => linesPerAlias.get(c.aliasNorm).size > 1);
  deduped = deduped.filter((c) => linesPerAlias.get(c.aliasNorm).size === 1);
  if (ambiguous.length > 0) {
    const names = [...new Set(ambiguous.map((c) => c.alias))];
    log(`Dropped ${ambiguous.length} candidate(s) spanning ${names.length} ambiguous alias(es): ${names.slice(0, 15).join(', ')}${names.length > 15 ? ', ...' : ''}`);
  }

  // An alias identical to a name the resolver already has for the same line adds nothing.
  deduped = deduped.filter((c) => {
    const entity = entities.get(c.entityId);
    return !entity || normalizeAlias(entity.title) !== c.aliasNorm;
  });

  log('');
  log(`=== Candidate summary (${deduped.length} unique alias/product-line pairs; ${allCandidates.length} raw hits) ===`);
  summarize(deduped);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(deduped, null, 2));
    log(`Wrote ${deduped.length} candidates to ${JSON_OUT}`);
  }

  if (DRY_RUN) {
    log('');
    log('Dry run: no rows written.');
    return;
  }

  log('');
  log('Writing candidates to rag.product_alias...');
  const { inserted, updated, skippedProtected } = await safeUpsertCandidates(deduped);
  log(`  inserted=${inserted}  updated=${updated}  skipped_protected=${skippedProtected}`);
  log('Done.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
