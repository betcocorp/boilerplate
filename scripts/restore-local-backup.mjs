#!/usr/bin/env node
/**
 * Restore the latest Supabase dump into the LOCAL database.
 *
 * Semi-interactive by design: the script resolves the backup and the target, prints both, and
 * refuses to touch anything until the operator types the target database name back. A restore is
 * destructive (`pg_restore --clean --if-exists` drops every object it is about to recreate), so
 * the confirmation step is the whole point — it exists to make "which database am I about to
 * wipe?" impossible to get wrong.
 *
 * Hard safety rail: the target host MUST be loopback (127.0.0.1 / localhost / ::1). There is no
 * flag to override this. Restoring a dump over a shared or hosted database is not a thing this
 * script will ever do by accident.
 *
 * Three things this does beyond calling pg_restore, each of them a bug we actually hit:
 *
 *   1. Extension preflight. A dump that declares `extensions.halfvec(3072)` fails its whole CREATE
 *      TABLE — and with it that table's data, indexes, trigger, RLS policy and inbound FKs — when
 *      pgvector is not installed in a fresh local volume. Schema-filtered dumps (`pg_dump -n public`)
 *      carry no CREATE EXTENSION at all, so nothing in the dump installs it for us. We scan the
 *      dump's schema text for tell-tale references and CREATE EXTENSION whatever it needs first.
 *
 *   2. Schema filter. Default is the schemas we own (public, rag, legacy). `auth` and `storage` are
 *      owned by supabase_auth_admin / supabase_storage_admin, so restoring them as `postgres`
 *      produces hundreds of "must be owner of ..." errors and restores almost nothing anyway — the
 *      local auth and storage containers build those schemas themselves. `--all-schemas` opts out.
 *
 *   3. Error classification. pg_restore exits non-zero on ANY error, including the large volume of
 *      expected noise from --clean on a fresh database. We capture stderr, bucket every error as
 *      expected or real, and exit on the REAL count — so a non-zero exit means something you have to
 *      act on, not "scroll back 600 lines and judge for yourself".
 *
 * Usage
 *   node scripts/restore-local-backup.mjs
 *   node scripts/restore-local-backup.mjs --file supabase/backups/backup-....dump
 *   node scripts/restore-local-backup.mjs --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *   node scripts/restore-local-backup.mjs --schema public --schema rag  # override the default set
 *   node scripts/restore-local-backup.mjs --all-schemas                 # no filter, incl. auth/storage
 *   node scripts/restore-local-backup.mjs --list              # show discovered backups, restore nothing
 *   node scripts/restore-local-backup.mjs --dry-run           # print the plan, run nothing
 *   node scripts/restore-local-backup.mjs --verbose           # stream raw pg_restore stderr live
 *   node scripts/restore-local-backup.mjs --skip-extensions   # do not preflight extensions
 *   node scripts/restore-local-backup.mjs --yes               # skip the prompt (CI / scripted use only)
 *
 * Backups come from `scripts/dump-remote-backup.sh`, which dumps the same schema set this restores.
 *
 * Target resolution order: --db-url > LOCAL_DATABASE_URL > SUPABASE_DB_URL > the Supabase CLI
 * default (postgresql://postgres:postgres@127.0.0.1:54322/postgres).
 *
 * Exit codes: 0 restored (or listed/dry-run), 1 real errors during restore, 2 could not run,
 * 3 aborted by user.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/** Every directory a dump might have been written to, newest-first across all of them. */
const BACKUP_DIRS = [
  join(process.cwd(), 'supabase', 'backups'),
  join(process.cwd(), 'supabase', 'supabase', 'backups'),
];

const DEFAULT_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Schemas this project owns. auth/storage belong to the Supabase containers — see header note 2. */
const DEFAULT_SCHEMAS = ['public', 'rag', 'legacy'];

/**
 * Extension preflight (header note 1). If the dump's schema text matches `pattern`, the extension
 * must exist before the restore or every object using it is lost. `vector` is the one that actually
 * bit us (halfvec(3072) on public.routing_test_items took its 32 rows, PK, index, trigger, policy
 * and one inbound FK down with it); the rest are cheap insurance. All are created in `extensions`,
 * which is where Supabase keeps them.
 */
