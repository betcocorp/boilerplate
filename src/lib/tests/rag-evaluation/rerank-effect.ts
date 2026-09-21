/**
 * Rerank effect — did the cross-encoder earn its latency?
 *
 * Reranking (B0-280) sits after RRF fusion and over-fetches `limit × 5` candidates to give the
 * cross-encoder a larger pool. That costs a network round trip on every retrieval call, so the
 * question "did the reranked order put relevant documents in front of the model that the retrieved
 * order did not" has to be answerable with a number rather than an intuition.
 *
 * This module answers it on one episode, three ways:
 *
 * 1. **Rank displacement** of relevant documents — mean signed movement, positive = promoted.
 *    Reported alongside per-document rows, because a mean of +0.2 hides "one document promoted 9
 *    places and three demoted 3", and those are different reranker behaviours.
 * 2. **MRR on the retrieved order vs on the reranked order, and the lift between them.** MRR is the
 *    right headline for a first-relevant-result question and the lift is the part that answers "was
 *    it worth it".
 * 3. **Top-k crossings** per k — how many relevant documents entered the top k and how many left.
 *    The generation loop only ever reads a truncated context, so a promotion from 12 to 6 matters
 *    far more than one from 30 to 24, and only the crossing counts show that.
 *
 * ## Unscorable, not zero
 *
 * When every candidate has `rerankRank === null` the reranker did not run on this call. That is a
 * real and common state (a strategy that skips reranking, a Cohere failure that fell back), not a
 * reranker that achieved nothing, and scoring it 0 would drag the fleet average down with episodes
 * that never had a reranker to measure. The contract's {@link UnscorableReason} set is closed and
 * gained a `reranker_absent` member for this case, so it is bucketed on the reason with `detail`
 * saying the reranker did not run — the detail string is the part a reader must act on, and callers
 * that aggregate should bucket on it rather than on the reason alone.
 *
 * Pure: no DB, no network, no clock, no randomness.
 */

import { fuseEpisode } from './fuse';
import {
  scored,
  unscorable,
  type DocumentRelevance,
  type Judgement,
  type RankedCandidate,
  type RetrievalEpisode,
  type ScoreResult,
  type ScoringOptions,
  DEFAULT_SCORING_OPTIONS,
} from './types';

/** Detail string used when the reranker did not run. Callers may bucket on it. */
export const RERANKER_ABSENT_DETAIL = 'reranker did not run: every rerankRank is null';

/** How one relevant document moved between the two orders. */
export type DocumentDisplacement = {
  documentId: string;
  gain: number;
  /** 1-based best position in the order the retriever returned. */
  retrievedRank: number;
  /** 1-based best position after reranking. */
  rerankedRank: number;
  /** `retrievedRank - rerankedRank`. Positive = promoted, negative = demoted. */
  displacement: number;
};

/** Top-k membership change for one cut-off. */
export type TopKCrossing = {
  k: number;
  relevantInTopKRetrieved: number;
  relevantInTopKReranked: number;
  /** Relevant documents in the reranked top-k that were not in the retrieved top-k. */
  entered: number;
  /** Relevant documents in the retrieved top-k that the reranker pushed out. */
  left: number;
  /** `relevantInTopKReranked - relevantInTopKRetrieved`. */
  delta: number;
};

export type RerankEffectResult = {
  /** Candidates carrying both a `rank` and a `rerankRank`, i.e. the comparable population. */
  comparedCandidates: number;
  /** Distinct relevant documents present in that population. */
  relevantCompared: number;
  displacements: DocumentDisplacement[];
  /** Mean signed displacement over relevant documents; null when none are present. */
  meanDisplacement: number | null;
  /** Reciprocal rank of the first relevant document in the retrieved order (0 when none). */
  mrrRetrieved: number;
  /** Same, in the reranked order. */
  mrrReranked: number;
  /** `mrrReranked - mrrRetrieved`. Positive = reranking helped. */
  mrrLift: number;
  crossings: TopKCrossing[];
};

