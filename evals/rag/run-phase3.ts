#!/usr/bin/env -S npx tsx
/**
 * Phase 3 of the RAG evaluation process (`src/docs/rag-evaluation-process.md`) — the runner.
 *
 * Loads one graded run through Phase 0's acquisition layer, adapts it onto `RetrievalEpisode`s,
 * scores them against whatever ground truth exists today, and freezes the result as a JSON snapshot.
 * Snapshots — not live queries — are the unit of comparison, because the docling re-ingest mints new
 * chunk ids and makes every pre-migration reference dangling; a baseline that has to be re-scored
 * after the migration is not a baseline. See `snapshot.ts`.
 *
 * Read-only against Supabase. Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, the
 * same way `scripts/export-retrieval-dataset.ts` does.
 *
 * ## Usage
 *
 *   npx tsx --env-file=.env.local evals/rag/run-phase3.ts <runId> --out <dir>
 *
 *   # Report coverage and labelling coverage, score nothing, write nothing.
 *   npx tsx --env-file=.env.local evals/rag/run-phase3.ts <runId> --dry-run
 *
 *   # Compare two frozen snapshots. No database access at all.
 *   npx tsx evals/rag/run-phase3.ts --compare <baseline.json> <candidate.json>
 *
 * Flags (scoring mode):
 *   --out <dir>            Directory for the snapshot (created if missing).
 *   --dry-run              Report coverage only. Writes nothing.
 *   --judgements <file>    Ground-truth JSON. Absent file = zero judgements = everything unlabelled.
 *   --label <text>         Human handle for the snapshot, e.g. `pre-docling`.
 *   --fusion <policy>      best_rank | first_call | concat        (default best_rank)
 *   --basis <basis>        retrieved | reranked                   (default reranked)
 *   --ks <list>            Comma-separated cut-offs                (default 1,3,5,10,20)
 *   --coverage-floor <n>   0..1                                    (default 0.8)
 *   --exclude-kinds <list> Comma-separated document kinds to drop from candidate lists.
 *
 * ## The denominators print before the numbers, on purpose
 *
 * The output order is fixed: coverage, then labelling coverage, then the unscorable breakdown, then
 * the metric values. Reading a mean before knowing it covers 6 of 20 episodes is the specific way
 * this exercise goes wrong — a "mean average precision of 0.71" over the six items somebody happened
 * to label is not a run-level number, and once it is on a trend chart nobody can tell. Every headline
 * line therefore carries its own `n` as well.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
} from '~/lib/tests/repository';
import { buildRetrievalEvalRecords } from '~/lib/tests/retrieval-dataset';
import type { TestItemRecord } from '~/lib/tests/types';

import { toRetrievalEpisodes } from './adapters/from-retrieval-eval-record';
import {
  indexJudgements,
  loadJudgementsFile,
  summarizeLabellingCoverage,
  type LabellingCoverage,
} from './judgements';
import {
  buildSnapshot,
  readSnapshot,
  snapshotFileName,
  tallyUnscorable,
  writeSnapshot,
  type Snapshot,
  type SnapshotAggregateEntry,
  type SnapshotEpisodeResult,
  type SnapshotScore,
} from './snapshot';
import {
  DEFAULT_SCORING_OPTIONS,
  type Coverage,
  type FusionPolicy,
  type Judgement,
  type RankBasis,
  type RetrievalEpisode,
  type ScoreResult,
  type ScoringOptions,
} from './types';

/* ------------------------------------------------------------------------------------------------
 * Metric core. Pure modules — no database, no clock. Each `*Metrics` function projects its family
 * onto the flat `Record<metricName, ScoreResult<number>>` shape a snapshot stores. Fusion is applied
 * inside them from `ScoringOptions`, which is why `fuse.ts` is not called directly here.
 * ---------------------------------------------------------------------------------------------- */
import { aggregateMetric, type MetricAggregate } from './aggregate';
import { compareEpisodeSets } from './compare';
import { entityRecallMetrics } from './entity-recall';
import { scoreEpisodeRank, type EpisodeRankScores } from './rank-metrics';
import { rerankEffectMetrics } from './rerank-effect';