const EXTENSION_TRIGGERS = [
  { name: 'vector', pattern: /\bextensions\.(halfvec|sparsevec|vector)\b/ },
  { name: 'pg_trgm', pattern: /\b(gin_trgm_ops|gist_trgm_ops|extensions\.similarity)\b/ },
  { name: 'pgcrypto', pattern: /\b(gen_random_uuid|extensions\.(crypt|digest))\s*\(/ },
  { name: 'uuid-ossp', pattern: /\buuid_generate_v[145]\s*\(/ },
  { name: 'unaccent', pattern: /\bextensions\.unaccent\s*\(/ },
  { name: 'postgis', pattern: /\bextensions\.(geometry|geography)\b/ },
];

/**
 * Errors that are expected and mean nothing. Anything NOT matched here is reported as real, so a new
 * failure mode shows up as real rather than being silently absorbed. Keep the patterns narrow.
 */
const BENIGN = [
  {
    key: 'ownership — auth/storage objects belong to supabase_*_admin, not us',
    test: (e) => /must be owner of/.test(e.error),
  },
  {
    key: 'permission denied inside auth/storage (same cause)',
    test: (e) =>
      /permission denied for (schema|table|sequence|function) /.test(e.error) &&
      /\b(auth|storage)\b/.test(`${e.error} ${e.command}`),
  },
  {
    key: 'DROP of an object this database never had (--clean on a fresh DB)',
    test: (e) => /^DROP /m.test(e.command) && /does not exist/.test(e.error),
  },
  {
    key: 'schema already created by the local containers',
    test: (e) => /already exists/.test(e.error) && /^CREATE SCHEMA/m.test(e.command),
  },
];

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));

function flagValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

/** Repeatable flag: --schema public --schema rag */
function flagValues(name) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
  });
  return out;
}

function fail(message, code = 2) {
  console.error(`restore-local-backup: ${message}`);
  process.exit(code);
}

function bytes(n) {
  const mb = n / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

/** All *.dump / *.sql files across BACKUP_DIRS, newest mtime first. */
function findBackups() {
  const found = [];
  for (const dir of BACKUP_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/\.(dump|sql)$/.test(name)) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isFile()) found.push({ path, name, size: st.size, mtime: st.mtime });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** Parse the target URL and refuse anything that is not loopback. Deliberately no override flag. */
function resolveTarget() {
  const raw =
    flagValue('--db-url') ||
    process.env.LOCAL_DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    DEFAULT_LOCAL_DB_URL;

  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`could not parse database URL: ${raw}`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) fail(`not a postgres URL: ${raw}`);

  const host = url.hostname;
  if (!LOOPBACK_HOSTS.has(host)) {
    fail(
      `refusing to restore to a NON-LOCAL host: ${host}\n` +
        `  This script only ever writes to a loopback database. There is no override.`,
    );
  }

  return {
    raw,
    host,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
    user: decodeURIComponent(url.username) || 'postgres',
  };
}

/** One-line liveness + size probe of the target, so the operator sees what they are overwriting. */
function probeTarget(target) {
  const sql =
    "select current_database() || ' | ' || pg_size_pretty(pg_database_size(current_database())) " +
    "|| ' | tables: ' || (select count(*) from information_schema.tables " +
    "where table_schema not in ('pg_catalog','information_schema'))";
  const res = spawnSync('psql', [target.raw, '-tAc', sql], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    return { reachable: false, detail: (res.stderr || res.error?.message || '').trim().split('\n')[0] };
  }
  return { reachable: true, detail: res.stdout.trim() };
}

/**
 * Which extensions this dump needs and the target lacks. Reads the dump's SCHEMA text only (no data)
 * and matches it against EXTENSION_TRIGGERS.
 */
