#!/usr/bin/env node
/**
 * B0-464 — schema drift checker.
 *
 * Compares the LIVE Postgres catalog (rag + public) against the SQL text checked into
 * `src/supabase/migrations/`, and reports objects that exist live but are not accounted for by
 * any migration file.
 *
 * Why this exists: commit 59f118f1 (2026-05-22) added a `sectionType` parameter to
 * rag.match_corpus_chunks / match_corpus_chunks_hybrid / match_product_chunks /
 * match_product_chunks_hybrid on the live database, and no migration file was ever checked in.
 * The new overload coexisted with the old one (all-defaults on both sides), making every call
 * ambiguous to Postgres and driving the tool_failed rate from 0.6% to 45.6% for 11 days. Because
 * the DDL was never recorded in git, `git log` on migrations could not reconstruct what was live.
 *
 * Deliberately NOT filename-based. The live `supabase_migrations.schema_migrations` ledger and the
 * repo's migration directory are not reconcilable by name — `apply_migration` (MCP) stamps its own
 * version/name while `supabase db push` uses the filename, so neither side is a superset of the
 * other. This checker therefore compares actual catalog OBJECTS against migration SQL text.
 *
 * Checks
 *   [error] overload      — any rag/public function with more than one signature live
 *   [error] fn-missing    — a live function that no migration file actually CREATEs
 *   [error] fn-param      — a live function parameter named in no migration file that also names
 *                           the function (this is the exact 59f118f1 failure mode)
 *   [error] rel-missing   — a live table/view/matview that no migration file actually CREATEs
 *   [error] unapplied     — the REVERSE: a migration CREATEs an object that does not exist live,
 *                           i.e. the migration was never applied (see checkUnappliedMigrations)
 *   [warn]  col-missing   — a live column whose name appears in no migration file that also names
 *                           its table (warn: view columns are frequently only implied by SELECT *)
 *   [warn]  secdef        — a live SECURITY DEFINER function with no migration file declaring it
 *   [warn]  retired       — created by one migration and dropped by a later one; informational
 *
 * Usage
 *   node --env-file=.env.local scripts/check-schema-drift.mjs
 *   node --env-file=.env.local scripts/check-schema-drift.mjs --json
 *   node --env-file=.env.local scripts/check-schema-drift.mjs --warnings-as-errors
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (service role — the snapshot RPC is
 * granted to service_role only).
 *
 * Exit codes: 0 clean, 1 drift found, 2 could not run (missing env / RPC unavailable).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const MIGRATIONS_DIR = join(process.cwd(), 'src', 'supabase', 'migrations');
const SCHEMAS = ['rag', 'public'];

/**
 * Objects that legitimately exist live with no migration file, with the reason. Keep this list
 * short and justified — every entry is a hole in the check.
 */
const ALLOWLIST = new Set([
  // Supabase-managed / extension-owned objects land in public without our DDL.
  'rel:public.schema_migrations',
]);

/**
 * B0-464 — KNOWN pre-existing unapplied migrations, baselined so the CI gate is green for today's
 * state and fails the moment a NEW one appears. This is debt being recorded, not forgiven: the
 * count is printed on every run and `--no-baseline` reports them as the errors they are.
 *
 * These are NOT B0-464's to fix. Applying them is a real schema change on someone else's ticket,
 * and B0-283's sibling migration (`purge_out_of_scope_sds_documents_b0283`) deletes ~1,799
 * documents, so applying blind would be destructive. Each entry names its owning ticket.
 */
const BASELINE_UNAPPLIED = new Map([
  ['rag.document.source_lab', 'B0-238'],
  ['rag.document.project_number', 'B0-238'],
  ['rag.label', 'B0-256'],
  ['rag.label_chunk', 'B0-256'],
  ['rag.update_label_updated_at', 'B0-256'],
  ['rag.betco_active_products_for_labels', 'B0-258'],
  ['rag.out_of_scope_documents', 'B0-283'],
  ['rag.document.corpus_scope', 'B0-283'],
]);

const argv = new Set(process.argv.slice(2));
const asJson = argv.has('--json');
const warningsAsErrors = argv.has('--warnings-as-errors');
const useBaseline = !argv.has('--no-baseline');

function fail(message, code = 2) {
  console.error(`check-schema-drift: ${message}`);
  process.exit(code);
}

function loadMigrationCorpus() {
  let files;
  try {
    files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  } catch (err) {
    fail(`cannot read ${MIGRATIONS_DIR}: ${err.message}`);
  }
  if (files.length === 0) fail(`no .sql files in ${MIGRATIONS_DIR}`);

  return files.map((file) => ({
    file,
    // Lower-cased for matching; SQL identifiers here are all lower snake_case by convention.
    sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8').toLowerCase(),
  }));
}

