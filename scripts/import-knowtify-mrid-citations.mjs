/**
 * B0-1142 — Import EPA MRID (Master Record Identification) study citations from a
 * Knowtify (app.knowtify.net) CSV export and attach them to the matching per-organism
 * rows already in rag.product_efficacy.
 *
 * Knowtify is EPA's own MRID study index. It has no public API — browser search + CSV
 * export only — so this script's input is a human-exported CSV (default: the committed
 * fixture at scripts/fixtures/knowtify-mrid-betco-sample.csv; real usage passes a path
 * to a live export as argv[2]).
 *
 * Dry-run by default. Nothing is written without --write.
 *
 * WHY MATCHING IS CONSERVATIVE (no guessing)
 * -------------------------------------------
 * The point of this ticket is defensible regulatory provenance: a wrong MRID-to-claim
 * link would attach the wrong EPA study to a kill claim, which is worse than no citation
 * at all. So a row is only written when BOTH of these resolve to exactly one candidate:
 *   1. the trade/product name parsed from the MRID `Description` resolves to exactly one
 *      rag.entity via a *verified* rag.product_alias (unverified aliases are never
 *      trusted for resolution — same rule as scripts/backfill-efficacy-entity-links.mjs);
 *   2. that entity's existing rag.product_efficacy rows contain exactly one organism
 *      matching (case-insensitively, ATCC/strain-tolerant) one of the organisms parsed
 *      from the Description.
 * Zero or multiple candidates at either step is reported as unmatched, never guessed.
 * Many legacy-era trade names (Bol Maid, Pull, Kling, Sure Bet, Forest 5, Quat-Stat,
 * OxyFect-H / Green Earth Peroxide Cleaner) are EXPECTED to come back unmatched today —
 * either because no verified alias exists for them yet, or because the alias is
 * ambiguous (e.g. "Green Earth" matches three distinct GREEN EARTH product lines). That
 * is the correct, honest outcome; adding an alias to force a match is out of scope here.
 *
 * STUDY-TYPE CLASSIFICATION (guideline-code prefix rule)
 * --------------------------------------------------------
 * Applied per code in `MRID Guidelines` (semicolon- AND newline-joined in this fixture —
 * a real Knowtify export renders multi-value cells as newline-separated lines, this
 * fixture flattens them with ';'; both are tolerated). A row's study_type is 'efficacy'
 * if ANY of its codes classify as efficacy:
 *   - 810.2000 / 810.2100 / 810.2200 / 810.2300 (EPA guidance 810.2xxx series),
 *     legacy 91-2, legacy 93-12 (EPA fungistatic test)        -> efficacy
 *   - 830.*  and legacy 6x-x forms (61-2, 61-3, 62-2, 62-3,
 *     63-0, 63-14, 63-17, 63-20)                               -> chemistry
 *   - 870.*  and legacy 8x-x forms (81-1 .. 81-6)               -> toxicology
 *   - anything else, including a blank/missing guideline        -> other
 * Only 'efficacy' rows are matched against rag.product_efficacy; chemistry/toxicology/
 * other rows are counted but never organism-matched (several legacy-era rows with no
 * guideline code at all — e.g. the 1993-1995 Bol Maid / Pull / Kling / Sure Bet studies —
 * fall into 'other' for this reason, not because of a failed trade-name match).
 *
 * ORGANISM / TRADE-NAME PARSING
 * -------------------------------
 * Descriptions follow a handful of observed shapes:
 *   - "AOAC Use-Dilution Method: <organism> (<strain>): <trade name>: Final ..."
 *   - "Virucidal Efficacy ... : <organism>: <trade name>: Final Report"
 *   - "EPA Hard Surface Mildew-Fungistatic Test: <organism> (<strain>): <trade name>: ..."
 *   - free-text legacy style (1993-1995): "The Evaluation of the Efficacy of ... Against
 *     <org1>, <org2> and <org3> ...: <trade name>: ..." — a comma/and-joined organism
 *     LIST, matched against ANY of the three for the same resolved product.
 * The organism segment's parenthetical ATCC/strain suffix (e.g. "(ATCC 19606)") is
 * captured separately and stripped before matching — it is never required for a match,
 * since rag.product_efficacy stores organism names without it.
 *
 * IDEMPOTENCY
 * -----------
 * Writes are a plain `UPDATE rag.product_efficacy SET ... WHERE id = $1` on the matched
 * row's primary key — no inserts anywhere — so re-running with --write against a row
 * that already carries the same mrid_number is a no-op rewrite, never a duplicate.
 *
 * Usage:
 *   node --env-file=.env.local scripts/import-knowtify-mrid-citations.mjs                 # dry run, fixture
 *   node --env-file=.env.local scripts/import-knowtify-mrid-citations.mjs path/to.csv      # dry run, explicit file
 *   node --env-file=.env.local scripts/import-knowtify-mrid-citations.mjs path/to.csv --write
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// ── Load .env.local (same pattern as scripts/backfill-efficacy-entity-links.mjs) ─────
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
const cliArgs = process.argv.slice(2).filter((a) => a !== '--write');
const CSV_PATH = cliArgs[0] ?? new URL('./fixtures/knowtify-mrid-betco-sample.csv', import.meta.url).pathname;

function log(msg) {
  console.log(msg);
}

// ── CSV parsing (RFC4180-ish: quoted fields, embedded commas, embedded newlines) ─────
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  // Normalize CRLF so embedded \r doesn't leak into values.
  const s = text.replace(/\r\n/g, '\n');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  // Trailing field/row (file may or may not end with a newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function loadRows(csvPath) {
  const text = readFileSync(csvPath, 'utf-8');
  const table = parseCsv(text);
  const header = table[0];
  return table.slice(1).map((cells) => {
    const obj = {};
    header.forEach((h, idx) => {
      obj[h.trim()] = (cells[idx] ?? '').trim();
    });
    return obj;
  });
}

/** Multi-value cells are both ';'-joined (this fixture) and could be newline-joined
 * (a real Knowtify export) — tolerate both, trim, drop empties. */