function missingExtensions(file, target, schemaArgs) {
  const dumped = spawnSync(
    'pg_restore',
    ['--schema-only', '--no-owner', '--no-privileges', ...schemaArgs, '-f', '-', file],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  if (dumped.error || typeof dumped.stdout !== 'string') {
    return { error: dumped.error?.message || 'could not read schema from dump', needed: [] };
  }

  const needed = EXTENSION_TRIGGERS.filter((e) => e.pattern.test(dumped.stdout)).map((e) => e.name);
  if (needed.length === 0) return { error: null, needed: [] };

  const have = spawnSync('psql', [target.raw, '-tAc', 'select extname from pg_extension'], {
    encoding: 'utf8',
  });
  const installed = new Set(
    (have.stdout || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return { error: null, needed: needed.filter((n) => !installed.has(n)) };
}

function createExtensions(names, target) {
  for (const name of names) {
    const res = spawnSync(
      'psql',
      [target.raw, '-v', 'ON_ERROR_STOP=1', '-c', `create extension if not exists "${name}" with schema extensions;`],
      { encoding: 'utf8' },
    );
    if (res.status !== 0) {
      fail(
        `could not create required extension "${name}":\n  ${(res.stderr || '').trim().split('\n')[0]}\n` +
          `  Objects depending on it would fail to restore. Use --skip-extensions to proceed anyway.`,
      );
    }
    console.log(`  installed extension ${name}`);
  }
}

async function confirm(target) {
  if (flags.has('--yes')) {
    console.log('--yes given, skipping confirmation.\n');
    return true;
  }
  if (!stdin.isTTY) {
    fail('not a TTY and --yes not given; refusing to restore unconfirmed.', 3);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    `Type the target database name (${target.database}) to confirm the restore, anything else to abort: `,
  );
  rl.close();
  return answer.trim() === target.database;
}

/**
 * Run pg_restore, capturing stderr so it can be classified. Raw stderr is echoed live only under
 * --verbose, because it is hundreds of lines of mostly-expected noise; the summary is the default.
 */
function runRestore(file, target, schemaArgs) {
  const args = [
    '--dbname', target.raw,
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    '--jobs', '1',
    ...schemaArgs,
    file,
  ];
  console.log(`\n$ pg_restore ${args.map((a) => (a === target.raw ? '<db-url>' : a)).join(' ')}\n`);
  if (flags.has('--dry-run')) {
    console.log('--dry-run: nothing executed.');
    return Promise.resolve({ code: 0, stderr: '' });
  }
  return new Promise((res) => {
    const child = spawn('pg_restore', args, { stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (flags.has('--verbose')) process.stderr.write(chunk);
    });
    child.on('error', (err) => fail(`could not run pg_restore: ${err.message}`));
    child.on('close', (code) => res({ code: code ?? 1, stderr }));
  });
}

/**
 * Split pg_restore stderr into {error, command} pairs, then bucket each as expected or real.
 * pg_restore emits `pg_restore: error: could not execute query: ERROR:  <msg>` followed by
 * `Command was: <sql>`, which may run over several lines.
 */
function classify(stderr) {
  const entries = [];
  let current = null;
  for (const line of stderr.split('\n')) {
    const err = line.match(/^pg_restore: error: (?:could not execute query: )?(.*)$/);
    if (err) {
      if (current) entries.push(current);
      current = { error: err[1], command: '' };
      continue;
    }
    if (!current) continue;
    if (/^Command was: /.test(line)) current.command = line.replace(/^Command was: /, '');
    else if (current.command) current.command += `\n${line}`;
  }
  if (current) entries.push(current);

  const expected = new Map();
  const real = [];
  for (const entry of entries) {
    const bucket = BENIGN.find((b) => b.test(entry));
    if (bucket) expected.set(bucket.key, (expected.get(bucket.key) || 0) + 1);
    else real.push(entry);
  }
  return { total: entries.length, expected, real };
}

/** Print the classified summary. Returns 1 if anything real happened, else 0. */
function reportErrors(stderr) {
  const { total, expected, real } = classify(stderr);
  if (total === 0) {
    console.log('\nNo errors reported by pg_restore.');
    return 0;
  }

  console.log(`\n${total} error(s) from pg_restore — ${total - real.length} expected, ${real.length} real.\n`);
  for (const [key, count] of [...expected].sort((a, b) => b[1] - a[1])) {
    console.log(`  expected  ${String(count).padStart(4)}  ${key}`);
  }
  if (real.length === 0) {
    console.log('\nNothing to act on. (--verbose shows the raw pg_restore output.)');
    return 0;
  }

  console.log('\n  REAL ERRORS — each of these lost an object or its data:\n');
  for (const entry of real.slice(0, 25)) {
    console.log(`  - ${entry.error}`);
    const first = entry.command.split('\n')[0];
    if (first) console.log(`      while: ${first.slice(0, 160)}`);
  }
  if (real.length > 25) console.log(`  ... and ${real.length - 25} more (--verbose for all).`);
  return 1;
}

async function main() {
  if (spawnSync('pg_restore', ['--version']).status !== 0) {
    fail('pg_restore not found on PATH (brew install libpq / postgresql).');
  }

  const backups = findBackups();
  if (backups.length === 0) {
    fail(`no .dump/.sql files found in:\n  ${BACKUP_DIRS.join('\n  ')}\n  Run scripts/dump-remote-backup.sh first.`);
  }

  if (flags.has('--list')) {
    for (const b of backups) {
      console.log(`${b.mtime.toISOString()}  ${bytes(b.size).padStart(10)}  ${relative(process.cwd(), b.path)}`);
    }
    return 0;
  }

  const explicit = flagValue('--file');
  const backup = explicit
    ? { path: resolve(explicit), name: explicit, size: 0, mtime: new Date(0) }
    : backups[0];
  if (explicit) {
    if (!existsSync(backup.path)) fail(`no such file: ${backup.path}`);
    const st = statSync(backup.path);
    backup.size = st.size;
    backup.mtime = st.mtime;
  }

  const chosen = flagValues('--schema');
  const schemas = flags.has('--all-schemas') ? [] : chosen.length ? chosen : DEFAULT_SCHEMAS;
  const schemaArgs = schemas.flatMap((s) => ['--schema', s]);

  const target = resolveTarget();
  const probe = probeTarget(target);

  console.log('');
  console.log('  RESTORE — this DROPS and recreates every object in the dump.');
  console.log('');
  console.log(`  Backup    ${relative(process.cwd(), backup.path)}`);
  console.log(`            ${bytes(backup.size)}, written ${backup.mtime.toISOString()}`);
  if (!explicit && backups.length > 1) {
    console.log(`            (latest of ${backups.length}; --list to see all, --file to pick one)`);
  }
  console.log(`  Schemas   ${schemas.length ? schemas.join(', ') : 'ALL (including auth, storage)'}`);
  console.log('');
  console.log('  TARGET    ===================================================');
  console.log(`            database  ${target.database}`);
  console.log(`            host      ${target.host}:${target.port}   (local only)`);
  console.log(`            user      ${target.user}`);
  console.log(
    probe.reachable
      ? `            current   ${probe.detail}`
      : `            current   UNREACHABLE — ${probe.detail}`,
  );
  console.log('  ===================================================');
  console.log('');

  if (!probe.reachable && !flags.has('--dry-run')) {
    fail('target is not reachable; start the local stack first (`supabase start`).');
  }

  // Preflight BEFORE the prompt, so the operator confirms against the whole plan.
  let toInstall = [];
  if (!flags.has('--skip-extensions') && probe.reachable) {
    const ext = missingExtensions(backup.path, target, schemaArgs);
    if (ext.error) console.log(`  (extension preflight skipped: ${ext.error})\n`);
    toInstall = ext.needed;
    if (toInstall.length) console.log(`  Extensions to install first: ${toInstall.join(', ')}\n`);
  }

  if (!(await confirm(target))) {
    console.log('Aborted. Nothing was changed.');
    return 3;
  }

  if (toInstall.length && !flags.has('--dry-run')) createExtensions(toInstall, target);

  const { code, stderr } = await runRestore(backup.path, target, schemaArgs);
  if (flags.has('--dry-run')) return 0;

  if (reportErrors(stderr)) {
    console.error('\nRestore completed with REAL errors — see above.');
    return 1;
  }
  if (code !== 0) {
    // Non-zero exit but every error classified as expected: that is a clean restore.
    console.log('\nRestore complete (pg_restore exited non-zero on expected errors only).');
    return 0;
  }
  console.log('\nRestore complete.');
  return 0;
}

main().then((code) => process.exit(code));
