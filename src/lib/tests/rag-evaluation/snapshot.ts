/**
 * The Phase 3 snapshot: a self-describing JSON record of one scoring run.
 *
 * ## Why a snapshot exists at all
 *
 * The gate this phase serves is pre- vs post-docling. That comparison is not a comparison of two
 * live queries, because the docling re-ingest *invalidates the rows the baseline came from*: new
 * `rag.document_chunk` ids are minted, and every chunk reference in the pre-docling run becomes a
 * dangling join. Re-scoring the baseline after the migration would therefore report a retrieval
 * collapse that never happened (see `retrieval-dataset.ts` on silent staleness).
 *
 * So the baseline has to be *frozen before the migration*, in a file that no longer depends on the
 * database. That file is this snapshot.
 *
 * ## Why so much provenance
 *
 * A number frozen for months is only usable if you can still tell, later, what it measured. Every
 * field below exists because its absence would make a comparison unsound rather than merely
 * inconvenient:
 *
 * - `schemaVersion` — an unknown version is REFUSED, not best-effort read. A snapshot silently
 *   mis-read across a format change is worse than no baseline, because it still produces a number.
 * - `options` — the full {@link ScoringOptions}. `best_rank` vs `first_call` fusion, or `retrieved`
 *   vs `reranked` basis, move these metrics more than most retrieval changes do. Comparing two
 *   snapshots scored under different options is meaningless, so `compare` can check.
 * - `coverage` and `unscorable` — the denominators. A mean over 6 of 20 episodes must never be
 *   comparable-looking with a mean over 20.
 * - `labelling` — ground truth is partial and will change as D1/D2 proceed. A metric that "improved"
 *   because ten more items got labelled is not an improvement.
 * - `runId`, `questionSetId/Name`, `createdAt`, `snapshotId` — which run, which questions, when.
 *
 * ## Decoupling
 *
 * The snapshot owns its own metric-result shape (`SnapshotScore`, `AggregateEntry`) rather than
 * re-exporting the metric modules' internal types. The file format is a long-lived artifact; the
 * metric modules are not, and a snapshot on disk must stay readable when they are refactored. The
 * runner is responsible for projecting metric output into these shapes.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { ScoringOptions, UnscorableReason } from './types';

/**
 * Bump on any change that alters the MEANING of an existing field, or removes one. Adding an
 * optional field does not need a bump; changing how a metric is computed does, because the version
 * is the only thing standing between a stale baseline and a wrong conclusion.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Versions this build can read. A snapshot outside this set is refused. */
export const SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS: readonly number[] = [1];

const unscorableReasonSchema = z.enum([
  'no_retrieval_calls',
  'empty_retrieval',
  'no_judgement',
  'coverage_below_floor',
  'no_resolved_text',
  'reranker_absent',
]) satisfies z.ZodType<UnscorableReason>;

/**
 * One metric outcome for one episode. Mirrors `ScoreResult<number>` from the contract, narrowed to a
 * number because a snapshot stores reported values, not intermediate structures.
 */
const snapshotScoreSchema = z.discriminatedUnion('scored', [
  z.object({ scored: z.literal(true), value: z.number().finite() }),
  z.object({
    scored: z.literal(false),
    reason: unscorableReasonSchema,
    detail: z.string().nullable().default(null),
  }),
]);

export type SnapshotScore = z.infer<typeof snapshotScoreSchema>;

const coverageSchema = z.object({
  requested: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  synthetic: z.number().int().nonnegative(),
  noChunkId: z.number().int().nonnegative(),
  resolvedShare: z.number().nullable(),
});

const scoringOptionsSchema = z.object({
  fusion: z.enum(['best_rank', 'first_call', 'concat']),
  basis: z.enum(['retrieved', 'reranked']),
  ks: z.array(z.number().int().positive()),
  coverageFloor: z.number().min(0).max(1),
  excludeKinds: z.array(z.string()),
}) satisfies z.ZodType<ScoringOptions, ScoringOptions>;

const episodeResultSchema = z.object({
  episodeId: z.string(),
  itemId: z.string(),
  rowIndex: z.number().int(),
  /** Kept so a snapshot is human-readable a quarter later without the database. */
  question: z.string(),
  passed: z.boolean(),
  coverage: coverageSchema,
  /** Metric name → outcome. Metric names are open, so new metrics do not need a version bump. */
  metrics: z.record(z.string(), snapshotScoreSchema),
});

export type SnapshotEpisodeResult = z.infer<typeof episodeResultSchema>;

/**
 * A run-level metric value together with the denominator that produced it.
 *
 * `value` is null when nothing was scoreable — never 0. `unscorableByReason` is what turns "the
 * mean fell" into a diagnosis: a drop caused by `coverage_below_floor` is a stale join, one caused
 * by `no_judgement` is a labelling gap, and only a drop with a steady denominator is retrieval.
 */
