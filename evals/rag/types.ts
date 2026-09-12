/**
 * Phase 3 of the RAG evaluation process — rank quality and entity recall.
 *
 * This file is the contract every other module in `evals/rag/` codes against. It is deliberately
 * the only place shared shapes are declared, so the metric modules can be written and tested
 * independently of each other and of the database.
 *
 * ## Layering
 *
 * 1. **Acquisition** (touches the DB) — `src/lib/tests/retrieval-dataset.ts` and
 *    `scripts/export-retrieval-dataset.ts`, built in Phase 0. Phase 3 does not rebuild it; the
 *    adapter in `adapters/` maps its `RetrievalEvalRecord` onto {@link RetrievalEpisode}.
 * 2. **Metric core** (pure) — everything else here. No DB client, no fetch, no clock, no `Math.random`
 *    outside an injected RNG. Metrics take an in-memory array and return numbers, so they can be
 *    exercised against fixtures rather than against whatever the local database happens to hold
 *    today. That matters concretely: the local DB is not built from migrations (F7) and carries
 *    stuck runs and counter drift (F9), so a metric only testable against live rows is a metric
 *    nobody can debug.
 * 3. **Runner** (touches the DB) — the CLI, which calls layer 1, feeds layer 2 and writes a JSON
 *    snapshot. Snapshots are the unit of comparison, so a pre-docling baseline survives the
 *    re-ingest that makes its chunk ids dangling.
 *
 * ## What this phase is for
 *
 * The docling migration raises SDS chunk count roughly 6x. Coverage cannot say whether that
 * retrieved *better* or merely retrieved *more*; rank quality and entity recall can. Every design
 * choice here follows from that question.
 */

/**
 * Why a retrieved chunk reference does or does not have text. Mirrors
 * `ContextResolution` in `src/lib/tests/retrieval-dataset.ts` — kept as its own declaration so the
 * eval core does not import from `src/`, but the string values must stay identical or the adapter
 * silently mislabels.
 */
export type ContextResolution = 'resolved' | 'missing' | 'synthetic' | 'no_chunk_id';

/** How much of a turn's retrieval could be joined back to live chunk text. */
export type Coverage = {
  requested: number;
  resolved: number;
  missing: number;
  synthetic: number;
  noChunkId: number;
  /**
   * `resolved / (requested - synthetic)`. Null when that denominator is 0. Synthetic references
   * (verified-facts blocks, lab reports) never had a `document_chunk` row, so counting them as
   * misses would penalise a turn for retrieving something that worked.
   */
  resolvedShare: number | null;
};

/** One retrieved chunk at one position in one retrieval call. */
export type RankedCandidate = {
  documentId: string;
  chunkId: string | null;
  documentKind: string | null;
  documentTitle: string | null;
  /** 0-based position in the order the retriever returned for this call. */
  rank: number;
  /** Pre-rerank hybrid/cosine score. */
  similarity: number | null;
  /** Cross-encoder score; null when the reranker did not run on this call. */
  rerankScore: number | null;
  /** 0-based post-rerank position; null when the reranker did not run. */
  rerankRank: number | null;
  /** Chunk body, when the join resolved it. Entity matching reads only this. */
  text: string | null;
  resolution: ContextResolution;
};

/** One tool invocation's ranked result list. A turn may issue several. */
export type RetrievalCall = {
  toolName: string;
  callId: string | null;
  /** `RagSearchResult.retrieval_strategy` when the trace recorded one. */
  strategy: string | null;
  candidates: RankedCandidate[];
};

/**
 * One graded question in one run — the unit every metric consumes.
 *
 * `calls` is nullable on purpose and the distinction is load-bearing: `[]` means the turn ran no
 * retrieval, `null` means the persisted payload predates `retrieval_calls` and we cannot know.
 * A rank metric must skip a `null` and must never read it as a zero. Backfilled runs are all
 * `null`, which is why rank data only starts accruing once Phase 0 ships.
 */
export type RetrievalEpisode = {
  episodeId: string;
  itemId: string;
  runId: string;
  questionSetId: string;
  questionSetName: string | null;
  rowIndex: number;
  question: string;
  answer: string | null;
  /** `test_items.ideal_response`. */
  reference: string | null;
  passed: boolean;
  calls: RetrievalCall[] | null;
  coverage: Coverage;
};

/** A document that should be retrieved, with its graded gain for nDCG. */
export type DocumentRelevance = {
  documentId: string;
  /**
   * Graded relevance. 0 = irrelevant, 1 = related, 2 = answers the question. Binary metrics treat
   * anything > 0 as relevant, so a purely binary label set can use gain 1 throughout.
   */
  gain: number;
};

