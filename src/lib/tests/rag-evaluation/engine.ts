import { aggregateMetric, type MetricAggregate } from './aggregate';
import { entityRecallMetrics } from './entity-recall';
import { indexJudgements, summarizeLabellingCoverage, type LabellingCoverage } from './judgements';
import { scoreEpisodeRank } from './rank-metrics';
import { rerankEffectMetrics } from './rerank-effect';
import {
  tallyUnscorable,
  type SnapshotAggregateEntry,
  type SnapshotEpisodeResult,
  type SnapshotScore,
} from './snapshot';
import type {
  Coverage,
  Judgement,
  RetrievalEpisode,
  ScoreResult,
  ScoringOptions,
  UnscorableReason,
} from './types';

function toSnapshotScore(result: ScoreResult<number>): SnapshotScore {
  return result.scored
    ? { scored: true, value: result.value }
    : { scored: false, reason: result.reason, detail: result.detail };
}

export function scoreRetrievalEpisode(
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
  for (const [name, result] of Object.entries(results)) metrics[name] = toSnapshotScore(result);

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

export function aggregateRetrievalEpisodes(
  episodes: SnapshotEpisodeResult[],
): SnapshotAggregateEntry[] {
  const metricNames = [...new Set(episodes.flatMap((episode) => Object.keys(episode.metrics)))].sort();
  return metricNames.map((metric) =>
    toAggregateEntry(
      aggregateMetric(
        metric,
        episodes
          .map((episode) => episode.metrics[metric])
          .filter((score): score is SnapshotScore => score !== undefined),
      ),
    ),
  );
}

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
  return {
    ...totals,
    resolvedShare: joinable > 0 ? totals.resolved / joinable : null,
  };
}

export type RagScoringResult = {
  coverage: Coverage;
  labelling: LabellingCoverage;
  episodes: SnapshotEpisodeResult[];
  aggregates: SnapshotAggregateEntry[];
  unscorableByReason: Partial<Record<UnscorableReason, number>>;
};

export function scoreRetrievalRun(
  episodes: RetrievalEpisode[],
  judgements: Judgement[],
  options: ScoringOptions,
): RagScoringResult {
  const byItemId = indexJudgements(judgements);
  const scoredEpisodes = episodes.map((episode) =>
    scoreRetrievalEpisode(episode, byItemId.get(episode.itemId), options),
  );
  return {
    coverage: summarizeEpisodeCoverage(episodes),
    labelling: summarizeLabellingCoverage(episodes, judgements),
    episodes: scoredEpisodes,
    aggregates: aggregateRetrievalEpisodes(scoredEpisodes),
    unscorableByReason: tallyUnscorable(scoredEpisodes),
  };
}
