/**
 * Fusion — collapse the several retrieval calls a turn made into the single ranked list every
 * rank metric consumes.
 *
 * A turn is not one search. The agent loop may call `search_products`, then a second, narrower
 * search, then a label lookup; each returns its own 0-based ranking. `precision@5` has no meaning
 * until those become one list, and *how* they become one list changes the number — so the policy
 * ({@link FusionPolicy}) and the basis ({@link RankBasis}) are explicit parameters, and the result
 * carries both back out so no reported figure is separable from the choice that produced it.
 *
 * Three things here are judgement calls rather than mechanics, and each is documented at its
 * implementation: the dedupe key, the point in the pipeline where `excludeKinds` is applied, and
 * the per-call fallback when the reranker did not run.
 *
 * Pure: no DB, no clock, no randomness.
 */

import type {
  FusionPolicy,
  RankBasis,
  RankedCandidate,
  RetrievalCall,
  RetrievalEpisode,
  ScoringOptions,
} from './types';

/** The subset of {@link ScoringOptions} fusion actually reads. */
export type FusionOptions = Pick<ScoringOptions, 'fusion' | 'basis' | 'excludeKinds'>;

/** A candidate placed in the fused list, with the provenance needed to explain its position. */
export type FusedCandidate = RankedCandidate & {
  /** 0-based position in the fused list. Always dense: 0, 1, 2, … with no gaps. */
  fusedRank: number;
  /** Index into `episode.calls` of the call this position came from. */
  callIndex: number;
  /** The within-call position fusion sorted on: `rerankRank` under a reranked basis, else `rank`. */
  basisRank: number;
  /**
   * True when this candidate's call had no reranker output and `basisRank` therefore came from
   * `rank` despite `basis === 'reranked'`.
   */
  rerankFallback: boolean;
  /** How many later duplicates of this candidate's dedupe key were dropped in its favour. */
  duplicatesAbsorbed: number;
};

/** Per-call record of whether the reranked basis was actually available. */
export type CallBasisProvenance = {
  callIndex: number;
  toolName: string;
  callId: string | null;
  /** Candidates surviving `excludeKinds` in this call. */
  candidateCount: number;
  /** True when `basis === 'reranked'` but this call fell back to `rank`. */
  rerankFallback: boolean;
  /** How many surviving candidates in this call had a null `rerankRank`. */
  nullRerankRankCount: number;
};

/**
 * The fused list plus the provenance a caller needs to know what it is looking at.
 *
 * Returning a bare array would let a partly-unreranked ranking be reported as a "reranked" number,
 * which is exactly the confusion `rerank-effect` exists to avoid. `basisIsPure` is the one-bit
 * version of that: false means at least one call contributed retriever order to a reranked list.
 */
export type FusedRanking = {
  candidates: FusedCandidate[];
  policy: FusionPolicy;
  basis: RankBasis;
  /** Calls considered (after `first_call` narrowing), with their basis provenance. */
  calls: CallBasisProvenance[];
  /** True when every considered call supplied the requested basis. Always true for `retrieved`. */
  basisIsPure: boolean;
  /** Calls that fell back from `rerankRank` to `rank`. */
  rerankFallbackCalls: number;
  /** Candidates whose `basisRank` came from the fallback. */
  rerankFallbackCandidates: number;
  /** Candidates removed by `excludeKinds`, across the considered calls. */
  excludedByKind: number;
  /** Candidate rows dropped because their dedupe key had already been seen. */
  duplicatesDropped: number;
};

/**
 * Dedupe key.
 *
 * Chunk id when present, document id otherwise. Two chunks of one document are genuinely two
 * retrieved contexts and both occupy positions, so collapsing them would understate list length
 * and inflate precision. But a reference with no chunk id (a synthetic verified-facts block, or a
 * pre-Phase-0 trace) has nothing finer than its document to be identified by, and repeating it
 * would manufacture positions that the model never saw as distinct.
 *
 * Note the asymmetry this implies and accept it: a document may appear once keyed by its id and
 * again keyed by a chunk id. That is correct — they are different rows with different text.
 */
const dedupeKey = (candidate: RankedCandidate): string =>
  candidate.chunkId === null ? `doc:${candidate.documentId}` : `chunk:${candidate.chunkId}`;

const isExcluded = (candidate: RankedCandidate, excludeKinds: readonly string[]): boolean =>
  candidate.documentKind !== null && excludeKinds.includes(candidate.documentKind);

type PreparedCall = {
  provenance: CallBasisProvenance;
  /** Surviving candidates, sorted by the basis, each tagged with its basis rank. */
  entries: Array<{ candidate: RankedCandidate; basisRank: number; callIndex: number; rerankFallback: boolean }>;
  excludedByKind: number;
};

/**
 * Prepare one call: filter, decide the basis, sort.
 *
 * **`excludeKinds` is applied before ranks are recomputed.** Filtering after ranking would leave
 * holes — a list whose surviving positions are 0, 2, 5 — and every @k metric would then silently
 * measure a shorter list than its cut-off implies. Filtering first makes positions dense, so
 * `precision@5` really is over five things the model saw and was allowed to be judged on.
 *
 * **The reranker fallback is per call, not per candidate.** `rerankRank` is null for a whole call
 * when the reranker did not run on it; a list half-ordered by cross-encoder position and half by
 * cosine position is not an ordering of anything. So if *any* surviving candidate in a call lacks
 * `rerankRank`, that entire call is ordered by `rank`, and the fallback is recorded on the call and
 * on each of its candidates.
 */