/** Below this share of joinable references resolving, the run is reporting staleness, not retrieval. */
const RESOLVED_SHARE_WARN = 0.9;

type ScoreCommand = {
  mode: 'score';
  runId: string;
  outDir: string | null;
  dryRun: boolean;
  judgementsPath: string | null;
  label: string | null;
  options: ScoringOptions;
};

type CompareCommand = {
  mode: 'compare';
  baselinePath: string;
  candidatePath: string;
};

type Command = ScoreCommand | CompareCommand;

const FUSION_POLICIES: FusionPolicy[] = ['best_rank', 'first_call', 'concat'];
const RANK_BASES: RankBasis[] = ['retrieved', 'reranked'];

const USAGE =
  'Usage:\n' +
  '  run-phase3.ts <runId> --out <dir> [--judgements <file>] [--label <text>]\n' +
  '                [--fusion best_rank|first_call|concat] [--basis retrieved|reranked]\n' +
  '                [--ks 1,3,5,10,20] [--coverage-floor 0.8] [--exclude-kinds facts]\n' +
  '  run-phase3.ts <runId> --dry-run [--judgements <file>]\n' +
  '  run-phase3.ts --compare <baseline.json> <candidate.json>';

export function parseArgs(argv: string[]): Command {
  const flagValue = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  // Only these consume the following argument, so `--dry-run <runId>` still finds its positional.
  const valueFlags = new Set([
    '--out',
    '--judgements',
    '--label',
    '--fusion',
    '--basis',
    '--ks',
    '--coverage-floor',
    '--exclude-kinds',
  ]);
  const flagValues = new Set(
    argv
      .map((arg, i) => (valueFlags.has(arg) ? argv[i + 1] : null))
      .filter((value): value is string => typeof value === 'string' && !value.startsWith('--')),
  );
  const positionals = argv.filter((arg) => !arg.startsWith('--') && !flagValues.has(arg));

  if (argv.includes('--compare')) {
    const compareIndex = argv.indexOf('--compare');
    const baselinePath = argv[compareIndex + 1];
    const candidatePath = argv[compareIndex + 2];
    if (!baselinePath || !candidatePath || baselinePath.startsWith('--') || candidatePath.startsWith('--')) {
      throw new Error(`--compare needs two snapshot paths.\n${USAGE}`);
    }
    return { mode: 'compare', baselinePath, candidatePath };
  }

  const runId = positionals[0];
  const outDir = flagValue('--out');
  const dryRun = argv.includes('--dry-run');

  if (!runId || (!outDir && !dryRun)) {
    throw new Error(`One of --out / --dry-run is required.\n${USAGE}`);
  }

  const fusion = flagValue('--fusion');
  if (fusion && !FUSION_POLICIES.includes(fusion as FusionPolicy)) {
    throw new Error(`--fusion must be one of ${FUSION_POLICIES.join(' | ')}.`);
  }
  const basis = flagValue('--basis');
  if (basis && !RANK_BASES.includes(basis as RankBasis)) {
    throw new Error(`--basis must be one of ${RANK_BASES.join(' | ')}.`);
  }

  const ksRaw = flagValue('--ks');
  const ks = ksRaw
    ? ksRaw.split(',').map((part) => {
        const k = Number.parseInt(part.trim(), 10);
        if (!Number.isInteger(k) || k <= 0) throw new Error(`--ks must be positive integers, got "${part}".`);
        return k;
      })
    : DEFAULT_SCORING_OPTIONS.ks;

  const floorRaw = flagValue('--coverage-floor');
  const coverageFloor = floorRaw === null ? DEFAULT_SCORING_OPTIONS.coverageFloor : Number(floorRaw);
  if (!Number.isFinite(coverageFloor) || coverageFloor < 0 || coverageFloor > 1) {
    throw new Error('--coverage-floor must be a number between 0 and 1.');
  }

  const excludeRaw = flagValue('--exclude-kinds');
  const excludeKinds = excludeRaw
    ? excludeRaw.split(',').map((kind) => kind.trim()).filter(Boolean)
    : DEFAULT_SCORING_OPTIONS.excludeKinds;

  return {
    mode: 'score',
    runId,
    outDir,
    dryRun,
    judgementsPath: flagValue('--judgements'),
    label: flagValue('--label'),
    options: {
      fusion: (fusion as FusionPolicy | null) ?? DEFAULT_SCORING_OPTIONS.fusion,
      basis: (basis as RankBasis | null) ?? DEFAULT_SCORING_OPTIONS.basis,
      ks,
      coverageFloor,
      excludeKinds,
    },
  };
}

