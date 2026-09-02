import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import { evaluateSdsContentLanguage, matchSdsFilenameLanguageSuffix } from './policy';

/**
 * B0-794 — the loud check.
 *
 * Three times now (B0-243, B0-283, B0-794) a batch of out-of-scope SDS has been found
 * sitting in the retrievable corpus by someone looking by hand, and each time the
 * documents had been retrievable for months with nothing reporting it. B0-794 was the
 * largest: 364 Spanish/French/Italian safety data sheets tagged `language_code = 'EN'`,
 * chunked, embedded, and returnable by every `match_*` RPC.
 *
 * `policy.ts` says in its own docstring that `evaluateSdsContentLanguage` is the
 * authoritative gate; the reason all three escaped is that nothing ever ran it over the
 * corpus on a schedule. This test does exactly that, against the LIVE database, over
 * every SDS the RPCs can currently return, and fails with the offending file paths.
 *
 * WHY A TEST AND NOT A VIEW OR A SCRIPT
 * -------------------------------------
 * The detector is `franc`, a JS library — it cannot run inside Postgres, so a view alone
 * can only list candidates, never judge them (the companion view
 * `rag.retrievable_sds_language_audit` does that listing half, and is what this reads).
 * A script only fails loudly if somebody remembers to run it. A test is the one form
 * that is already wired into the command the team runs on this directory
 * (`pnpm exec vitest run "src/app/(authenticated)/admin/sds"`), fails by default, and
 * prints the evidence. It skips — rather than failing — without Supabase credentials,
 * matching `src/lib/rag/efficacy-retrieval-lifecycle.test.ts`, because tests are not yet
 * wired into CI and a plain `vitest run` must still work on a machine without secrets.
 *
 * Honouring the function's own rule: only a confident FR/ES detection against an EN/CAN
 * expectation is a failure. `und` (short or garbled OCR) is never a mismatch — those are
 * reported to the console and left alone, never purged, per the regulated-data policy.
 */

function loadEnvLocalIfNeeded() {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  // Walk up to the repo root rather than counting `../` — this file sits four directories
  // below `src/`, and a hardcoded depth silently skips the whole check if it is wrong.
  let dir = __dirname;
  let envPath: string | null = null;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, '.env.local');
    if (existsSync(candidate)) {
      envPath = candidate;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!envPath) return;

  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

loadEnvLocalIfNeeded();

const hasSupabaseCreds = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

type AuditRow = {
  document_id: string;
  s3_key: string | null;
  document_key: string;
  language_code: string | null;
  body_sample: string | null;
  chunk_count: number;
  recorded_language_mismatch: boolean | null;
};

/**
 * PostgREST caps a response at `db-max-rows` (1000) and this view is already larger than
 * that, so every read must page with a stable order. Reading it unpaged silently returns
 * a truncated corpus and the check passes for the wrong reason.
 */
async function fetchAuditRows(): Promise<AuditRow[]> {
  const rag = getSupabaseServiceRoleClient().schema('rag');
  const rows: AuditRow[] = [];
  const pageSize = 500;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await rag
      .from('retrievable_sds_language_audit')
      .select(
        'document_id, s3_key, document_key, language_code, body_sample, chunk_count, recorded_language_mismatch',
      )
      .order('document_id')
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`retrievable_sds_language_audit read failed: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as AuditRow[]));
    if (data.length < pageSize) break;
  }

  return rows;
}

describe.skipIf(!hasSupabaseCreds)('retrievable SDS corpus is English-only (B0-794)', () => {
  it('has no confidently French or Spanish document reachable by the match_* RPCs', async () => {
    const rows = await fetchAuditRows();

    // Guard against the truncation failure mode above: an empty or tiny result means the
    // read broke, not that the corpus is clean.
    expect(rows.length).toBeGreaterThan(500);

    const mismatches: string[] = [];
    const inconclusive: string[] = [];

    for (const row of rows) {
      const body = row.body_sample?.trim() ?? '';
      if (!body) {
        inconclusive.push(`${row.s3_key ?? row.document_key} (no body text)`);
        continue;
      }

      const check = evaluateSdsContentLanguage(body, row.language_code ?? 'EN');
      if (check.mismatch) {
        mismatches.push(
          `${row.s3_key ?? row.document_key} — tagged ${row.language_code}, content ${check.detectedLocale} (${check.francCode}), ${row.chunk_count} chunks`,
        );
      } else if (check.francCode === 'und') {
        inconclusive.push(`${row.s3_key ?? row.document_key} (${body.length} chars, und)`);
      }
    }

    // Inconclusive detections are surfaced, never actioned — see the module docstring.
    if (inconclusive.length > 0) {
      console.warn(
        `[B0-794] ${inconclusive.length} retrievable SDS were inconclusive and left alone:\n  ${inconclusive.slice(0, 20).join('\n  ')}`,
      );
    }

    expect(
      mismatches,
      `${mismatches.length} foreign-language SDS are live in the retrievable corpus. ` +
        'They must be taken out of scope (source_record.is_active = false) and their ' +
        'chunks deleted — see 20260902150000_deactivate_foreign_language_sds_b0794.sql ' +
        `for the mechanism.\n  ${mismatches.slice(0, 40).join('\n  ')}`,
    ).toEqual([]);
  }, 120_000);

  it('honours the language verdict ingestion already recorded (B0-794 root cause)', async () => {
    const rows = await fetchAuditRows();
    expect(rows.length).toBeGreaterThan(500);

    // `parseSdsFile` runs evaluateSdsContentLanguage at parse time and stores the answer
    // in rag.document.metadata.language_policy_mismatch. Of the 1,526 SDS that were
    // retrievable before B0-794, 363 already carried `true` -- the corpus knew, and
    // ingestion imported them anyway. This assertion is the cheapest form of the whole
    // check: it needs no language library, only that we stop ignoring our own verdict.
    const ignoredVerdicts = rows
      .filter((row) => row.recorded_language_mismatch === true)
      .map((row) => `${row.s3_key ?? row.document_key} (${row.chunk_count} chunks)`);

    expect(
      ignoredVerdicts,
      `${ignoredVerdicts.length} retrievable SDS were flagged as a language mismatch by ` +
        'our own ingestion pipeline and are live anyway. This is the B0-794 failure mode ' +
        `recurring.\n  ${ignoredVerdicts.slice(0, 40).join('\n  ')}`,
    ).toEqual([]);
  }, 120_000);

  it('has no document whose filename carries a language suffix (B0-794 pre-filter)', async () => {
    const rows = await fetchAuditRows();

    const suffixed = rows
      .filter((row) => row.s3_key && matchSdsFilenameLanguageSuffix(row.s3_key))
      .map((row) => `${row.s3_key} (suffix "${matchSdsFilenameLanguageSuffix(row.s3_key!)}")`);

    // This is the cheap shape-level check that mirrors evaluateSdsPolicy. It is weaker
    // than the content check above and can in principle flag an English sheet that a
    // supplier mis-suffixed (two such exist in the wider corpus, both already excluded as
    // private label) — so if this ever fails, confirm against the body text before acting.
    expect(
      suffixed,
      `${suffixed.length} retrievable SDS have an FR/SP/MX/IT language suffix on the ` +
        'filename. Confirm the body language before removing any of them.\n  ' +
        suffixed.slice(0, 40).join('\n  '),
    ).toEqual([]);
  }, 120_000);
});