const aggregateEntrySchema = z.object({
  metric: z.string(),
  /** The headline value — the mean over scored episodes. */
  value: z.number().finite().nullable(),
  scoredCount: z.number().int().nonnegative(),
  unscorableCount: z.number().int().nonnegative(),
  unscorableByReason: z.record(z.string(), z.number().int().nonnegative()),
  /** Distribution and interval, carried when the aggregator produced them. Optional so a snapshot
   *  written by a caller that computes only a mean is still valid. */
  median: z.number().finite().nullable().optional(),
  min: z.number().finite().nullable().optional(),
  max: z.number().finite().nullable().optional(),
  ci: z
    .object({
      lower: z.number(),
      upper: z.number(),
      level: z.number(),
      resamples: z.number().int().nonnegative(),
      method: z.string(),
      degenerate: z.boolean(),
    })
    .nullable()
    .optional(),
});

export type SnapshotAggregateEntry = z.infer<typeof aggregateEntrySchema>;

const labellingSchema = z.object({
  items: z.number().int().nonnegative(),
  judgements: z.number().int().nonnegative(),
  labelled: z.number().int().nonnegative(),
  unlabelled: z.number().int().nonnegative(),
  documentLabelled: z.number().int().nonnegative(),
  entityLabelled: z.number().int().nonnegative(),
  orphanJudgements: z.number().int().nonnegative(),
  labelledShare: z.number().nullable(),
});

export type SnapshotLabelling = z.infer<typeof labellingSchema>;

export const snapshotSchema = z.object({
  schemaVersion: z.number().int().positive(),
  /** Unique per snapshot file, so two snapshots of the same run are still distinguishable. */
  snapshotId: z.string().min(1),
  /** ISO-8601, UTC. When the SCORING ran, which is not when the run ran. */
  createdAt: z.string().min(1),
  runId: z.string().min(1),
  questionSetId: z.string(),
  questionSetName: z.string().nullable(),
  /** Free-form label, e.g. `pre-docling`. The human handle on a baseline. */
  label: z.string().nullable().default(null),
  options: scoringOptionsSchema,
  episodeCount: z.number().int().nonnegative(),
  coverage: coverageSchema,
  labelling: labellingSchema,
  episodes: z.array(episodeResultSchema),
  aggregates: z.array(aggregateEntrySchema),
  /** Run-level tally across all metrics and episodes. The denominator story in one object. */
  unscorableByReason: z.record(z.string(), z.number().int().nonnegative()),
  notes: z.string().nullable().default(null),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

/** Everything a caller supplies; `schemaVersion` is stamped by {@link buildSnapshot}. */
export type SnapshotInput = Omit<Snapshot, 'schemaVersion'>;

export function buildSnapshot(input: SnapshotInput): Snapshot {
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, ...input };
}

/**
 * Tallies unscorable reasons across every episode/metric pair. Counted per (episode, metric), not
 * per episode: one episode can be scoreable for entity recall and unscorable for rank.
 */
export function tallyUnscorable(episodes: SnapshotEpisodeResult[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const episode of episodes) {
    for (const score of Object.values(episode.metrics)) {
      if (!score.scored) {
        tally[score.reason] = (tally[score.reason] ?? 0) + 1;
      }
    }
  }
  return tally;
}

export type SnapshotReadResult =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; error: string; issues?: string[] };

/**
 * Validates an already-parsed snapshot object.
 *
 * The version is checked FIRST, against the raw object, before Zod runs. A future snapshot may well
 * satisfy today's schema field-for-field while meaning something different; refusing on the version
 * is the only check that catches that.
 */
export function parseSnapshot(raw: unknown): SnapshotReadResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Snapshot is not a JSON object.' };
  }

  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number') {
    return { ok: false, error: 'Snapshot has no numeric `schemaVersion`; refusing to guess.' };
  }
  if (!SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS.includes(version)) {
    return {
      ok: false,
      error:
        `Snapshot schemaVersion ${version} is not supported by this build ` +
        `(supported: ${SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS.join(', ')}). ` +
        'Refusing to read it rather than mis-interpret a baseline.',
    };
  }

  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Snapshot failed validation.',
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      ),
    };
  }

  return { ok: true, snapshot: parsed.data };
}

export async function readSnapshot(filePath: string): Promise<SnapshotReadResult> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    return { ok: false, error: `Cannot read snapshot ${filePath}: ${(error as Error).message}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Snapshot ${filePath} is not valid JSON: ${(error as Error).message}` };
  }

  return parseSnapshot(raw);
}

/**
 * Writes a snapshot, validating on the way out. A snapshot that cannot be read back is not a
 * baseline, and the cheapest place to find that out is here.
 */
export async function writeSnapshot(filePath: string, snapshot: Snapshot): Promise<void> {
  const check = parseSnapshot(snapshot);
  if (!check.ok) {
    throw new Error(
      `Refusing to write an invalid snapshot: ${check.error}${
        check.issues ? ` (${check.issues.join('; ')})` : ''
      }`,
    );
  }

  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

/** `phase3-<run8>-<timestamp>.json`. Sorts chronologically within a run. */
export function snapshotFileName(runId: string, createdAt: string): string {
  const stamp = createdAt.replace(/[:.]/g, '-');
  return `phase3-${runId.slice(0, 8)}-${stamp}.json`;
}