const prepareCall = (call: RetrievalCall, callIndex: number, options: FusionOptions): PreparedCall => {
  const kept = call.candidates.filter((candidate) => !isExcluded(candidate, options.excludeKinds));
  const excludedByKind = call.candidates.length - kept.length;

  const nullRerankRankCount = kept.filter((candidate) => candidate.rerankRank === null).length;
  const rerankFallback = options.basis === 'reranked' && nullRerankRankCount > 0;
  const useRerank = options.basis === 'reranked' && !rerankFallback;

  const entries = kept
    .map((candidate) => ({
      candidate,
      basisRank: useRerank ? (candidate.rerankRank ?? candidate.rank) : candidate.rank,
      callIndex,
      rerankFallback,
    }))
    // Stable sort on the basis rank. Ties (two candidates reported at the same position, which the
    // trace does occasionally contain) keep the retriever's emitted order rather than being
    // reshuffled, so the fused list is a deterministic function of the payload.
    .sort((a, b) => a.basisRank - b.basisRank);

  return {
    provenance: {
      callIndex,
      toolName: call.toolName,
      callId: call.callId,
      candidateCount: kept.length,
      rerankFallback,
      nullRerankRankCount,
    },
    entries,
    excludedByKind,
  };
};

/**
 * Fuse a turn's retrieval calls into one ranked list.
 *
 * `best_rank` (the default) takes the union and gives each dedupe key its lowest basis rank across
 * calls — it models what the model actually had in front of it. `first_call` keeps only the first
 * call, isolating the retriever from the agent's decision to search again. `concat` walks the calls
 * in order and keeps first occurrences, preserving encounter order.
 *
 * Under `best_rank`, ties on the winning basis rank are broken by the earlier call and then by
 * first occurrence, which is the only tie-break that keeps the output independent of array
 * iteration accidents.
 */
export const fuseCalls = (calls: readonly RetrievalCall[], options: FusionOptions): FusedRanking => {
  const considered = options.fusion === 'first_call' ? calls.slice(0, 1) : calls.slice();
  const prepared = considered.map((call, index) => prepareCall(call, index, options));

  type Winner = {
    entry: PreparedCall['entries'][number];
    order: number;
    duplicatesAbsorbed: number;
  };

  const winners = new Map<string, Winner>();
  let order = 0;
  let duplicatesDropped = 0;

  for (const call of prepared) {
    for (const entry of call.entries) {
      const key = dedupeKey(entry.candidate);
      const existing = winners.get(key);
      if (existing === undefined) {
        winners.set(key, { entry, order: order++, duplicatesAbsorbed: 0 });
        continue;
      }
      duplicatesDropped += 1;
      existing.duplicatesAbsorbed += 1;
      // `best_rank` is the only policy that lets a later call improve a placement; `concat` and
      // `first_call` are defined by first occurrence.
      if (options.fusion === 'best_rank' && entry.basisRank < existing.entry.basisRank) {
        existing.entry = entry;
      }
    }
  }

  const ordered = [...winners.values()].sort((a, b) => {
    if (options.fusion === 'best_rank') {
      if (a.entry.basisRank !== b.entry.basisRank) return a.entry.basisRank - b.entry.basisRank;
      if (a.entry.callIndex !== b.entry.callIndex) return a.entry.callIndex - b.entry.callIndex;
    }
    return a.order - b.order;
  });

  const candidates: FusedCandidate[] = ordered.map((winner, index) => ({
    ...winner.entry.candidate,
    fusedRank: index,
    callIndex: winner.entry.callIndex,
    basisRank: winner.entry.basisRank,
    rerankFallback: winner.entry.rerankFallback,
    duplicatesAbsorbed: winner.duplicatesAbsorbed,
  }));

  const rerankFallbackCalls = prepared.filter((call) => call.provenance.rerankFallback).length;

  return {
    candidates,
    policy: options.fusion,
    basis: options.basis,
    calls: prepared.map((call) => call.provenance),
    basisIsPure: rerankFallbackCalls === 0,
    rerankFallbackCalls,
    rerankFallbackCandidates: candidates.filter((candidate) => candidate.rerankFallback).length,
    excludedByKind: prepared.reduce((sum, call) => sum + call.excludedByKind, 0),
    duplicatesDropped,
  };
};

/**
 * Fuse an episode's calls.
 *
 * Returns `null` when `calls` is `null`, which per the contract means "the persisted payload
 * predates `retrieval_calls`" and is categorically different from `[]` ("the turn retrieved
 * nothing"). Callers must branch on the null rather than treating it as an empty list; the rank
 * metrics turn it into `unscorable('no_retrieval_calls')`.
 */
export const fuseEpisode = (episode: RetrievalEpisode, options: FusionOptions): FusedRanking | null =>
  episode.calls === null ? null : fuseCalls(episode.calls, options);