function splitMultiValue(cell) {
  if (!cell) return [];
  return cell
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Study-type classification ────────────────────────────────────────────────────────
function classifyGuidelineCode(code) {
  const c = code.trim();
  if (!c) return 'other';
  if (/^810\.2[0123]00/.test(c)) return 'efficacy';
  if (c === '91-2' || c === '93-12') return 'efficacy';
  if (/^830\./.test(c)) return 'chemistry';
  if (['61-2', '61-3', '62-2', '62-3', '63-0', '63-14', '63-17', '63-20'].includes(c)) return 'chemistry';
  if (/^870\./.test(c)) return 'toxicology';
  if (/^81-[1-6]$/.test(c)) return 'toxicology';
  return 'other';
}

function classifyStudyType(guidelineCodes) {
  if (guidelineCodes.length === 0) return 'other';
  const types = new Set(guidelineCodes.map(classifyGuidelineCode));
  if (types.has('efficacy')) return 'efficacy';
  if (types.size === 1) return [...types][0];
  // Mixed non-efficacy codes on one row: report the set rather than silently picking one.
  return [...types].sort().join('+');
}

// ── Description parsing ──────────────────────────────────────────────────────────────
/**
 * Strips a trailing parenthetical ATCC/strain code from an organism token, e.g.
 * "Acinetobacter baumannii (ATCC 19606)" -> { organism: "Acinetobacter baumannii",
 * strain: "ATCC 19606" }. Strain is captured for the report only; never required to match.
 */
function splitOrganismStrain(token) {
  const m = token.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (m) return { organism: m[1].trim(), strain: m[2].trim() };
  return { organism: token.trim(), strain: null };
}

/**
 * Parses one Description string into { organisms: string[], tradeName: string|null }.
 *
 * Observed colon-delimited shape (modern, 1996-2026), with or without a leading
 * "<Test name>:" segment — both are seen in the fixture:
 *   "<Author>. (<Year>) [<Test name>: ]<organism>[ (<strain>)]: <trade name>: Final [Study] Report..."
 * Rather than assuming a fixed segment INDEX (which breaks whenever the "<Test name>:"
 * prefix segment is absent — e.g. "Community Acquired MRSA (...): OxyFect-H: Final
 * Report..." has no separate test-name segment), this anchors on the "Final [Study]
 * Report" segment, which is present in every modern-shape row observed, and reads
 * backwards from there: the segment immediately before it is the trade name, and the
 * one before THAT is the organism. A description with fewer than 2 segments ahead of
 * the "Final Report" marker (e.g. a report whose organism is only named in prose, not
 * as its own colon segment) is reported as unparseable rather than guessed.
 *
 * Organism names occasionally carry their own embedded colon (e.g. the E. coli
 * serotype notation "O157:H7"), which would otherwise be mistaken for a segment
 * boundary — that specific pattern is protected before splitting and restored after.
 *
 * Legacy free-text shape (1993-1995, "The Evaluation of the Efficacy..."):
 *   "... Against <org1>, <org2> and <org3> in the Presence of ...: <trade name>[ (<paren>)]: ..."
 * Here the organism list is comma/and-joined prose between "Against" and the next
 * sentence boundary, and the trade name is the colon-delimited chunk right after it
 * (sometimes itself wrapped in its own parens, e.g. "Product (Kling)").
 */
function parseDescription(description) {
  const legacyMatch = description.match(/Against\s+(.+?)\s+in the Presence of/i);
  if (legacyMatch) {
    const listText = legacyMatch[1];
    const organisms = listText
      .split(/,| and /i)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => splitOrganismStrain(s).organism);

    // Trade name: the colon-delimited segment that follows "...Presence of ... Load:"
    // e.g. "...5% Soil Load: Bol Maid: Lab Project..." or "...Product (Kling): Lab Project..."
    const afterLoad = description.split(/Soil Load/i)[1] ?? '';
    const segments = afterLoad
      .split(':')
      .map((s) => s.trim())
      .filter(Boolean);
    let tradeName = segments[0] ?? null;
    if (tradeName) {
      // "Betco Corporation's Pull Disinfectant Toilet Bowl/Urinal Cleaner" or a bare
      // "(Kling)" parenthetical embedded in the preceding prose — prefer an explicit
      // parenthetical trade name if the segment carries one, else use the segment itself.
      const parenMatch = description.match(/Product \(([^)]+)\)/i);
      if (parenMatch) tradeName = parenMatch[1].trim();
    }
    return { organisms, tradeName, shape: 'legacy_freetext' };
  }

  // Modern colon-delimited shape. Strip the leading "Author, I. (Year) " citation prefix.
  const withoutByline = description.replace(/^[^(]*\(\d{4}\)\s*/, '');

  // Protect organism serotype notation that embeds its own colon (e.g. "O157:H7") so it
  // is never mistaken for a segment boundary.
  const PROTECT = '\u0001';
  const protectedText = withoutByline.replace(/(\bO\d+):(H\d+\b)/gi, `$1${PROTECT}$2`);
  const segments = protectedText
    .split(':')
    .map((s) => s.replace(new RegExp(PROTECT, 'g'), ':').trim());

  // Anchor on the "Final [Study] Report" segment rather than a fixed index — the
  // leading "<Test name>:" segment is sometimes absent (see function doc comment).
  const finalIdx = segments.findIndex((s) => /final(\s+study)?\s+report/i.test(s));
  if (finalIdx < 2) {
    return { organisms: [], tradeName: null, shape: 'unrecognized' };
  }
  const tradeName = segments[finalIdx - 1] || null;
  const { organism } = splitOrganismStrain(segments[finalIdx - 2] ?? '');
  return { organisms: organism ? [organism] : [], tradeName, shape: 'modern_colon_delimited' };
}