export type RerankEffectOptions = Pick<ScoringOptions, 'ks' | 'excludeKinds'>;

export const DEFAULT_RERANK_EFFECT_OPTIONS: RerankEffectOptions = {
  ks: DEFAULT_SCORING_OPTIONS.ks,
  excludeKinds: DEFAULT_SCORING_OPTIONS.excludeKinds,
};

/**
 * Measure the reranker's effect over one episode's candidate list.
 *
 * Positions are recomputed as dense 1-based ranks by sorting the comparable population, rather than
 * taken from `rank` / `rerankRank` directly. The population is a filtered subset (candidates lacking
 * one of the two ranks, and excluded document kinds, are dropped), so the stored ranks would leave
 * gaps and a gap makes both MRR and the top-k counts wrong in a way that looks plausible.
 *
 * Documents are scored at their **best** position, since one document can contribute several chunks
 * and the model reads the first one it reaches.
 */
export const scoreRerankEffect = (
  candidates: readonly RankedCandidate[],
  relevantDocuments: readonly DocumentRelevance[],
  options: RerankEffectOptions = DEFAULT_RERANK_EFFECT_OPTIONS,
): ScoreResult<RerankEffectResult> => {
  if (candidates.length === 0) {
    return unscorable('empty_retrieval', 'ranked candidate list is empty');
  }

  const relevant = new Map(
    relevantDocuments.filter((entry) => entry.gain > 0).map((entry) => [entry.documentId, entry.gain]),
  );
  if (relevant.size === 0) {
    return unscorable('no_judgement', 'no relevant documents labelled for this item');
  }

  const inScope = candidates.filter(
    (candidate) => !options.excludeKinds.includes(candidate.documentKind ?? ''),
  );
  const comparable = inScope.filter((candidate) => candidate.rerankRank !== null);

  if (comparable.length === 0) {
    return unscorable('reranker_absent', RERANKER_ABSENT_DETAIL);
  }

  const retrievedOrder = [...comparable].sort((a, b) => a.rank - b.rank);
  const rerankedOrder = [...comparable].sort(
    (a, b) => (a.rerankRank as number) - (b.rerankRank as number),
  );

  const retrievedPositions = bestPositionByDocument(retrievedOrder);
  const rerankedPositions = bestPositionByDocument(rerankedOrder);

  const displacements: DocumentDisplacement[] = [];
  for (const [documentId, retrievedRank] of retrievedPositions) {
    const gain = relevant.get(documentId);
    if (gain === undefined) continue;
    const rerankedRank = rerankedPositions.get(documentId);
    if (rerankedRank === undefined) continue;
    displacements.push({
      documentId,
      gain,
      retrievedRank,
      rerankedRank,
      displacement: retrievedRank - rerankedRank,
    });
  }
  displacements.sort((a, b) => b.displacement - a.displacement);

  const meanDisplacement =
    displacements.length === 0
      ? null
      : displacements.reduce((sum, row) => sum + row.displacement, 0) / displacements.length;

  const mrrRetrieved = reciprocalRank(retrievedOrder, relevant);
  const mrrReranked = reciprocalRank(rerankedOrder, relevant);

  const crossings = options.ks.map((k) => {
    const before = new Set(
      displacements.filter((row) => row.retrievedRank <= k).map((row) => row.documentId),
    );
    const after = new Set(
      displacements.filter((row) => row.rerankedRank <= k).map((row) => row.documentId),
    );
    const entered = [...after].filter((id) => !before.has(id)).length;
    const left = [...before].filter((id) => !after.has(id)).length;
    return {
      k,
      relevantInTopKRetrieved: before.size,
      relevantInTopKReranked: after.size,
      entered,
      left,
      delta: after.size - before.size,
    };
  });

  return scored({
    comparedCandidates: comparable.length,
    relevantCompared: displacements.length,
    displacements,
    meanDisplacement,
    mrrRetrieved,
    mrrReranked,
    mrrLift: mrrReranked - mrrRetrieved,
    crossings,
  });
};