/** What kind of value an entity requirement holds, which selects the normalizer. */
export type EntityKind =
  | 'epa_registration'
  | 'din'
  | 'dilution'
  | 'contact_time'
  | 'literal';

/**
 * A fact the answer turns on, which retrieval must therefore surface.
 *
 * Entity recall asks a narrower question than document recall: not "was the right document
 * retrieved" but "was the specific string the answer depends on inside the retrieved text". For a
 * regulated corpus that is the sharper instrument — an SDS can be retrieved while the first-aid
 * section that answers the question sits in a part of it no chunk covers, which is precisely the
 * defect docling exists to fix.
 */
export type EntityRequirement = {
  /** Stable key for reporting, e.g. `epa_registration`. Unique within a judgement. */
  key: string;
  kind: EntityKind;
  /**
   * Accepted surface forms. Matching normalizes both sides per {@link EntityKind}, so this holds
   * the value as a human would write it, not a pre-normalized token.
   */
  values: string[];
  /** A non-required entity is measured and reported but excluded from the headline score. */
  required: boolean;
};

/**
 * Ground truth for one test item. Produced by the labelling work (D1/D2/D4), not by this code.
 *
 * `relevantDocuments` empty plus `isNegative` false means "unlabelled" — such an item is
 * unscorable, not a zero. Conflating the two is the failure mode that quietly poisons recall.
 */
export type Judgement = {
  itemId: string;
  relevantDocuments: DocumentRelevance[];
  entities: EntityRequirement[];
  /** True when the correct behaviour is to retrieve nothing (pricing, non-existent product, …). */
  isNegative: boolean;
  notes: string | null;
};

/** Why an episode produced no score. Never collapse one of these into 0. */
export type UnscorableReason =
  | 'no_retrieval_calls'
  | 'empty_retrieval'
  | 'no_judgement'
  | 'coverage_below_floor'
  | 'no_resolved_text'
  /**
   * The reranker did not run on this turn — every `rerankRank` was null. Its own member rather than
   * a flavour of `empty_retrieval`, because an aggregator buckets on the reason: folding the two
   * together would make "the reranker was off" indistinguishable from "retrieval returned nothing",
   * and the first is a routine configuration state while the second is a fault.
   */
  | 'reranker_absent';

export type Unscorable = {
  scored: false;
  reason: UnscorableReason;
  detail: string | null;
};

export type Scored<T> = { scored: true; value: T };

export type ScoreResult<T> = Scored<T> | Unscorable;

export const unscorable = (reason: UnscorableReason, detail: string | null = null): Unscorable => ({
  scored: false,
  reason,
  detail,
});

export const scored = <T>(value: T): Scored<T> => ({ scored: true, value });

/**
 * How several retrieval calls in one turn become the single ranked list a rank metric needs.
 *
 * - `best_rank` — union across calls, each document keeping its best (lowest) rank. Models "the
 *   model saw all of this", which is what actually happened.
 * - `first_call` — the first call only. Isolates the retriever from the agent's decision to search
 *   again, so a change in loop behaviour cannot masquerade as a retrieval change.
 * - `concat` — calls in order, duplicates dropped at first occurrence. Preserves the order the
 *   model encountered contexts in.
 *
 * There is no single correct policy, so it is an explicit parameter and every reported number
 * carries the policy that produced it. `best_rank` is the default.
 */
export type FusionPolicy = 'best_rank' | 'first_call' | 'concat';

/**
 * Whether to rank by the order the retriever returned or by the reranker's output. Comparing the
 * two on the same episode is how `rerank-effect` measures whether reranking earned its latency.
 */
export type RankBasis = 'retrieved' | 'reranked';

export type ScoringOptions = {
  fusion: FusionPolicy;
  basis: RankBasis;
  /** Cut-offs for @k metrics. */
  ks: number[];
  /**
   * Minimum `coverage.resolvedShare` to score an episode. Below it the episode is unscorable rather
   * than scored low: unresolved chunks are a stale join, not a retrieval failure, and scoring them
   * as misses reads a corpus re-ingest as a retrieval collapse.
   */
  coverageFloor: number;
  /** Exclude these document kinds from candidate lists, e.g. `['facts']`. */
  excludeKinds: string[];
};

export const DEFAULT_SCORING_OPTIONS: ScoringOptions = {
  fusion: 'best_rank',
  basis: 'reranked',
  ks: [1, 3, 5, 10, 20],
  coverageFloor: 0.8,
  excludeKinds: [],
};
