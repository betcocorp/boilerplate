#!/usr/bin/env -S npx tsx
/**
 * Phase 0 of the RAG evaluation process (`src/docs/rag-evaluation-process.md`) — exports one run's
 * retrieval as a JSONL dataset: one record per test item, carrying the question, the retrieved
 * chunks WITH their text, the answer, and the reference answer where one exists.
 *
 * This phase measures nothing. It exists so that the metrics in Phases 1-3 have something truthful
 * to read: until now a run recorded which chunks were retrieved (`document_id` / `chunk_id`) but
 * never their text, and `toolTrace` is no substitute — it caps `outputPreview` at 4000 chars, sliced
 * at write time straight through the label/SDS bodies these metrics need.
 *
 * Read-only against Supabase. Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 *
 * ## Usage
 *
 *   npx tsx --env-file=.env.local scripts/export-retrieval-dataset.ts <runId> --out <dir>
 *
 *   # Print the coverage summary and write nothing — use this before trusting a backfill.
 *   npx tsx --env-file=.env.local scripts/export-retrieval-dataset.ts <runId> --dry-run
 *
 * Flags:
 *   --out <dir>   Directory for retrieval-<run8>.jsonl (created if missing).
 *   --dry-run     Report coverage only.
 *
 * ## Read the coverage line before scoring anything
 *
 * The chunk text is joined by id at export time, so a corpus re-ingest since the run leaves every
 * reference dangling. That failure is silent and looks exactly like a retrieval collapse — chunks
 * reported "missing" that were retrieved perfectly well at the time. The summary therefore reports
 * resolved / missing / synthetic explicitly, and the exporter warns when the resolved share drops
 * below RESOLVED_SHARE_WARN. A run under that bar is a stale join, not a bad retriever, and its
 * numbers should not go on a trend chart next to fresh ones.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
} from '~/lib/tests/repository';
import {
  buildRetrievalEvalRecords,
  summarizeRunCoverage,
  type RetrievalEvalRecord,
} from '~/lib/tests/retrieval-dataset';
import type { TestItemRecord } from '~/lib/tests/types';

/** Below this share of joinable references resolving, the export is reporting staleness, not retrieval. */
const RESOLVED_SHARE_WARN = 0.9;

type Options = { runId: string; outDir: string | null; dryRun: boolean };

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  const outDir = get('--out');
  const dryRun = argv.includes('--dry-run');
  const runId = argv.find((a) => !a.startsWith('--') && a !== outDir);

  if (!runId || (!outDir && !dryRun)) {
    throw new Error(
      'Usage: export-retrieval-dataset.ts <runId> [--out <dir>] [--dry-run] — one of --out / --dry-run is required.',
    );
  }
  return { runId, outDir, dryRun };
}

function pct(share: number | null): string {
  return share === null ? 'n/a' : `${(share * 100).toFixed(1)}%`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const run = await getTestResultById(options.runId);
  if (!run) {
    throw new Error(`No test run found for id ${options.runId}`);
  }
  const test = await getTestById(run.test_id);
  const [resultItems, testItems] = await Promise.all([
    listAllResultItemsByResultId(run.id),
    getTestItemsByTestId(run.test_id),
  ]);

  if (resultItems.length === 0) {
    throw new Error(`Run ${run.id} has no result items.`);
  }

  const itemsById = new Map<string, TestItemRecord>(testItems.map((item) => [item.id, item]));
  const records = await buildRetrievalEvalRecords(resultItems, itemsById);
  const coverage = summarizeRunCoverage(records);

  console.log(
    `Run ${run.id.slice(0, 8)} (${test?.name ?? 'unknown test'}, mode ${run.run_mode}): ` +
      `${records.length} items, ${coverage.requested} chunk refs.`,
  );
  console.log(
    `Chunk text: ${coverage.resolved} resolved / ${coverage.missing} missing / ` +
      `${coverage.synthetic} synthetic / ${coverage.noChunkId} without a chunk id ` +
      `(${pct(coverage.resolvedShare)} of joinable refs resolved).`,
  );

  const withReference = records.filter((r) => r.reference && r.reference.trim()).length;
  console.log(
    `Items: ${coverage.itemsWithNoRetrieval} retrieved nothing; ` +
      `${coverage.itemsWithoutRetrievalCalls} predate per-call retrieval (no rank data); ` +
      `${withReference} carry a reference answer.`,
  );

  if (coverage.resolvedShare !== null && coverage.resolvedShare < RESOLVED_SHARE_WARN) {
    console.warn(
      `WARNING: only ${pct(coverage.resolvedShare)} of joinable chunk references resolved. ` +
        'The corpus has almost certainly been re-ingested since this run, so the unresolved chunks ' +
        'are a stale join, NOT missed retrieval. Do not score this run against fresh ones.',
    );
  }
  if (coverage.itemsWithoutRetrievalCalls === records.length) {
    console.warn(
      'WARNING: no item in this run carries `retrieval_calls`. Faithfulness and the set-based ' +
        'recall/precision metrics still work; anything rank-sensitive cannot be computed for it.',
    );
  }

  if (options.dryRun || !options.outDir) {
    return;
  }

  await writeJsonl(records, path.resolve(options.outDir), run.id);
}

async function writeJsonl(records: RetrievalEvalRecord[], outDir: string, runId: string) {
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `retrieval-${runId.slice(0, 8)}.jsonl`);
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`Wrote ${records.length} records → ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