/** Best (lowest) 1-based position each document reaches in an already-sorted list. */
const bestPositionByDocument = (ordered: readonly RankedCandidate[]): Map<string, number> => {
  const positions = new Map<string, number>();
  ordered.forEach((candidate, index) => {
    if (!positions.has(candidate.documentId)) positions.set(candidate.documentId, index + 1);
  });
  return positions;
};

/**
 * Reciprocal rank of the first relevant document in an ordering; 0 when none is present.
 *
 * 0 rather than null here, unlike everywhere else in this file: the ordering exists and contains no
 * relevant document, which is a genuine measurement of a bad retrieval, not an absent one. The
 * absent cases are already handled by the `unscorable` returns above.
 */
const reciprocalRank = (
  ordered: readonly RankedCandidate[],
  relevant: ReadonlyMap<string, number>,
): number => {
  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index] as RankedCandidate;
    if (relevant.has(candidate.documentId)) return 1 / (index + 1);
  }
  return 0;
};

/* -------------------------------------------------------------------------------------------- */
/* Episode level                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * Measure the reranker's effect on one episode.
 *
 * Fusion uses the `retrieved` basis regardless of `options.basis`: this metric compares the two
 * orders itself, from each candidate's `rank` and `rerankRank`, so fusing on the reranked basis
 * would only pre-apply half of the comparison it is about to make.
 */
export const scoreEpisodeRerankEffect = (
  episode: RetrievalEpisode,
  judgement: Judgement | null | undefined,
  options: ScoringOptions = DEFAULT_SCORING_OPTIONS,
): ScoreResult<RerankEffectResult> => {
  if (!judgement) return unscorable('no_judgement', `no judgement for item ${episode.itemId}`);
  const fused = fuseEpisode(episode, {
    fusion: options.fusion,
    basis: 'retrieved',
    excludeKinds: options.excludeKinds,
  });
  if (fused === null) return unscorable('no_retrieval_calls', 'payload predates retrieval_calls');
  return scoreRerankEffect(fused.candidates, judgement.relevantDocuments, {
    ks: options.ks,
    excludeKinds: options.excludeKinds,
  });
};

/**
 * Rerank effect projected onto the flat `Record<metric, ScoreResult<number>>` shape the snapshot
 * runner stores. `rerank.mrr_lift` is the headline; the crossings are carried per k because a lift
 * that comes entirely from movement below k did not change what the model actually read.
 */
export const rerankEffectMetrics = (
  episode: RetrievalEpisode,
  judgement: Judgement | null | undefined,
  options: ScoringOptions = DEFAULT_SCORING_OPTIONS,
): Record<string, ScoreResult<number>> => {
  const result = scoreEpisodeRerankEffect(episode, judgement, options);
  const names = [
    'rerank.mrr_retrieved',
    'rerank.mrr_reranked',
    'rerank.mrr_lift',
    'rerank.mean_displacement',
    ...options.ks.flatMap((k) => [`rerank.entered_top_${k}`, `rerank.left_top_${k}`]),
  ];
  if (!result.scored) {
    return Object.fromEntries(names.map((name) => [name, result]));
  }
  const value = result.value;
  const out: Record<string, ScoreResult<number>> = {
    'rerank.mrr_retrieved': scored(value.mrrRetrieved),
    'rerank.mrr_reranked': scored(value.mrrReranked),
    'rerank.mrr_lift': scored(value.mrrLift),
    'rerank.mean_displacement':
      value.meanDisplacement === null
        ? unscorable('no_judgement', 'no labelled relevant document survived fusion')
        : scored(value.meanDisplacement),
  };
  for (const crossing of value.crossings) {
    out[`rerank.entered_top_${crossing.k}`] = scored(crossing.entered);
    out[`rerank.left_top_${crossing.k}`] = scored(crossing.left);
  }
  return out;
};