// ── Organism matching (tolerant of punctuation/case, not of substance) ──────────────
function normalizeOrganism(s) {
  return String(s)
    .toLowerCase()
    .replace(/[²¹]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function organismsMatch(parsed, stored) {
  const a = normalizeOrganism(parsed);
  const b = normalizeOrganism(stored);
  if (!a || !b) return false;
  return a === b || b.startsWith(a) || a.startsWith(b);
}

// ── Trade-name -> entity resolution via verified rag.product_alias ─────────────────
function normalizeName(s) {
  return String(s)
    .toLowerCase()
    .replace(/[™®]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolveTradeName(tradeName, aliasRows) {
  if (!tradeName) return { candidates: [], matchedAliases: [] };
  const n = normalizeName(tradeName);
  if (!n) return { candidates: [], matchedAliases: [] };
  const matched = aliasRows.filter((a) => {
    const an = normalizeName(a.alias);
    if (!an) return false;
    return an === n || n.includes(an) || an.includes(n);
  });
  const entityIds = [...new Set(matched.map((a) => a.entity_id))];
  return { candidates: entityIds, matchedAliases: matched };
}

// ── Date parsing (M/D/YYYY -> ISO date, verbatim — never inferred) ─────────────────
function toIsoDate(mdY) {
  const m = mdY.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────────
async function loadVerifiedAliases() {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .schema('rag')
      .from('product_alias')
      .select('id, alias, alias_norm, entity_id, verified')
      .eq('verified', true)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load product_alias: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function loadEfficacyRowsForEntity(entityId) {
  const { data, error } = await supabase
    .schema('rag')
    .from('product_efficacy')
    .select('id, entity_id, organism, mrid_number')
    .eq('entity_id', entityId);
  if (error) throw new Error(`load product_efficacy for ${entityId}: ${error.message}`);
  return data ?? [];
}

async function main() {
  log(`\nB0-1142 Knowtify MRID citation import — ${WRITE ? 'WRITE' : 'DRY RUN (no changes)'}`);
  log(`Source CSV: ${CSV_PATH}\n`);

  const rows = loadRows(CSV_PATH);
  log(`Loaded ${rows.length} MRID rows from CSV.`);

  const aliasRows = await loadVerifiedAliases();
  log(`Loaded ${aliasRows.length} verified rag.product_alias rows.\n`);

  const byStudyType = new Map();
  const matched = [];
  const unmatched = [];

  // Cache efficacy rows per entity_id to avoid refetching for repeated trade names.
  const efficacyCache = new Map();

  for (const row of rows) {
    const guidelineCodes = splitMultiValue(row['MRID Guidelines']);
    const studyType = classifyStudyType(guidelineCodes);
    byStudyType.set(studyType, (byStudyType.get(studyType) ?? 0) + 1);

    if (studyType !== 'efficacy') continue;

    const mrid = row['MRID'];
    const description = row['Description'] ?? '';
    const { organisms, tradeName, shape } = parseDescription(description);
    const studyDate = toIsoDate(row['Study Date'] ?? '');
    const lab = row['Laboratory Name'] || null;
    const guidelineCodeRaw = (row['MRID Guidelines'] ?? '').trim() || null;

    const base = { mrid, description, organisms, tradeName, shape, studyDate, lab, guidelineCodeRaw };

    if (!tradeName || organisms.length === 0) {
      unmatched.push({ ...base, reason: 'unparseable_description', detail: 'Could not extract both an organism and a trade name from the Description field.' });
      continue;
    }

    const { candidates, matchedAliases } = resolveTradeName(tradeName, aliasRows);
    if (candidates.length === 0) {
      unmatched.push({ ...base, reason: 'no_verified_alias_for_trade_name', detail: `No verified rag.product_alias matches trade name "${tradeName}".` });
      continue;
    }
    if (candidates.length > 1) {
      unmatched.push({
        ...base,
        reason: 'ambiguous_alias_match',
        detail: `Trade name "${tradeName}" matches ${candidates.length} distinct entities via verified aliases: ${[...new Set(matchedAliases.map((a) => `${a.alias} -> ${a.entity_id}`))].join('; ')}.`,
      });
      continue;
    }

    const entityId = candidates[0];
    if (!efficacyCache.has(entityId)) {
      efficacyCache.set(entityId, await loadEfficacyRowsForEntity(entityId));
    }
    const efficacyRows = efficacyCache.get(entityId);

    // Candidate product_efficacy rows: any row whose organism matches ANY parsed organism.
    const candidateRows = efficacyRows.filter((er) => organisms.some((o) => organismsMatch(o, er.organism)));

    if (candidateRows.length === 0) {
      unmatched.push({
        ...base,
        reason: 'no_matching_organism_row',
        detail: `Trade name resolved to entity ${entityId}, but none of its ${efficacyRows.length} rag.product_efficacy rows match organism(s): ${organisms.join(', ')}.`,
        entityId,
      });
      continue;
    }
    if (candidateRows.length > 1) {
      unmatched.push({
        ...base,
        reason: 'ambiguous_organism_match',
        detail: `Trade name resolved to entity ${entityId}, but ${candidateRows.length} of its rag.product_efficacy rows match organism(s) ${organisms.join(', ')}: ${candidateRows.map((r) => `${r.id} (${r.organism})`).join('; ')}.`,
        entityId,
      });
      continue;
    }

    const target = candidateRows[0];
    matched.push({ ...base, entityId, productEfficacyId: target.id, matchedOrganism: target.organism });
  }

  // ── Report ──────────────────────────────────────────────────────────────────────
  log('── Rows by study_type ────────────────────────────────────');
  for (const [type, count] of [...byStudyType.entries()].sort((a, b) => b[1] - a[1])) {
    log(`  ${String(count).padStart(4)}  ${type}`);
  }
  log(`  ${String(rows.length).padStart(4)}  TOTAL\n`);

  log(`── Efficacy rows: matched ${matched.length}, unmatched ${unmatched.length} ──\n`);

  if (matched.length) {
    log('── Matched (MRID -> rag.product_efficacy row) ─────────────');
    for (const m of matched) {
      log(
        `  MRID ${m.mrid} -> product_efficacy ${m.productEfficacyId} (organism "${m.matchedOrganism}", entity ${m.entityId})\n` +
          `      trade name: "${m.tradeName}"  guideline(s): ${m.guidelineCodeRaw ?? '(none)'}  study_date: ${m.studyDate ?? '(unparsed)'}  lab: ${m.lab ?? '(none)'}`,
      );
    }
    log('');
  }

  if (unmatched.length) {
    log('── Unmatched (full list, not truncated) ────────────────────');
    const byReason = new Map();
    for (const u of unmatched) byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1);
    for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      log(`  ${String(count).padStart(4)}  ${reason}`);
    }
    log('');
    for (const u of unmatched) {
      log(`  MRID ${u.mrid} [${u.reason}]`);
      log(`      trade name: "${u.tradeName ?? '(none)'}"  organism(s): ${u.organisms.join(', ') || '(none)'}`);
      log(`      ${u.detail}`);
    }
    log('');
  }

  if (!WRITE) {
    log('DRY RUN — no changes written, re-run with --write to persist.\n');
    return;
  }

  // ── Write ─────────────────────────────────────────────────────────────────────
  let updated = 0;
  for (const m of matched) {
    const { error } = await supabase
      .schema('rag')
      .from('product_efficacy')
      .update({
        mrid_number: m.mrid,
        study_date: m.studyDate,
        laboratory_name: m.lab,
        guideline_code: m.guidelineCodeRaw,
      })
      .eq('id', m.productEfficacyId);
    if (error) throw new Error(`update product_efficacy ${m.productEfficacyId}: ${error.message}`);
    updated += 1;
  }
  log(`Updated ${updated} rag.product_efficacy rows with MRID citations.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
