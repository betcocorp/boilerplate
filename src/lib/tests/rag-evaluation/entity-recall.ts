/**
 * Entity recall — was the specific string the answer depends on inside the retrieved text?
 *
 * Document recall asks whether the right document was retrieved. On a regulated corpus that is too
 * coarse to be useful: an SDS can be retrieved, rank first, and still not contain the first-aid
 * instruction the question asked for, because the chunker dropped that section at ingest. That is
 * not hypothetical here — `rag.chunk_sds_document_text` discards any SDS section without a newline,
 * and 59% of SDS sections (16.4M of 30.9M characters of body text) never reach retrieval
 * (`src/docs/sds-chunk-section-loss.md`). Worse, the surviving label-only chunk
 * (`Eye contact Skin contact : :`) is a *strong* lexical match for the query it cannot answer, so
 * document recall and even a cross-encoder both score it as a hit.
 *
 * Entity recall is the instrument that sees through that: it matches against chunk `text`, so a
 * document whose answering section was dropped scores as a miss no matter how well it ranks.
 *
 * ## Design decisions worth knowing before reading the code
 *
 * - **Only `resolution === 'resolved'` candidates are searched.** A `missing` or `no_chunk_id`
 *   reference is a stale join — the chunk id in the persisted trace no longer resolves after a
 *   re-ingest — not evidence that retrieval failed. Searching an empty string there would report
 *   the docling migration, which changes every chunk id, as a total collapse of entity recall.
 * - **No resolved text at all is `unscorable('no_resolved_text')`, never 0.** Same reason, one
 *   level up.
 * - **Rank is reported, not just found/not-found.** An entity that first appears at rank 18 is
 *   retrieved in the arithmetic sense and invisible to the model in the practical one. The rank of
 *   first containment is the number that distinguishes "docling retrieved better" from "docling
 *   retrieved more".
 * - **The headline score covers `required` entities only.** Non-required entities are measured and
 *   reported in their own bucket so they can inform without moving the number.
 *
 * Pure: no DB, no network, no clock, no randomness.
 */

import { fuseEpisode } from './fuse';
import { findMatchingValue } from './normalize';
import {
  scored,
  unscorable,
  type Coverage,
  type EntityKind,
  type EntityRequirement,
  type Judgement,
  type RankedCandidate,
  type RetrievalEpisode,
  type ScoreResult,
  type ScoringOptions,
  DEFAULT_SCORING_OPTIONS,
} from './types';

/** Where an entity was first found in the ranked list, or the fact that it was not. */
export type EntityHit = {
  key: string;
  kind: EntityKind;
  required: boolean;
  found: boolean;
  /** The ground-truth surface form that matched, of the several a requirement may accept. */
  matchedValue: string | null;
  /** Chunk that first contained it. */
  chunkId: string | null;
  /** Document of that chunk. */
  documentId: string | null;
  /**
   * 1-based position of that chunk in the ranked list. 1-based because this number is read by
   * humans against "the model saw the top 5", and 0-based ranks are misread in that sentence.
   */
  rank: number | null;
};

/** Found / total / ratio for one bucket of entities. */
export type EntityBucket = {
  total: number;
  found: number;
  /** `found / total`, or null when the bucket is empty — an empty bucket is not a zero. */
  recall: number | null;
};

export type EntityRecallResult = {
  /** The headline: recall over `required` entities. */
  required: EntityBucket;
  /** Measured and reported, excluded from the headline. */
  optional: EntityBucket;
  /** Per-entity detail, in the order the requirements were given. */
  entities: EntityHit[];
  /** Mean 1-based rank of first containment across found *required* entities. */
  meanFoundRank: number | null;
  /** Worst (largest) such rank — the entity the model was least likely to actually read. */
  worstFoundRank: number | null;
  /** Candidates actually searched, i.e. resolved ones after kind exclusion. */
  searchedCandidates: number;
};

export type EntityRecallOptions = Pick<ScoringOptions, 'coverageFloor' | 'excludeKinds'>;

export const DEFAULT_ENTITY_RECALL_OPTIONS: EntityRecallOptions = {
  coverageFloor: DEFAULT_SCORING_OPTIONS.coverageFloor,
  excludeKinds: DEFAULT_SCORING_OPTIONS.excludeKinds,
};

/**
 * Score entity recall over one already-fused ranked candidate list.
 *
 * **Array order is the ranking.** The reported rank is `index + 1` in the list as given, not a
 * re-sort on `RankedCandidate.rank`: a fused list carries the per-call `rank` unchanged while its
 * real position is the fused one, so re-sorting here would report a position the model never saw.
 * Produce the list with `fuseCalls` / `fuseEpisode`, which emit it densely ordered.
 *
 * `coverage`, when supplied, is honoured exactly as the rank metrics honour it: an episode whose
 * `resolvedShare` sits below `coverageFloor` is unscorable rather than scored low, because a low
 * resolved share means the join is stale, not that retrieval missed. A null `resolvedShare` (every
 * reference synthetic) cannot be compared to the floor and falls through to the resolved-text check.
 */