/** Whole-identifier match, so `document` does not match `document_chunk`. */
function mentions(sql, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(sql);
}

function filesMentioning(corpus, identifier) {
  return corpus.filter((entry) => mentions(entry.sql, identifier));
}

/**
 * B0-464: fn-missing / rel-missing deliberately require a migration to actually CREATE the object,
 * not merely name it. Mentioning is not enough — that is how six live-only objects hid from the
 * first version of this checker: `public.set_updated_at()`,
 * `public.set_agent_message_feedback_updated_at()`, `rag.run_bulk_sds_heading_backfill()`,
 * `public.test_result_items`, `public.ai_suggestions` and `public.agent_message_feedback` were each
 * created live and thereafter only ALTERed (or merely listed in an RLS/lockdown loop) by committed
 * migrations, so a name-based check scored them as accounted for.
 *
 * The schema qualifier is optional because migrations legitimately lean on search_path, and
 * `or replace` / `if not exists` are optional for the same reason.
 */
function filesCreatingFunction(corpus, schema, name) {
  const pattern = new RegExp(
    `create\\s+(or\\s+replace\\s+)?(function|procedure)\\s+(${schema}\\s*\\.\\s*)?${name}\\s*\\(`,
    'i',
  );
  return corpus.filter((entry) => pattern.test(entry.sql));
}

function filesCreatingRelation(corpus, schema, name) {
  const pattern = new RegExp(
    `create\\s+(or\\s+replace\\s+)?(unlogged\\s+)?(materialized\\s+)?(table|view)\\s+` +
      `(if\\s+not\\s+exists\\s+)?(${schema}\\s*\\.\\s*)?${name}([^a-z0-9_]|$)`,
    'i',
  );
  return corpus.filter((entry) => pattern.test(entry.sql));
}

async function fetchSnapshot() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    fail('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (run with --env-file=.env.local)');
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await supabase.rpc('schema_drift_snapshot');
  if (error) {
    fail(`schema_drift_snapshot() failed: ${error.message}. Is migration 20260827_add_schema_drift_snapshot_rpc_b0464 applied?`);
  }
  if (!data || !Array.isArray(data.functions)) {
    fail('schema_drift_snapshot() returned an unexpected shape');
  }
  return data;
}

function checkFunctions(snapshot, corpus, findings) {
  const bySignature = new Map();
  for (const fn of snapshot.functions) {
    if (!SCHEMAS.includes(fn.schema)) continue;
    const qualified = `${fn.schema}.${fn.name}`;
    bySignature.set(qualified, (bySignature.get(qualified) ?? 0) + 1);
  }

  for (const [qualified, count] of bySignature) {
    if (count > 1) {
      findings.push({
        level: 'error',
        check: 'overload',
        object: qualified,
        detail: `${count} live signatures — CREATE OR REPLACE with a changed parameter list creates an overload instead of replacing. Use DROP FUNCTION then CREATE.`,
      });
    }
  }

  for (const fn of snapshot.functions) {
    if (!SCHEMAS.includes(fn.schema)) continue;
    const qualified = `${fn.schema}.${fn.name}`;
    if (ALLOWLIST.has(`fn:${qualified}`)) continue;

    if (filesCreatingFunction(corpus, fn.schema, fn.name).length === 0) {
      findings.push({
        level: 'error',
        check: 'fn-missing',
        object: `${qualified}(${fn.identity_args})`,
        detail: 'exists live but no migration file CREATEs it — DDL was applied without a checked-in migration.',
      });
      continue;
    }

    // Parameter and SECURITY DEFINER accounting is name-based on purpose: an added parameter can
    // legitimately be introduced by any migration that names the function (DROP+CREATE, a comment,
    // a grant), so requiring a CREATE here would produce false positives.
    const owning = filesMentioning(corpus, fn.name);
    const argNames = Array.isArray(fn.arg_names) ? fn.arg_names.filter(Boolean) : [];
    const unaccounted = argNames.filter(
      (arg) => !owning.some((entry) => mentions(entry.sql, arg)),
    );
    if (unaccounted.length > 0) {
      findings.push({
        level: 'error',
        check: 'fn-param',
        object: `${qualified}(${fn.identity_args})`,
        detail: `parameter(s) ${unaccounted.join(', ')} appear in no migration file that also names ${fn.name} — a live signature change with no migration (the 59f118f1 failure mode).`,
      });
    }

    if (fn.security_definer && !owning.some((entry) => mentions(entry.sql, 'security') && entry.sql.includes('definer'))) {
      findings.push({
        level: 'warn',
        check: 'secdef',
        object: qualified,
        detail: 'is SECURITY DEFINER live, but no migration file naming it declares SECURITY DEFINER.',
      });
    }
  }
}