function pct(share: number | null): string {
  return share === null ? 'n/a' : `${(share * 100).toFixed(1)}%`;
}

function num(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}

/** Sums the per-episode coverage blocks the adapter carried through, run-wide. */
export function summarizeEpisodeCoverage(episodes: RetrievalEpisode[]): Coverage {
  const totals = episodes.reduce(
    (acc, episode) => ({
      requested: acc.requested + episode.coverage.requested,
      resolved: acc.resolved + episode.coverage.resolved,
      missing: acc.missing + episode.coverage.missing,
      synthetic: acc.synthetic + episode.coverage.synthetic,
      noChunkId: acc.noChunkId + episode.coverage.noChunkId,
    }),
    { requested: 0, resolved: 0, missing: 0, synthetic: 0, noChunkId: 0 },
  );
  const joinable = totals.requested - totals.synthetic;
  return { ...totals, resolvedShare: joinable > 0 ? totals.resolved / joinable : null };
}

/** Projects a metric-core `ScoreResult<number>` onto the snapshot's storage shape. */
function toSnapshotScore(result: ScoreResult<number>): SnapshotScore {
  return result.scored
    ? { scored: true, value: result.value }
    : { scored: false, reason: result.reason, detail: result.detail };
}

/**
 * Runs every metric family over one episode.
 *
 * Each family returns a `Record<metricName, ScoreResult<number>>` so new metrics can appear in a
 * snapshot without a schema-version bump — the snapshot's `metrics` map is intentionally open.
 */
function scoreEpisode(
  episode: RetrievalEpisode,
  judgement: Judgement | undefined,
  options: ScoringOptions,
): SnapshotEpisodeResult {
  const results: Record<string, ScoreResult<number>> = {
    ...scoreEpisodeRank(episode, judgement, options).metrics,
    ...entityRecallMetrics(episode, judgement, options),
    ...rerankEffectMetrics(episode, judgement, options),
  };

  const metrics: Record<string, SnapshotScore> = {};
  for (const [name, result] of Object.entries(results)) {
    metrics[name] = toSnapshotScore(result);
  }

  return {
    episodeId: episode.episodeId,
    itemId: episode.itemId,
    rowIndex: episode.rowIndex,
    question: episode.question,
    passed: episode.passed,
    coverage: episode.coverage,
    metrics,
  };
}

/** Projects the aggregate module's `MetricAggregate` onto the snapshot's storage shape. */
function toAggregateEntry(rolled: MetricAggregate): SnapshotAggregateEntry {
  return {
    metric: rolled.metric,
    value: rolled.mean,
    scoredCount: rolled.nScored,
    unscorableCount: rolled.nUnscorable,
    unscorableByReason: rolled.unscorableByReason,
    median: rolled.median,
    min: rolled.min,
    max: rolled.max,
    ci: rolled.ci,
  };
}

/** Rolls per-episode results up per metric, keeping the denominator alongside every value. */
function aggregateAll(episodes: SnapshotEpisodeResult[]): SnapshotAggregateEntry[] {
  const metricNames = [...new Set(episodes.flatMap((episode) => Object.keys(episode.metrics)))].sort();

  return metricNames.map((metric) => {
    const results = episodes
      .map((episode) => episode.metrics[metric])
      .filter((score): score is SnapshotScore => score !== undefined);
    return toAggregateEntry(aggregateMetric(metric, results));
  });
}

