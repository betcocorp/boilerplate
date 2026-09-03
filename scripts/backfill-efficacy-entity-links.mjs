/**
 * B0-232 — Populate the efficacy formula<->product crosswalk and link efficacy
 * documents to their product_line rag.entity.
 *
 * Dry-run by default. Nothing is written without --write.
 *
 * WHY THIS IS DERIVABLE WITHOUT THE (STILL UNDELIVERED) MASTER SKU MAPPING
 * ----------------------------------------------------------------------
 * The ticket is nominally blocked on "the SKU-per-efficacy-sheet mapping the
 * team is building". That mapping is still not delivered — and the closest
 * artefact we do have, src/lib/training/efficacy-version-table.csv/.json
 * (B0-223, extracted from "Master Efficacy Version Data.xlsx"), carries a
 * `product_sku` column that is EMPTY IN ALL 68 ROWS. So the sheet cannot
 * supply formula->SKU today.
 *
 * However every efficacy markdown document carries its own `formula code:`
 * frontmatter field, and rag.entity (product_line tier) carries the Betco
 * product code at metadata->>'prod_line_id'. That is enough to resolve a
 * large, verifiable subset without guessing.
 *
 * RESOLUTION STRATEGIES (ordered, most confident first)
 * ----------------------------------------------------
 * S1 `product_code_exact`
 *     Scope: the product-code-keyed corpora only —
 *       efficacy/markdown/disinfectants/** and efficacy/markdown/legacy/**.
 *     Rule: the document's frontmatter `formula code` matches EXACTLY ONE
 *     product_line entity on upper(metadata->>'prod_line_id'), AND that entity
 *     carries a *verified* rag.product_alias equal to the code. The verified
 *     alias is the guard: it proves the code is a recognised product
 *     identifier for that entity rather than an incidental number collision
 *     (B0-696 — unverified aliases must never be trusted for resolution).
 *     Corroboration: where the document also carries a `product name`
 *     frontmatter field (the legacy corpus does), that name is checked against
 *     the entity's verified aliases and recorded in the report. At time of
 *     writing all 18 distinct legacy codes corroborate.
 *
 * S2 `m_formula_suffix_corroborated`
 *     Scope: the formula-keyed corpus, efficacy/markdown/hygiene-skin-care/**.
 *     Rule: formula code of the form M000<NNN> reduces to product code <NNN>,
 *     which must resolve to exactly one product_line entity with a verified
 *     code alias — AND that entity must ALREADY carry rag.product_efficacy
 *     rows from the B0-252 hand-hygiene ingestion. That last condition is what
 *     makes this a *confirmation* rather than a pattern guess: B0-252
 *     independently made the same formula->product_line association, and its
 *     per-organism contact times agree with the version table's
 *     current_version_efficacy_detail for the same formula.
 *
 * DELIBERATELY NOT LINKED (reported, never guessed)
 * ------------------------------------------------
 *   - `M000<NNN>` codes whose <NNN> resolves but has NO B0-252 corroboration
 *     (currently M000751). Pattern-only. Needs human confirmation.
 *   - `MCA0<NNN>` contract/co-pack codes. The version table treats these as
 *     DISTINCT formulations ("New Formulation") with their own current-version
 *     efficacy detail that DIFFERS from the base formula's, so they are not
 *     safe to fold into the base product line. They are emitted as candidate
 *     rag.efficacy_formula_alias lineage rows only under
 *     --include-candidate-aliases.
 *   - The 7 documents under
 *     "M000796 Efficacy Reports/Unused Formulas Efficacy/" whose frontmatter
 *     code is the bare "796". The folder states these are UNUSED formulations;
 *     attaching them to the live 796 product line would let Bex cite
 *     never-shipped formula test data as a current product claim. B0-224's
 *     enrichment script independently flagged this same frontmatter/folder
 *     mismatch.
 *   - efficacy/markdown/product-guides/** (7 docs) and efficacy/manifest/**
 *     (1 doc). These carry no `formula code` at all and are not lab efficacy
 *     reports — they are dispenser/application guides and our own B0-225
 *     reconciliation note, mis-filed under document_kind='efficacy'.
 *
 * Any code resolving to MORE THAN ONE product_line entity is left unlinked and
 * reported as ambiguous. A wrong efficacy link means Bex cites another
 * product's kill claims — a regulated-claim failure — so ambiguity always
 * loses.
 *
 * IDEMPOTENCY
 * -----------
 *   - rag.efficacy_formula_product upserts on the existing unique index
 *     efficacy_formula_product_identity_key
 *     (formula_code, coalesce(product_line_key,''), coalesce(sku,''), registrant_role).
 *   - rag.document.entity_id is only set where it is currently NULL or already
 *     equal to the resolved entity. A document already pointing at a DIFFERENT
 *     entity is never silently re-pointed — it is reported as a conflict.
 *   - Re-running after a successful --write is a no-op.
 *
 * Usage:
 *   node scripts/backfill-efficacy-entity-links.mjs              # dry run
 *   node scripts/backfill-efficacy-entity-links.mjs --write      # apply
 *   node scripts/backfill-efficacy-entity-links.mjs --write --include-candidate-aliases
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// ── Load .env.local (same pattern as scripts/import-test-csv.mjs) ────────────
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
const INCLUDE_CANDIDATE_ALIASES = process.argv.includes('--include-candidate-aliases');
/**
 * Opt-in. Every one of the 146 efficacy documents was bulk-inserted with
 * is_current = true, but the B0-224 enrichment already resolved real currency into
 * each document's own frontmatter — and 55 of the linked documents say
 * superseded / unused / never activated there. Until this is synced,
 * rag.get_current_efficacy_for_product() returns superseded lab reports as "current"
 * (24 of 25 product lines return more than one, worst case 14).
 *
 * Flipping it changes which lab report Bex cites for a regulated kill claim, so it is
 * deliberately NOT part of the default run — it wants its own review. Only explicit
 * `true`/`false` frontmatter is honoured; `UNKNOWN` is left untouched, never assumed.
 */