function checkRelationsAndColumns(snapshot, corpus, findings) {
  const relationFiles = new Map();
  const relMissing = new Set();

  for (const rel of snapshot.relations) {
    if (!SCHEMAS.includes(rel.schema)) continue;
    const qualified = `${rel.schema}.${rel.name}`;
    if (ALLOWLIST.has(`rel:${qualified}`)) continue;

    // Column ownership stays name-based: a column can be added by any ALTER in any file.
    relationFiles.set(qualified, filesMentioning(corpus, rel.name));

    if (filesCreatingRelation(corpus, rel.schema, rel.name).length === 0) {
      relMissing.add(qualified);
      findings.push({
        level: 'error',
        check: 'rel-missing',
        object: qualified,
        detail: 'exists live but no migration file CREATEs it — only ALTERs/references are checked in.',
      });
    }
  }

  for (const col of snapshot.columns) {
    if (!SCHEMAS.includes(col.schema)) continue;
    const qualified = `${col.schema}.${col.table}`;
    const owning = relationFiles.get(qualified);
    // Already reported as rel-missing (or allowlisted); don't double-report every column too.
    if (!owning || owning.length === 0 || relMissing.has(qualified)) continue;
    if (ALLOWLIST.has(`col:${qualified}.${col.name}`)) continue;

    if (!owning.some((entry) => mentions(entry.sql, col.name))) {
      findings.push({
        level: 'warn',
        check: 'col-missing',
        object: `${qualified}.${col.name}`,
        detail: `${col.type} column appears in no migration file that also names ${col.table}.`,
      });
    }
  }
}

/**
 * B0-464 — the REVERSE direction: a migration file is checked in but its object never reached the
 * live database. Drift diverges both ways and the ticket asks for definitions that diverge from
 * "what the migration history implies", so a one-directional check is only half the audit.
 *
 * This class has bitten this repo repeatedly and is invisible to every check above, because those
 * only ever start from a live object. Found unapplied on 2026-08-27: `rag.label`, `rag.label_chunk`
 * and `rag.out_of_scope_documents` (files 20260725100000/101000/102000), plus
 * `rag.document.corpus_scope` and `rag.document.source_lab_project_number` — AGENTS.md documents
 * corpus_scope as though it were live, and a dilution pass (B0-264) planned against `rag.label`
 * before discovering the table does not exist.
 *
 * An object a later migration deliberately DROPs is retired, not unapplied, so it is reported
 * separately as informational rather than silently skipped.
 */