/* ------------------------------------------------------------------------------------------------
 * Reporting. Denominators first, values last — see the header.
 * ---------------------------------------------------------------------------------------------- */

function reportCoverage(episodes: RetrievalEpisode[], coverage: Coverage): void {
  const withoutCalls = episodes.filter((episode) => episode.calls === null).length;
  const emptyCalls = episodes.filter((episode) => episode.calls !== null && episode.calls.length === 0).length;

  console.log('--- Coverage -------------------------------------------------------------');
  console.log(`Episodes: ${episodes.length}, chunk references: ${coverage.requested}.`);
  console.log(
    `Chunk text: ${coverage.resolved} resolved / ${coverage.missing} missing / ` +
      `${coverage.synthetic} synthetic / ${coverage.noChunkId} without a chunk id ` +
      `(${pct(coverage.resolvedShare)} of joinable refs resolved).`,
  );
  console.log(
    `Retrieval calls: ${withoutCalls} episode(s) predate per-call capture (calls = null, no rank ` +
      `data); ${emptyCalls} ran no retrieval (calls = []).`,
  );

  if (coverage.resolvedShare !== null && coverage.resolvedShare < RESOLVED_SHARE_WARN) {
    console.warn(
      `WARNING: only ${pct(coverage.resolvedShare)} of joinable chunk references resolved. The corpus ` +
        'has almost certainly been re-ingested since this run, so the unresolved chunks are a stale ' +
        'join, NOT missed retrieval. Do not put these numbers on a trend chart next to fresh ones.',
    );
  }
  if (withoutCalls === episodes.length && episodes.length > 0) {
    console.warn(
      'WARNING: no episode in this run carries `retrieval_calls`. Nothing rank-sensitive can be ' +
        'computed for it — every rank metric below will be unscorable, which is not a score of 0.',
    );
  }
}

function reportLabelling(labelling: LabellingCoverage, source: string): void {
  console.log('--- Labelling coverage ---------------------------------------------------');
  console.log(`Judgements file: ${source} (${labelling.judgements} judgement(s)).`);
  console.log(
    `Items: ${labelling.items} distinct; ${labelling.labelledItemIds.length} labelled, ` +
      `${labelling.unlabelledItemIds.length} unlabelled (${pct(labelling.labelledShare)} labelled).`,
  );
  console.log(
    `Usable ground truth: ${labelling.documentLabelledItemIds.length} item(s) for rank/document ` +
      `metrics, ${labelling.entityLabelledItemIds.length} for entity recall.`,
  );
  if (labelling.orphanJudgementItemIds.length > 0) {
    console.warn(
      `WARNING: ${labelling.orphanJudgementItemIds.length} judgement(s) reference items not in this ` +
        `run (${labelling.orphanJudgementItemIds.slice(0, 5).join(', ')}` +
        `${labelling.orphanJudgementItemIds.length > 5 ? ', …' : ''}). The question set has probably ` +
        'been re-seeded since labelling.',
    );
  }
  if (labelling.labelledItemIds.length === 0 && labelling.items > 0) {
    console.warn(
      'WARNING: nothing is labelled. Every metric below is unscorable — that is the honest current ' +
        'state (D1/D2/D4 are open), and it is NOT a score of 0.',
    );
  }
}

function reportUnscorable(unscorableByReason: Record<string, number>): void {
  console.log('--- Unscorable (episode × metric) ----------------------------------------');
  const entries = Object.entries(unscorableByReason).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    console.log('None.');
    return;
  }
  for (const [reason, count] of entries) {
    console.log(`  ${reason.padEnd(24)} ${count}`);
  }
}

function reportAggregates(aggregates: SnapshotAggregateEntry[]): void {
  console.log('--- Metrics --------------------------------------------------------------');
  if (aggregates.length === 0) {
    console.log('No metrics produced.');
    return;
  }
  for (const entry of aggregates) {
    // The n is on the same line as the value, always. A mean without its denominator is not a result.
    console.log(
      `  ${entry.metric.padEnd(24)} ${num(entry.value).padStart(8)}   ` +
        `n=${entry.scoredCount} scored, ${entry.unscorableCount} unscorable`,
    );
  }
}