const SYNC_CURRENCY = process.argv.includes('--sync-currency');
/**
 * B0-796 — explicit alias for "don't pass --write". The script was already dry-run by
 * default, but the currency-reconciliation PLAN (see planEfficacyCurrencyReconciliation()
 * below) used to only get computed and logged inside the `if (WRITE)` branch, so there was no
 * way to preview it without also authorizing every OTHER write this script makes
 * (crosswalk rows, formula_code metadata stamps, document links). This flag doesn't
 * change behavior — the currency plan is now always computed and logged when
 * --sync-currency is passed — it just makes the invocation self-documenting for anyone
 * reviewing the plan before authorizing --write.
 */
const DRY_RUN = process.argv.includes('--dry-run');
const REPORT_PATH = new URL('../src/lib/training/efficacy-crosswalk-backfill-report.json', import.meta.url);

function log(msg) {
  console.log(msg);
}

// ── Frontmatter helpers ─────────────────────────────────────────────────────
/** Reads a single scalar frontmatter field from the converted markdown body. */
function frontmatterField(body, field) {
  if (typeof body !== 'string') return null;
  const re = new RegExp(`^${field}:[ \\t]*(.+)$`, 'im');
  const m = body.match(re);
  if (!m) return null;
  const raw = m[1].trim().replace(/^['"]|['"]$/g, '').trim();
  if (!raw || raw === 'null' || raw === 'UNKNOWN') return null;
  return raw;
}

/**
 * B0-796 — build the full is_current reconciliation plan for EVERY document_kind=
 * 'efficacy' row with a non-null entity_id, not just the docs this run's S1/S2
 * resolution strategies happen to resolve. `resolved` (the pre-existing --sync-
 * currency loop's scope) is producer of the crosswalk, not a description of every
 * already-linked document — a doc that fails to re-resolve this run (ambiguous code,
 * revoked alias, etc.) or was linked by some other mechanism entirely would silently
 * keep a stale is_current forever if the sync only ever looked at `resolved`.
 *
 * `docs` is every efficacy row already loaded by loadDocuments() (no entity_id filter
 * applied there) — this function does its own `entity_id` scoping.
 *
 * Honors the same true/false-only, never-guess-UNKNOWN rule as before: a doc whose
 * frontmatter `is current:` field is missing or literally "UNKNOWN" is reported as
 * skipped and never written.
 */
function planEfficacyCurrencyReconciliation(docs) {
  const plan = [];
  for (const doc of docs) {
    if (!doc.entity_id) continue; // AC scope: linked docs only.
    const raw = frontmatterField(doc.body_text, 'is current');
    if (raw !== 'true' && raw !== 'false') {
      plan.push({
        document_id: doc.id,
        title: doc.title,
        current_is_current: doc.is_current,
        frontmatter_value: 'UNKNOWN',
        action: 'skip_unknown',
      });
      continue;
    }
    const desired = raw === 'true';
    if (doc.is_current === desired) {
      plan.push({
        document_id: doc.id,
        title: doc.title,
        current_is_current: doc.is_current,
        frontmatter_value: raw,
        action: 'no_op',
      });
      continue;
    }
    plan.push({
      document_id: doc.id,
      title: doc.title,
      current_is_current: doc.is_current,
      frontmatter_value: raw,
      desired_is_current: desired,
      action: doc.is_current ? 'true_to_false' : 'false_to_true',
    });
  }
  return plan;
}

/** Logs every row of the plan plus the summary counts the ticket asks for. */
function logEfficacyCurrencyPlan(plan) {
  log('\n── is_current reconciliation plan (B0-796, entity_id non-null efficacy docs) ──');
  for (const row of plan) {
    log(
      `  [${row.action}] ${row.document_id} "${row.title}" ` +
        `live_is_current=${row.current_is_current} frontmatter="${row.frontmatter_value}"` +
        (row.action.includes('_to_') ? ` -> desired=${row.desired_is_current}` : ''),
    );
  }
  const counts = plan.reduce((acc, row) => {
    acc[row.action] = (acc[row.action] ?? 0) + 1;
    return acc;
  }, {});
  log('\n── Summary ──');
  log(`  true_to_false : ${counts.true_to_false ?? 0}`);
  log(`  false_to_true : ${counts.false_to_true ?? 0}`);
  log(`  no_op         : ${counts.no_op ?? 0}`);
  log(`  skip_unknown  : ${counts.skip_unknown ?? 0}`);
  log(`  TOTAL         : ${plan.length}`);
}

/** Applies the flips in `plan` (true_to_false / false_to_true only). Never called unless --write. */
async function applyEfficacyCurrencyReconciliation(plan) {
  let flipped = 0;
  for (const row of plan) {
    if (row.action !== 'true_to_false' && row.action !== 'false_to_true') continue;
    const { error } = await supabase
      .schema('rag')
      .from('document')
      .update({ is_current: row.desired_is_current })
      .eq('id', row.document_id);
    if (error) throw new Error(`sync is_current on ${row.document_id}: ${error.message}`);
    flipped += 1;
  }
  log(`\nSynced is_current on ${flipped} efficacy documents.`);
}

function tierOf(s3Key) {
  if (!s3Key) return 'unknown';
  if (s3Key.includes('/Unused Formulas Efficacy/')) return 'hygiene-unused';
  if (s3Key.startsWith('efficacy/markdown/disinfectants/')) return 'disinfectants';
  if (s3Key.startsWith('efficacy/markdown/legacy/')) return 'legacy';
  if (s3Key.startsWith('efficacy/markdown/hygiene-skin-care/')) return 'hygiene';
  if (s3Key.startsWith('efficacy/markdown/product-guides/')) return 'product-guides';
  return 'other';
}

/** Loose comparison for corroborating a doc's product name against an alias. */
function normalizeName(s) {
  return String(s)
    .toLowerCase()
    .replace(/[™®]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function nameCorroborates(productName, aliases) {
  if (!productName) return null;
  const n = normalizeName(productName);
  if (!n) return null;
  for (const a of aliases) {
    const an = normalizeName(a);
    if (!an) continue;
    if (an === n || an.includes(n) || n.includes(an)) return a;
  }
  return null;
}

// ── Load live data ──────────────────────────────────────────────────────────
async function loadDocuments() {
  const { data, error } = await supabase
    .schema('rag')
    .from('document')
    .select('id, document_key, title, entity_id, is_current, metadata, body_text')
    .eq('document_kind', 'efficacy');
  if (error) throw new Error(`load documents: ${error.message}`);
  return data ?? [];
}

async function loadProductLineEntities() {
  // PostgREST db-max-rows is 1000 and there are >1700 product_line entities, so
  // an unpaginated select silently truncates and manufactures phantom
  // "code not in entity table" misses. Always page.
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .schema('rag')
      .from('entity')
      .select('id, title, product_line_key, metadata')
      .eq('entity_type', 'product_line')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load entities: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function loadVerifiedAliases() {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .schema('rag')
      .from('product_alias')
      .select('id, alias, entity_id, verified')
      .eq('verified', true)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load aliases: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function loadB0252CorroboratedEntityIds() {
  const { data, error } = await supabase.schema('rag').from('product_efficacy').select('entity_id');
  if (error) throw new Error(`load product_efficacy: ${error.message}`);
  return new Set((data ?? []).map((r) => r.entity_id));
}

// ── Resolution ──────────────────────────────────────────────────────────────
function buildCodeIndex(entities, aliasesByEntity) {
  // code -> [entity, ...]; only entities carrying a *verified* alias equal to
  // their own product code qualify (B0-696).
  const index = new Map();
  for (const e of entities) {
    const code = e.metadata?.prod_line_id;
    if (!code) continue;
    const key = String(code).toUpperCase();
    const aliases = aliasesByEntity.get(e.id) ?? [];
    const hasVerifiedCodeAlias = aliases.some((a) => String(a).trim().toUpperCase() === key);
    if (!hasVerifiedCodeAlias) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(e);
  }
  return index;
}

function resolve(docs, codeIndex, aliasesByEntity, corroboratedEntityIds) {
  const resolved = [];
  const unmatched = [];

  for (const doc of docs) {
    const s3Key = doc.metadata?.s3_key ?? null;
    const tier = tierOf(s3Key);
    const fcode = frontmatterField(doc.body_text, 'formula code');
    const pname = frontmatterField(doc.body_text, 'product name');
    const base = {
      document_id: doc.id,
      document_key: doc.document_key,
      title: doc.title,
      s3_key: s3Key,
      tier,
      formula_code: fcode,
      product_name: pname,
      current_entity_id: doc.entity_id,
    };

    if (tier === 'product-guides' || tier === 'other' || tier === 'unknown') {
      unmatched.push({
        ...base,
        reason: 'not_an_efficacy_report',
        detail:
          'No `formula code` frontmatter; this is a product/application guide or the B0-225 reconciliation note mis-filed under document_kind=efficacy. It should be re-kinded, not linked.',
        resolves_with: 'Re-classify document_kind away from "efficacy" (separate ticket).',
      });
      continue;
    }

    if (!fcode) {
      unmatched.push({
        ...base,
        reason: 'no_formula_code',
        detail: 'Document body carries no `formula code:` frontmatter field.',
        resolves_with: 'Master sheet must state the formula code for this report.',
      });
      continue;
    }

    if (tier === 'hygiene-unused') {
      unmatched.push({
        ...base,
        reason: 'unused_formula_excluded',
        detail:
          'Filed under "Unused Formulas Efficacy/" — a formulation that was never shipped. Its frontmatter code is the bare "796" while the enclosing formula folder is M000796 (the same mismatch B0-224 flagged). Linking it to the live 796 product line would let Bex cite never-shipped test data as a current claim.',
        resolves_with:
          'Master sheet must state, per report, whether the unused-formula panel supports any shipping SKU. If none do, these should be excluded from retrieval entirely.',
      });
      continue;
    }

    const code = fcode.toUpperCase();

    // S1 — product-code-keyed corpora.
    if (tier === 'disinfectants' || tier === 'legacy') {
      const candidates = codeIndex.get(code) ?? [];
      if (candidates.length === 1) {
        const e = candidates[0];
        const corroboratingAlias = nameCorroborates(pname, aliasesByEntity.get(e.id) ?? []);
        resolved.push({
          ...base,
          strategy: 'product_code_exact',
          entity_id: e.id,
          entity_title: e.title,
          product_line_key: e.product_line_key,
          prod_line_id: e.metadata?.prod_line_id ?? null,
          name_corroborating_alias: corroboratingAlias,
        });
        continue;
      }
      unmatched.push({
        ...base,
        reason: candidates.length > 1 ? 'ambiguous_product_code' : 'product_code_not_in_entity_table',
        detail:
          candidates.length > 1
            ? `Code resolves to ${candidates.length} product_line entities: ${candidates
                .map((c) => `${c.id} (${c.title})`)
                .join('; ')}. Left unlinked on purpose.`
            : `No product_line entity has a verified alias for product code "${code}".`,
        resolves_with:
          candidates.length > 1
            ? 'Master sheet must name which product line this formula belongs to.'
            : `Confirm the Betco product code for formula "${code}", or add a verified product_alias for it.`,
      });
      continue;
    }

    // S2 — formula-keyed hygiene corpus.
    const mMatch = code.match(/^M0*(\d+)$/);
    const mcaMatch = code.match(/^MCA0*(\d+)$/);
    const suffix = mMatch ? mMatch[1] : mcaMatch ? mcaMatch[1] : null;

    if (mcaMatch) {
      unmatched.push({
        ...base,
        reason: 'mca_contract_formula',
        detail:
          'MCA-prefixed contract/co-pack formula. The B0-223 version table records MCA0795/MCA0796 as distinct "New Formulation" rows with their own current-version efficacy detail that differs from the base formula, so folding them into the base product line is not safe.',
        resolves_with:
          'Master sheet must state whether this MCA formula ships under the base formula\'s product line or its own, and confirm the shared lab panel actually covers it.',
      });
      continue;
    }

    if (!suffix) {
      unmatched.push({
        ...base,
        reason: 'unrecognised_formula_code_shape',
        detail: `Formula code "${code}" is neither a bare product code nor M000<NNN>/MCA0<NNN>.`,
        resolves_with: 'Master sheet must map this formula code to a product line.',
      });
      continue;
    }

    const candidates = codeIndex.get(suffix) ?? [];
    if (candidates.length !== 1) {
      unmatched.push({
        ...base,
        reason: candidates.length > 1 ? 'ambiguous_formula_suffix' : 'formula_suffix_not_in_entity_table',
        detail:
          candidates.length > 1
            ? `Suffix "${suffix}" resolves to ${candidates.length} product_line entities. Left unlinked on purpose.`
            : `No product_line entity has a verified alias for product code "${suffix}" (reduced from "${code}").`,
        resolves_with: `Master sheet must give the product line / SKU for formula "${code}".`,
      });
      continue;
    }

    const e = candidates[0];
    if (!corroboratedEntityIds.has(e.id)) {
      unmatched.push({
        ...base,
        reason: 'formula_suffix_uncorroborated',
        detail:
          `Formula "${code}" reduces to product code "${suffix}" which resolves to exactly one product_line ` +
          `(${e.id} — ${e.title}), but that entity has NO rag.product_efficacy rows from the B0-252 ingestion, ` +
          'so the M000<NNN> -> <NNN> reduction is unconfirmed for this formula. Pattern-only; not written.',
        resolves_with: `Confirm formula "${code}" belongs to product line "${suffix}" (${e.title}).`,
        candidate_entity_id: e.id,
        candidate_entity_title: e.title,
      });
      continue;
    }

    resolved.push({
      ...base,
      strategy: 'm_formula_suffix_corroborated',
      entity_id: e.id,
      entity_title: e.title,
      product_line_key: e.product_line_key,
      prod_line_id: e.metadata?.prod_line_id ?? null,
      name_corroborating_alias: nameCorroborates(pname, aliasesByEntity.get(e.id) ?? []),
    });
  }

  return { resolved, unmatched };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  log(`\nB0-232 efficacy crosswalk backfill — ${WRITE ? 'WRITE' : 'DRY RUN (no changes)'}\n`);

  const [docs, entities, aliasRows, corroboratedEntityIds] = await Promise.all([
    loadDocuments(),
    loadProductLineEntities(),
    loadVerifiedAliases(),
    loadB0252CorroboratedEntityIds(),
  ]);

  const aliasesByEntity = new Map();
  for (const r of aliasRows) {
    if (!r.entity_id) continue;
    if (!aliasesByEntity.has(r.entity_id)) aliasesByEntity.set(r.entity_id, []);
    aliasesByEntity.get(r.entity_id).push(r.alias);
  }

  log(
    `Loaded ${docs.length} efficacy documents, ${entities.length} product_line entities, ` +
      `${aliasRows.length} verified aliases, ${corroboratedEntityIds.size} B0-252-corroborated entities.`,
  );

  const codeIndex = buildCodeIndex(entities, aliasesByEntity);
  const { resolved, unmatched } = resolve(docs, codeIndex, aliasesByEntity, corroboratedEntityIds);

  // ── Per-strategy counts ───────────────────────────────────────────────────
  const byStrategy = new Map();
  for (const r of resolved) byStrategy.set(r.strategy, (byStrategy.get(r.strategy) ?? 0) + 1);
  log('\n── Resolved, by strategy ─────────────────────────────────');
  for (const [s, n] of [...byStrategy].sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(4)}  ${s}`);
  log(`  ${String(resolved.length).padStart(4)}  TOTAL RESOLVED`);

  const byReason = new Map();
  for (const u of unmatched) byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1);
  log('\n── Unmatched, by reason ──────────────────────────────────');
  for (const [s, n] of [...byReason].sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(4)}  ${s}`);
  log(`  ${String(unmatched.length).padStart(4)}  TOTAL UNMATCHED`);

  // ── Reviewable sample ─────────────────────────────────────────────────────
  log('\n── Sample of resolved links (review before --write) ──────');
  const sample = [];
  for (const strategy of byStrategy.keys()) {
    sample.push(...resolved.filter((r) => r.strategy === strategy).slice(0, 5));
  }
  for (const r of sample) {
    log(
      `  [${r.strategy}] formula ${r.formula_code} -> ${r.prod_line_id} "${r.entity_title}"\n` +
        `      doc: ${r.s3_key}\n` +
        `      entity_id=${r.entity_id} product_line_key=${r.product_line_key}` +
        (r.name_corroborating_alias ? `\n      name corroborated by verified alias: "${r.name_corroborating_alias}"` : ''),
    );
  }

  // ── Crosswalk rows (formula -> product_line), deduped ─────────────────────
  const crosswalk = new Map();
  for (const r of resolved) {
    if (!r.product_line_key) continue;
    const key = `${r.formula_code.toUpperCase()}::${r.product_line_key}`;
    if (crosswalk.has(key)) continue;
    crosswalk.set(key, {
      formula_code: r.formula_code.toUpperCase(),
      product_line_key: r.product_line_key,
      sku: null,
      registrant_role: 'primary',
      is_active: true,
      notes: `B0-232 backfill via ${r.strategy}; product code ${r.prod_line_id} (${r.entity_title}).`,
    });
  }
  log(`\n── Crosswalk rows to upsert: ${crosswalk.size}`);

  // ── Candidate MCA aliases (never written unless explicitly asked) ─────────
  const candidateAliases = [
    {
      mca_formula_code: 'MCA0795',
      base_formula_code: 'M000795',
      notes:
        'B0-232 CANDIDATE, human-confirm before trusting. Evidence: B0-223 version table records MCA0795 project A32791 as shared with M000795 v7/v4 and M000796 v6, filed under the base folder. The same table flags it "verify against PDF content before assuming equivalence" and records MCA0795 as its own "New Formulation".',
    },
    {
      mca_formula_code: 'MCA0796',
      base_formula_code: 'M000796',
      notes:
        'B0-232 CANDIDATE, human-confirm before trusting. Evidence: B0-223 version table records MCA0796 project A30211 as filed under M000796\'s folder (shared/combined lab panel), flagged CROSS_FORMULA_SHARED_REPORT "verify the shared report actually covers MCA0796".',
    },
  ];
  log(
    `── Candidate MCA formula aliases: ${candidateAliases.length} ` +
      `(${INCLUDE_CANDIDATE_ALIASES ? 'WILL be written' : 'NOT written — pass --include-candidate-aliases'})`,
  );

  // ── Document link plan, with conflict detection ───────────────────────────
  const toLink = [];
  const conflicts = [];
  for (const r of resolved) {
    if (r.current_entity_id && r.current_entity_id !== r.entity_id) {
      conflicts.push(r);
      continue;
    }
    if (r.current_entity_id === r.entity_id) continue; // already linked — idempotent no-op
    toLink.push(r);
  }
  log(`\n── Documents to link: ${toLink.length} (already correct: ${resolved.length - toLink.length - conflicts.length}, conflicts: ${conflicts.length})`);
  for (const c of conflicts) {
    log(`  CONFLICT ${c.s3_key}: currently ${c.current_entity_id}, resolved ${c.entity_id} — left untouched.`);
  }

  // ── is_current reconciliation plan (B0-796) ───────────────────────────────
  // Computed and logged whenever --sync-currency is passed, REGARDLESS of --write, so
  // the plan can be reviewed as a true dry run without also authorizing every other
  // write this script makes. See planEfficacyCurrencyReconciliation() for scope
  // (every entity_id-linked efficacy doc, not just `resolved` this run) and the
  // true/false-only, never-guess-UNKNOWN rule.
  const currencyPlan = SYNC_CURRENCY ? planEfficacyCurrencyReconciliation(docs) : [];
  if (SYNC_CURRENCY) {
    logEfficacyCurrencyPlan(currencyPlan);
    if (!WRITE) {
      log('\n(--sync-currency without --write: plan only, nothing written above.)');
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const report = {
    generated_at: new Date().toISOString(),
    ticket: 'B0-232',
    mode: WRITE ? 'write' : DRY_RUN ? 'dry-run (explicit)' : 'dry-run',
    totals: {
      efficacy_documents: docs.length,
      resolved: resolved.length,
      unmatched: unmatched.length,
      crosswalk_rows: crosswalk.size,
      documents_to_link: toLink.length,
      conflicts: conflicts.length,
    },
    resolved_by_strategy: Object.fromEntries(byStrategy),
    unmatched_by_reason: Object.fromEntries(byReason),
    master_sheet_gap: {
      summary:
        'The B0-223 version table (the only extract of "Master Efficacy Version Data.xlsx" we hold) has product_sku EMPTY in all 68 rows, so it cannot supply formula->SKU. Everything below needs the human-delivered mapping.',
      needed_columns: ['formula_code', 'product_line_key OR prod_line_id', 'sku', 'registrant_role (primary|sub)'],
      blocked_formula_codes: [...new Set(unmatched.filter((u) => u.formula_code).map((u) => u.formula_code))].sort(),
    },
    resolved_links: resolved,
    unmatched_report: unmatched,
    crosswalk_rows: [...crosswalk.values()],
    candidate_formula_aliases: candidateAliases,
    ...(SYNC_CURRENCY
      ? {
          currency_reconciliation_b0796: {
            scope: 'every document_kind=efficacy row with a non-null entity_id',
            plan: currencyPlan,
            totals: currencyPlan.reduce(
              (acc, row) => ({ ...acc, [row.action]: (acc[row.action] ?? 0) + 1 }),
              { true_to_false: 0, false_to_true: 0, no_op: 0, skip_unknown: 0 },
            ),
          },
        }
      : {}),
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(`\nReport written to src/lib/training/efficacy-crosswalk-backfill-report.json`);

  if (!WRITE) {
    log('\nDRY RUN — no database changes made. Re-run with --write to apply.\n');
    return;
  }

  // ── Write: crosswalk ──────────────────────────────────────────────────────
  const crosswalkRows = [...crosswalk.values()];
  if (crosswalkRows.length) {
    // The table's uniqueness is enforced by an EXPRESSION index
    // (efficacy_formula_product_identity_key, over COALESCE(product_line_key,'')
    // and COALESCE(sku,'')), which PostgREST's onConflict cannot target. Adding a
    // plain unique constraint instead would treat NULL skus as distinct and let
    // duplicates through, so read-then-insert the gap explicitly rather than
    // weakening the constraint.
    const { data: existing, error: exErr } = await supabase
      .schema('rag')
      .from('efficacy_formula_product')
      .select('formula_code, product_line_key, sku, registrant_role');
    if (exErr) throw new Error(`read efficacy_formula_product: ${exErr.message}`);
    const identity = (r) =>
      `${r.formula_code}::${r.product_line_key ?? ''}::${r.sku ?? ''}::${r.registrant_role}`;
    const seen = new Set((existing ?? []).map(identity));
    const toInsert = crosswalkRows.filter((r) => !seen.has(identity(r)));
    if (toInsert.length) {
      const { error } = await supabase.schema('rag').from('efficacy_formula_product').insert(toInsert);
      if (error) throw new Error(`insert efficacy_formula_product: ${error.message}`);
    }
    log(
      `rag.efficacy_formula_product: inserted ${toInsert.length}, ` +
        `already present ${crosswalkRows.length - toInsert.length}.`,
    );
  }

  // ── Write: candidate aliases (opt-in only) ────────────────────────────────
  if (INCLUDE_CANDIDATE_ALIASES && candidateAliases.length) {
    const { error } = await supabase
      .schema('rag')
      .from('efficacy_formula_alias')
      .upsert(candidateAliases, { onConflict: 'mca_formula_code' });
    if (error) throw new Error(`upsert efficacy_formula_alias: ${error.message}`);
    log(`Upserted ${candidateAliases.length} rag.efficacy_formula_alias rows.`);
  }

  // ── Write: document links ─────────────────────────────────────────────────
  let linked = 0;
  for (const r of toLink) {
    const { error } = await supabase
      .schema('rag')
      .from('document')
      .update({ entity_id: r.entity_id })
      .eq('id', r.document_id)
      .is('entity_id', null);
    if (error) throw new Error(`link document ${r.document_id}: ${error.message}`);
    linked += 1;
  }
  log(`Linked ${linked} efficacy documents to their product_line entity.`);

  // ── Write: stamp metadata.formula_code ────────────────────────────────────
  // rag.get_current_efficacy_for_product() joins the crosswalk on
  // `d.metadata ->> 'formula_code'`, but the efficacy documents only ever carried
  // s3_key/source/source_uri in metadata — the formula code lives in the markdown
  // frontmatter. Without this stamp the RPC returns zero rows for every product and
  // the whole crosswalk is inert, so the link is only half the job.
  //
  // Transcribed verbatim from each document's own `formula code:` frontmatter — never
  // normalised or inferred — and written ONLY for documents this run resolved, so the
  // deliberately-excluded sets (unused formulas, MCA contract formulas, uncorroborated
  // suffixes) stay out of the RPC's result rather than silently becoming citable.
  const docById = new Map(docs.map((d) => [d.id, d]));
  let stamped = 0;
  for (const r of resolved) {
    const doc = docById.get(r.document_id);
    if (!doc) continue;
    const metadata = doc.metadata ?? {};
    // Must be byte-identical to the crosswalk's formula_code or the RPC join silently
    // matches nothing. Every observed code is already upper-case, so this is a no-op
    // transcription rather than a normalisation; warn loudly if that ever stops holding.
    const stampValue = r.formula_code.toUpperCase();
    if (stampValue !== r.formula_code) {
      log(`  WARNING: formula code "${r.formula_code}" is not upper-case; stamping "${stampValue}".`);
    }
    if (metadata.formula_code === stampValue) continue; // idempotent no-op
    const { error } = await supabase
      .schema('rag')
      .from('document')
      .update({ metadata: { ...metadata, formula_code: stampValue } })
      .eq('id', r.document_id);
    if (error) throw new Error(`stamp formula_code on ${r.document_id}: ${error.message}`);
    stamped += 1;
  }
  log(`Stamped metadata.formula_code on ${stamped} efficacy documents.`);

  // ── Write: sync is_current from frontmatter (opt-in) ──────────────────────
  // B0-796: the plan was already computed and logged above (before the !WRITE early
  // return) so it is visible in a plain dry run too — this only APPLIES it, and only
  // for every entity_id-linked efficacy doc's plan row (not just `resolved` this run).
  if (SYNC_CURRENCY) {
    await applyEfficacyCurrencyReconciliation(currencyPlan);
  }
  log('\nDone.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