export const scoreEntityRecall = (
  candidates: readonly RankedCandidate[],
  requirements: readonly EntityRequirement[],
  coverage?: Coverage | null,
  options: EntityRecallOptions = DEFAULT_ENTITY_RECALL_OPTIONS,
): ScoreResult<EntityRecallResult> => {
  if (requirements.length === 0) {
    return unscorable('no_judgement', 'no entity requirements for this item');
  }
  if (candidates.length === 0) {
    return unscorable('empty_retrieval', 'ranked candidate list is empty');
  }

  if (coverage && coverage.resolvedShare !== null && coverage.resolvedShare < options.coverageFloor) {
    return unscorable(
      'coverage_below_floor',
      `resolvedShare ${coverage.resolvedShare.toFixed(3)} < floor ${options.coverageFloor}`,
    );
  }

  const searchable = candidates.filter(
    (candidate) =>
      candidate.resolution === 'resolved' &&
      typeof candidate.text === 'string' &&
      candidate.text.length > 0 &&
      !options.excludeKinds.includes(candidate.documentKind ?? ''),
  );

  if (searchable.length === 0) {
    return unscorable(
      'no_resolved_text',
      `${candidates.length} candidate(s), none with resolved text`,
    );
  }

  const ordered = searchable;
  const entities = requirements.map((requirement) => locate(requirement, ordered));

  const requiredHits = entities.filter((entity) => entity.required);
  const optionalHits = entities.filter((entity) => !entity.required);
  const foundRequiredRanks = requiredHits
    .filter((entity) => entity.found && entity.rank !== null)
    .map((entity) => entity.rank as number);

  return scored({
    required: bucket(requiredHits),
    optional: bucket(optionalHits),
    entities,
    meanFoundRank:
      foundRequiredRanks.length === 0
        ? null
        : foundRequiredRanks.reduce((sum, rank) => sum + rank, 0) / foundRequiredRanks.length,
    worstFoundRank: foundRequiredRanks.length === 0 ? null : Math.max(...foundRequiredRanks),
    searchedCandidates: ordered.length,
  });
};

const bucket = (hits: readonly EntityHit[]): EntityBucket => {
  const found = hits.filter((hit) => hit.found).length;
  return { total: hits.length, found, recall: hits.length === 0 ? null : found / hits.length };
};

/**
 * Find the first (best-ranked) candidate whose text contains the entity.
 *
 * Matching is per-candidate and never across candidates. An EPA number split by a chunk boundary
 * (`…EPA Reg. No. 1839-` | `95…`) is genuinely not retrievable as a unit — the model is shown two
 * chunks and neither states the number — so counting it as found would hide exactly the chunking
 * defect this metric exists to expose.
 */
const locate = (
  requirement: EntityRequirement,
  ordered: readonly RankedCandidate[],
): EntityHit => {
  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index] as RankedCandidate;
    const matched = findMatchingValue(requirement.kind, requirement.values, candidate.text ?? '');
    if (matched !== null) {
      return {
        key: requirement.key,
        kind: requirement.kind,
        required: requirement.required,
        found: true,
        matchedValue: matched,
        chunkId: candidate.chunkId,
        documentId: candidate.documentId,
        rank: index + 1,
      };
    }
  }
  return {
    key: requirement.key,
    kind: requirement.kind,
    required: requirement.required,
    found: false,
    matchedValue: null,
    chunkId: null,
    documentId: null,
    rank: null,
  };
};

/* -------------------------------------------------------------------------------------------- */
/* Episode level                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * Score one episode against its judgement, fusing the turn's retrieval calls first.
 *
 * `calls === null` is `no_retrieval_calls` and `calls === []` is `empty_retrieval`; the contract
 * makes that distinction load-bearing (a backfilled run predates `retrieval_calls` and knows
 * nothing, a turn that searched nothing knows something) and collapsing it would let old runs read
 * as retrieval failures.
 */
export const scoreEpisodeEntityRecall = (
  episode: RetrievalEpisode,
  judgement: Judgement | null | undefined,
  options: ScoringOptions = DEFAULT_SCORING_OPTIONS,
): ScoreResult<EntityRecallResult> => {
  if (!judgement) return unscorable('no_judgement', `no judgement for item ${episode.itemId}`);
  const fused = fuseEpisode(episode, options);
  if (fused === null) {
    return unscorable('no_retrieval_calls', 'payload predates retrieval_calls');
  }
  return scoreEntityRecall(fused.candidates, judgement.entities, episode.coverage, {
    coverageFloor: options.coverageFloor,
    excludeKinds: options.excludeKinds,
  });
};

/**
 * Episode-level entity recall projected onto the flat `Record<metric, ScoreResult<number>>` shape
 * the snapshot runner stores.
 *
 * The rich {@link EntityRecallResult} is what a human debugging a regression reads; this is what a
 * snapshot diffs. `mean_found_rank` is carried into the flat form deliberately — a run whose
 * required-entity recall is unchanged while the mean rank of those entities slides from 3 to 12 has
 * regressed in the only sense the generation loop can feel.
 */
export const entityRecallMetrics = (
  episode: RetrievalEpisode,
  judgement: Judgement | null | undefined,
  options: ScoringOptions = DEFAULT_SCORING_OPTIONS,
): Record<string, ScoreResult<number>> => {
  const result = scoreEpisodeEntityRecall(episode, judgement, options);
  if (!result.scored) {
    return {
      'entity_recall.required': result,
      'entity_recall.optional': result,
      'entity_recall.mean_found_rank': result,
    };
  }
  const { required, optional, meanFoundRank } = result.value;
  return {
    'entity_recall.required':
      required.recall === null
        ? unscorable('no_judgement', 'no required entities labelled')
        : scored(required.recall),
    'entity_recall.optional':
      optional.recall === null
        ? unscorable('no_judgement', 'no non-required entities labelled')
        : scored(optional.recall),
    'entity_recall.mean_found_rank':
      meanFoundRank === null
        ? unscorable('no_resolved_text', 'no required entity was found, so it has no rank')
        : scored(meanFoundRank),
  };
};