/* ------------------------------------------------------------------------------------------------
 * Commands
 * ---------------------------------------------------------------------------------------------- */

async function loadEpisodes(runId: string): Promise<{
  episodes: RetrievalEpisode[];
  questionSetId: string;
  questionSetName: string | null;
}> {
  const run = await getTestResultById(runId);
  if (!run) {
    throw new Error(`No test run found for id ${runId}`);
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

  console.log(
    `Run ${run.id.slice(0, 8)} (${test?.name ?? 'unknown test'}, mode ${run.run_mode}): ` +
      `${records.length} items.`,
  );

  return {
    episodes: toRetrievalEpisodes(records, {
      runId: run.id,
      questionSetId: run.test_id,
      questionSetName: test?.name ?? null,
    }),
    questionSetId: run.test_id,
    questionSetName: test?.name ?? null,
  };
}

async function runScore(command: ScoreCommand): Promise<void> {
  const { episodes, questionSetId, questionSetName } = await loadEpisodes(command.runId);
  const coverage = summarizeEpisodeCoverage(episodes);

  const judgementsPath = command.judgementsPath;
  const loaded = judgementsPath
    ? await loadJudgementsFile(judgementsPath)
    : ({ ok: true, judgements: [] as Judgement[], source: '<none supplied>' } as const);
  if (!loaded.ok) {
    throw new Error(
      `Judgements file ${loaded.source} is invalid:\n` +
        loaded.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n'),
    );
  }
  const labelling = summarizeLabellingCoverage(episodes, loaded.judgements);

  // Denominators first. Always.
  reportCoverage(episodes, coverage);
  reportLabelling(labelling, loaded.source);

  if (command.dryRun) {
    console.log('--- Dry run --------------------------------------------------------------');
    console.log('Scored nothing and wrote nothing.');
    return;
  }

  const byItemId = indexJudgements(loaded.judgements);
  const episodeResults = episodes.map((episode) =>
    scoreEpisode(episode, byItemId.get(episode.itemId), command.options),
  );
  const unscorableByReason = tallyUnscorable(episodeResults);
  const aggregates = aggregateAll(episodeResults);

  reportUnscorable(unscorableByReason);
  reportAggregates(aggregates);

  if (!command.outDir) {
    return;
  }

  const createdAt = new Date().toISOString();
  const snapshot = buildSnapshot({
    snapshotId: randomUUID(),
    createdAt,
    runId: command.runId,
    questionSetId,
    questionSetName,
    label: command.label,
    options: command.options,
    episodeCount: episodes.length,
    coverage,
    labelling: {
      items: labelling.items,
      judgements: labelling.judgements,
      labelled: labelling.labelledItemIds.length,
      unlabelled: labelling.unlabelledItemIds.length,
      documentLabelled: labelling.documentLabelledItemIds.length,
      entityLabelled: labelling.entityLabelledItemIds.length,
      orphanJudgements: labelling.orphanJudgementItemIds.length,
      labelledShare: labelling.labelledShare,
    },
    episodes: episodeResults,
    aggregates,
    unscorableByReason,
    notes: null,
  });

  const file = path.join(path.resolve(command.outDir), snapshotFileName(command.runId, createdAt));
  await writeSnapshot(file, snapshot);
  console.log(`Wrote snapshot → ${file}`);
}

async function loadSnapshotOrThrow(filePath: string): Promise<Snapshot> {
  const result = await readSnapshot(filePath);
  if (!result.ok) {
    throw new Error(`${result.error}${result.issues ? `\n  ${result.issues.join('\n  ')}` : ''}`);
  }
  return result.snapshot;
}

async function runCompare(command: CompareCommand): Promise<void> {
  const [baseline, candidate] = await Promise.all([
    loadSnapshotOrThrow(command.baselinePath),
    loadSnapshotOrThrow(command.candidatePath),
  ]);

  console.log(
    `Baseline:  ${baseline.label ?? baseline.snapshotId} — run ${baseline.runId.slice(0, 8)}, ` +
      `${baseline.episodeCount} episodes, ${pct(baseline.coverage.resolvedShare)} resolved, ` +
      `${baseline.labelling.labelled}/${baseline.labelling.items} labelled.`,
  );
  console.log(
    `Candidate: ${candidate.label ?? candidate.snapshotId} — run ${candidate.runId.slice(0, 8)}, ` +
      `${candidate.episodeCount} episodes, ${pct(candidate.coverage.resolvedShare)} resolved, ` +
      `${candidate.labelling.labelled}/${candidate.labelling.items} labelled.`,
  );

  // Two snapshots scored under different options are not comparable — `best_rank` vs `first_call`
  // moves these metrics more than most retrieval changes do. Say so loudly rather than refusing:
  // sometimes the options change IS the experiment.
  if (JSON.stringify(baseline.options) !== JSON.stringify(candidate.options)) {
    console.warn(
      'WARNING: the two snapshots were scored under different ScoringOptions ' +
        `(baseline ${JSON.stringify(baseline.options)} vs candidate ${JSON.stringify(candidate.options)}). ` +
        'Any delta below mixes a scoring-policy change with a retrieval change.',
    );
  }

  const comparison = compareEpisodeSets(
    toEpisodeScores(baseline),
    toEpisodeScores(candidate),
    { baselineLabel: baseline.label, candidateLabel: candidate.label },
  );

  console.log('--- Pairing --------------------------------------------------------------');
  console.log(
    `${comparison.pairedItemCount} item(s) present on both sides; ${comparison.unpaired.length} ` +
      `unpaired; ${comparison.duplicateItemIds.length} duplicate item id(s).`,
  );
  for (const warning of comparison.coverageWarnings) {
    console.warn(`WARNING: ${warning.message}`);
  }

  console.log('--- Deltas (candidate − baseline) ----------------------------------------');
  for (const metric of comparison.metricOrder) {
    const entry = comparison.metrics[metric];
    if (!entry) continue;
    console.log(
      `  ${metric.padEnd(28)} ${num(entry.baselineMean).padStart(8)} → ` +
        `${num(entry.candidateMean).padStart(8)}   Δ ${num(entry.meanDelta).padStart(8)}   ` +
        `paired=${entry.nPaired}  +${entry.improved}/−${entry.regressed}/=${entry.unchanged}  ` +
        `p=${entry.signTest.pValue.toFixed(3)}`,
    );
  }
}

/**
 * Projects a snapshot's stored episodes back onto the shape `compare` consumes.
 *
 * `compare` pairs and aggregates over `EpisodeRankScores`, of which it reads `episodeId`, `itemId`,
 * `metrics` and `unscorable`. A snapshot deliberately does not persist `fused` — the fused candidate
 * lists are large, and after a corpus re-ingest their chunk ids point at nothing, which is the whole
 * reason the snapshot exists. They are therefore reconstructed as `null`, and the episode-level
 * `unscorable` is re-derived from the stored metrics: an episode is unscorable as a whole only when
 * every metric it carries failed for the same reason.
 */
function toEpisodeScores(snapshot: Snapshot): EpisodeRankScores[] {
  return snapshot.episodes.map((episode) => {
    const scores = Object.values(episode.metrics);
    const reasons = new Set(scores.filter((score) => !score.scored).map((score) => score.reason));
    const allUnscorable = scores.length > 0 && scores.every((score) => !score.scored);
    const shared = allUnscorable && reasons.size === 1 ? scores[0] : undefined;

    return {
      episodeId: episode.episodeId,
      itemId: episode.itemId,
      runId: snapshot.runId,
      options: snapshot.options,
      fused: null,
      unscorable: shared && !shared.scored ? shared : null,
      metrics: episode.metrics,
      rankOfFirstRelevant:
        episode.metrics['rank_of_first_relevant'] ??
        (shared && !shared.scored ? shared : { scored: true, value: null }),
    };
  });
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  if (command.mode === 'compare') {
    await runCompare(command);
    return;
  }
  await runScore(command);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