function checkUnappliedMigrations(snapshot, corpus, findings) {
  const liveRelations = new Set(snapshot.relations.map((r) => `${r.schema}.${r.name}`));
  const liveFunctions = new Set(snapshot.functions.map((f) => `${f.schema}.${f.name}`));
  const liveColumns = new Set(snapshot.columns.map((c) => `${c.schema}.${c.table}.${c.name}`));

  const declared = new Map(); // key -> {kind, qualified, file}
  const droppedLater = new Set();

  const relRe = /create\s+(?:or\s+replace\s+)?(?:unlogged\s+)?(?:materialized\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?(rag|public)\s*\.\s*([a-z0-9_]+)/gi;
  const fnRe = /create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+(rag|public)\s*\.\s*([a-z0-9_]+)\s*\(/gi;
  // Matches the ALTER TABLE head and captures the whole statement body, because one ALTER can
  // comma-chain several ADD COLUMNs (e.g. `add column a text, add column b text`) and catching
  // only the first would silently undercount exactly the drift this check exists to find.
  const alterRe = /alter\s+table\s+(?:if\s+exists\s+)?(rag|public)\s*\.\s*([a-z0-9_]+)([^;]*)/gi;
  const addColRe = /add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi;
  const dropRe = /drop\s+(?:table|view|materialized\s+view|function|procedure)\s+(?:if\s+exists\s+)?(rag|public)\s*\.\s*([a-z0-9_]+)/gi;
  const dropColRe = /alter\s+table\s+(?:if\s+exists\s+)?(rag|public)\s*\.\s*([a-z0-9_]+)\s+drop\s+column\s+(?:if\s+exists\s+)?([a-z0-9_]+)/gi;
  // A renamed column/table is retired under its OLD name, not unapplied — without this, every
  // rename reports as never-applied forever (e.g. test_results.report_markdown → .report, B0-453).
  const renameColRe = /alter\s+table\s+(?:if\s+exists\s+)?(rag|public)\s*\.\s*([a-z0-9_]+)\s+rename\s+column\s+(?:if\s+exists\s+)?([a-z0-9_]+)/gi;
  const renameRelRe = /alter\s+(?:table|view|materialized\s+view)\s+(?:if\s+exists\s+)?(rag|public)\s*\.\s*([a-z0-9_]+)\s+rename\s+to/gi;

  for (const entry of corpus) {
    for (const [, schema, name] of entry.sql.matchAll(relRe)) {
      const key = `rel:${schema}.${name}`;
      if (!declared.has(key)) declared.set(key, { kind: 'rel', qualified: `${schema}.${name}`, file: entry.file });
    }
    for (const [, schema, name] of entry.sql.matchAll(fnRe)) {
      const key = `fn:${schema}.${name}`;
      if (!declared.has(key)) declared.set(key, { kind: 'fn', qualified: `${schema}.${name}`, file: entry.file });
    }
    for (const [, schema, table, body] of entry.sql.matchAll(alterRe)) {
      for (const [, col] of body.matchAll(addColRe)) {
        const key = `col:${schema}.${table}.${col}`;
        if (!declared.has(key)) declared.set(key, { kind: 'col', qualified: `${schema}.${table}.${col}`, file: entry.file });
      }
    }
    for (const [, schema, name] of entry.sql.matchAll(dropRe)) {
      droppedLater.add(`rel:${schema}.${name}`);
      droppedLater.add(`fn:${schema}.${name}`);
    }
    for (const [, schema, table, col] of entry.sql.matchAll(dropColRe)) {
      droppedLater.add(`col:${schema}.${table}.${col}`);
    }
    for (const [, schema, table, col] of entry.sql.matchAll(renameColRe)) {
      droppedLater.add(`col:${schema}.${table}.${col}`);
    }
    for (const [, schema, name] of entry.sql.matchAll(renameRelRe)) {
      droppedLater.add(`rel:${schema}.${name}`);
    }
  }

  for (const [key, decl] of declared) {
    if (ALLOWLIST.has(key)) continue;

    const live =
      decl.kind === 'rel' ? liveRelations.has(decl.qualified)
      : decl.kind === 'fn' ? liveFunctions.has(decl.qualified)
      : liveColumns.has(decl.qualified);
    if (live) continue;

    // A column on a table that itself never landed is one finding, not two.
    if (decl.kind === 'col') {
      const table = decl.qualified.split('.').slice(0, 2).join('.');
      if (!liveRelations.has(table)) continue;
    }

    if (droppedLater.has(key)) {
      findings.push({
        level: 'warn',
        check: 'retired',
        object: decl.qualified,
        detail: `created in ${decl.file} and dropped by a later migration; absent live as expected. Informational.`,
      });
      continue;
    }

    const baselined = useBaseline && BASELINE_UNAPPLIED.has(decl.qualified);
    findings.push({
      level: baselined ? 'warn' : 'error',
      check: baselined ? 'unapplied-baselined' : 'unapplied',
      object: decl.qualified,
      detail: baselined
        ? `${decl.file} creates it but it does NOT exist live. Known pre-existing debt owned by ${BASELINE_UNAPPLIED.get(decl.qualified)}; baselined so new drift still fails. Run with --no-baseline to fail on it.`
        : `${decl.file} creates it but it does NOT exist live — the migration was never applied. Code written against it will fail at runtime.`,
    });
  }
}

async function main() {
  const corpus = loadMigrationCorpus();
  const snapshot = await fetchSnapshot();
  const findings = [];

  checkFunctions(snapshot, corpus, findings);
  checkRelationsAndColumns(snapshot, corpus, findings);
  checkUnappliedMigrations(snapshot, corpus, findings);

  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warn');

  if (asJson) {
    console.log(JSON.stringify({ capturedAt: snapshot.captured_at, migrationFiles: corpus.length, findings }, null, 2));
  } else {
    console.log(`check-schema-drift — ${corpus.length} migration files vs live catalog (${snapshot.captured_at})`);
    console.log(`  functions: ${snapshot.functions.length}  relations: ${snapshot.relations.length}  columns: ${snapshot.columns.length}`);
    console.log('');

    for (const group of ['overload', 'fn-missing', 'fn-param', 'rel-missing', 'unapplied', 'unapplied-baselined', 'secdef', 'col-missing', 'retired']) {
      const hits = findings.filter((f) => f.check === group);
      if (hits.length === 0) continue;
      console.log(`${hits[0].level === 'error' ? 'ERROR' : 'WARN '} ${group} (${hits.length})`);
      for (const hit of hits) console.log(`  - ${hit.object}: ${hit.detail}`);
      console.log('');
    }

    if (findings.length === 0) console.log('No drift found.');
    else console.log(`${errors.length} error(s), ${warnings.length} warning(s).`);
  }

  const failing = warningsAsErrors ? findings.length : errors.length;
  process.exit(failing > 0 ? 1 : 0);
}

await main();
