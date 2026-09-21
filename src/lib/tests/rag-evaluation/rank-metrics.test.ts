import { describe, expect, it } from 'vitest';

import {
  averagePrecision,
  hitAtK,
  metricKey,
  ndcgAtK,
  precisionAtK,
  prepareRankContext,
  rankMetricKeys,
  rankOfFirstRelevant,
  recallAtK,
  reciprocalRank,
  scoreEpisodeRank,
} from './rank-metrics';
import {
  DEFAULT_SCORING_OPTIONS,
  type Coverage,
  type Judgement,
  type RankedCandidate,
  type RetrievalCall,
  type RetrievalEpisode,
  type ScoreResult,
  type ScoringOptions,
} from './types';

const options = (overrides: Partial<ScoringOptions> = {}): ScoringOptions => ({
  ...DEFAULT_SCORING_OPTIONS,
  basis: 'retrieved',
  ks: [1, 3, 5],
  ...overrides,
});

const coverage = (overrides: Partial<Coverage> = {}): Coverage => ({
  requested: 3,
  resolved: 3,
  missing: 0,
  synthetic: 0,
  noChunkId: 0,
  resolvedShare: 1,
  ...overrides,
});

const candidateFor = (documentId: string, rank: number, chunkId: string | null = null): RankedCandidate => ({
  documentId,
  chunkId,
  documentKind: 'sds',
  documentTitle: null,
  rank,
  similarity: null,
  rerankScore: null,
  rerankRank: null,
  text: null,
  resolution: 'resolved',
});

/** One call whose candidates are the given document ids in order. */
const callOf = (documentIds: string[], chunkIds?: (string | null)[]): RetrievalCall => ({
  toolName: 'search_products',
  callId: null,
  strategy: null,
  candidates: documentIds.map((id, index) => candidateFor(id, index, chunkIds?.[index] ?? null)),
});

const episodeOf = (
  calls: RetrievalCall[] | null,
  overrides: Partial<RetrievalEpisode> = {},
): RetrievalEpisode => ({
  episodeId: 'e1',
  itemId: 'i1',
  runId: 'r1',
  questionSetId: 'qs1',
  questionSetName: null,
  rowIndex: 0,
  question: 'What is the dilution?',
  answer: null,
  reference: null,
  passed: true,
  calls,
  coverage: coverage(),
  ...overrides,
});

const judgementOf = (
  relevant: Array<[string, number]>,
  overrides: Partial<Judgement> = {},
): Judgement => ({
  itemId: 'i1',
  relevantDocuments: relevant.map(([documentId, gain]) => ({ documentId, gain })),
  entities: [],
  isNegative: false,
  notes: null,
  ...overrides,
});

const value = <T>(result: ScoreResult<T>): T => {
  if (!result.scored) throw new Error(`expected scored, got unscorable: ${result.reason}`);
  return result.value;
};

const reasonOf = (result: ScoreResult<unknown>): string => {
  if (result.scored) throw new Error('expected unscorable');
  return result.reason;
};

describe('prepareRankContext gates', () => {
  const judgement = judgementOf([['a', 1]]);

  it('reports null calls as no_retrieval_calls', () => {
    expect(reasonOf(prepareRankContext(episodeOf(null), judgement, options()))).toBe('no_retrieval_calls');
  });

  it('reports a missing judgement as no_judgement', () => {
    expect(reasonOf(prepareRankContext(episodeOf([callOf(['a'])]), null, options()))).toBe('no_judgement');
  });

  it('reports an unlabelled item as no_judgement, not as a zero', () => {
    const unlabelled = judgementOf([]);
    const result = prepareRankContext(episodeOf([callOf(['a'])]), unlabelled, options());
    expect(reasonOf(result)).toBe('no_judgement');
  });

  it('treats a judgement of only zero-gain labels as unlabelled', () => {
    const result = prepareRankContext(episodeOf([callOf(['a'])]), judgementOf([['a', 0]]), options());
    expect(reasonOf(result)).toBe('no_judgement');
  });

  it('marks a negative example unscorable with a negative_example detail', () => {
    const negative = judgementOf([], { isNegative: true });
    const result = prepareRankContext(episodeOf([callOf(['a'])]), negative, options());
    expect(result.scored).toBe(false);
    if (!result.scored) {
      expect(result.reason).toBe('no_judgement');
      expect(result.detail).toBe('negative_example');
    }
  });

  it('gates an episode below the coverage floor', () => {
    const episode = episodeOf([callOf(['a'])], { coverage: coverage({ resolvedShare: 0.5 }) });
    expect(reasonOf(prepareRankContext(episode, judgement, options({ coverageFloor: 0.8 })))).toBe(
      'coverage_below_floor',
    );
  });

  it('does not gate an episode whose resolvedShare is null', () => {
    const episode = episodeOf([callOf(['a'])], {
      coverage: coverage({ requested: 2, synthetic: 2, resolved: 0, resolvedShare: null }),
    });
    expect(prepareRankContext(episode, judgement, options()).scored).toBe(true);
  });

  it('reports an empty candidate list as empty_retrieval', () => {
    expect(reasonOf(prepareRankContext(episodeOf([]), judgement, options()))).toBe('empty_retrieval');
    expect(reasonOf(prepareRankContext(episodeOf([callOf([])]), judgement, options()))).toBe('empty_retrieval');
  });

  it('reports empty_retrieval when excludeKinds removed everything', () => {
    const episode = episodeOf([callOf(['a'])]);
    expect(reasonOf(prepareRankContext(episode, judgement, options({ excludeKinds: ['sds'] })))).toBe(
      'empty_retrieval',
    );
  });
});

describe('binary rank metrics', () => {
  const episode = episodeOf([callOf(['x', 'a', 'y', 'b'])]);
  const judgement = judgementOf([
    ['a', 2],
    ['b', 1],
    ['c', 1],
  ]);
  const opts = options();

  it('hitAtK sees nothing at k=1 and a hit at k=3', () => {
    expect(value(hitAtK(episode, judgement, opts, 1))).toBe(0);
    expect(value(hitAtK(episode, judgement, opts, 3))).toBe(1);
  });

  it('recallAtK counts distinct relevant documents over all judged relevant documents', () => {
    expect(value(recallAtK(episode, judgement, opts, 3))).toBeCloseTo(1 / 3);
    expect(value(recallAtK(episode, judgement, opts, 5))).toBeCloseTo(2 / 3);
  });

  it('recallAtK does not double count two chunks of one relevant document', () => {
    const chunked = episodeOf([callOf(['a', 'a'], ['a#1', 'a#2'])]);
    expect(value(recallAtK(chunked, judgement, opts, 5))).toBeCloseTo(1 / 3);
  });

  it('precisionAtK divides by the positions actually examined when k exceeds the list', () => {
    // 2 relevant of 4 examined, even though k is 20.
    expect(value(precisionAtK(episode, judgement, opts, 20))).toBeCloseTo(0.5);
    expect(value(precisionAtK(episode, judgement, opts, 2))).toBeCloseTo(0.5);
  });

  it('scores an all-irrelevant list as a genuine zero, not unscorable', () => {
    const missed = episodeOf([callOf(['x', 'y', 'z'])]);
    expect(value(hitAtK(missed, judgement, opts, 5))).toBe(0);
    expect(value(recallAtK(missed, judgement, opts, 5))).toBe(0);
    expect(value(precisionAtK(missed, judgement, opts, 5))).toBe(0);
    expect(value(reciprocalRank(missed, judgement, opts))).toBe(0);
    expect(value(averagePrecision(missed, judgement, opts))).toBe(0);
    expect(value(ndcgAtK(missed, judgement, opts, 5))).toBe(0);
    expect(value(rankOfFirstRelevant(missed, judgement, opts))).toBeNull();
  });

  it('k <= 0 yields zeros rather than throwing', () => {
    expect(value(hitAtK(episode, judgement, opts, 0))).toBe(0);
    expect(value(precisionAtK(episode, judgement, opts, 0))).toBe(0);
    expect(value(recallAtK(episode, judgement, opts, 0))).toBe(0);
  });
});

describe('reciprocalRank and rankOfFirstRelevant', () => {
  const judgement = judgementOf([['a', 1]]);

  it('is 1-based', () => {
    const episode = episodeOf([callOf(['x', 'a'])]);
    expect(value(rankOfFirstRelevant(episode, judgement, options()))).toBe(2);
    expect(value(reciprocalRank(episode, judgement, options()))).toBeCloseTo(0.5);
  });

  it('is null / 0 when nothing relevant is retrieved', () => {
    const episode = episodeOf([callOf(['x'])]);
    expect(value(rankOfFirstRelevant(episode, judgement, options()))).toBeNull();
    expect(value(reciprocalRank(episode, judgement, options()))).toBe(0);
  });
});

describe('averagePrecision', () => {
  it('is 1 when every relevant document is retrieved first', () => {
    const episode = episodeOf([callOf(['a', 'b', 'x'])]);
    const judgement = judgementOf([
      ['a', 1],
      ['b', 1],
    ]);
    expect(value(averagePrecision(episode, judgement, options()))).toBeCloseTo(1);
  });

  it('divides by judged relevant documents, so a missed document costs AP', () => {
    const episode = episodeOf([callOf(['a', 'x'])]);
    const judgement = judgementOf([
      ['a', 1],
      ['b', 1],
    ]);
    expect(value(averagePrecision(episode, judgement, options()))).toBeCloseTo(0.5);
  });

  it('credits a relevant document only on its first chunk', () => {
    // a#1 at position 1, a#2 at position 2, b at position 3.
    const episode = episodeOf([callOf(['a', 'a', 'b'], ['a#1', 'a#2', null])]);
    const judgement = judgementOf([
      ['a', 1],
      ['b', 1],
    ]);
    // hits: a at 1 -> 1/1 ; b at 3 -> 2/3 ; average over 2 relevant docs.
    expect(value(averagePrecision(episode, judgement, options()))).toBeCloseTo((1 + 2 / 3) / 2);
  });
});

describe('ndcgAtK', () => {
  it('is 1 for the ideal ordering', () => {
    const episode = episodeOf([callOf(['a', 'b'])]);
    const judgement = judgementOf([
      ['a', 2],
      ['b', 1],
    ]);
    expect(value(ndcgAtK(episode, judgement, options(), 5))).toBeCloseTo(1);
  });

  it('penalises the reversed ordering', () => {
    const episode = episodeOf([callOf(['b', 'a'])]);
    const judgement = judgementOf([
      ['a', 2],
      ['b', 1],
    ]);
    // DCG = 1/1 + 3/log2(3); IDCG = 3/1 + 1/log2(3).
    const expected = (1 + 3 / Math.log2(3)) / (3 + 1 / Math.log2(3));
    expect(value(ndcgAtK(episode, judgement, options(), 5))).toBeCloseTo(expected);
  });

  it('normalises against the judgement, not the retrieved list', () => {
    const episode = episodeOf([callOf(['a'])]);
    const judgement = judgementOf([
      ['a', 1],
      ['b', 1],
    ]);
    // Retrieving only a cannot reach 1 because the ideal list contains b too.
    const score = value(ndcgAtK(episode, judgement, options(), 5));
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('credits a duplicated document once, so fragmentation cannot inflate the score', () => {
    const duplicated = episodeOf([callOf(['a', 'a'], ['a#1', 'a#2'])]);
    const single = episodeOf([callOf(['a'])]);
    const judgement = judgementOf([
      ['a', 1],
      ['b', 1],
    ]);
    expect(value(ndcgAtK(duplicated, judgement, options(), 5))).toBeCloseTo(
      value(ndcgAtK(single, judgement, options(), 5)),
    );
    expect(value(ndcgAtK(duplicated, judgement, options(), 5))).toBeLessThanOrEqual(1);
  });

  it('truncates the ideal list at k', () => {
    const episode = episodeOf([callOf(['a', 'b'])]);
    const judgement = judgementOf([
      ['a', 1],
      ['b', 1],
    ]);
    // At k=1 only a is examined and the ideal list is also length 1, so the score is 1.
    expect(value(ndcgAtK(episode, judgement, options(), 1))).toBeCloseTo(1);
  });
});

describe('fusion and basis flow through', () => {
  const judgement = judgementOf([['a', 1]]);

  it('best_rank promotes a document a later call ranked higher', () => {
    // best_rank lifts `a` to basis rank 0 (behind `x`, which ties at 0 in the earlier call);
    // concat leaves it where the first call put it.
    const episode = episodeOf([callOf(['x', 'y', 'a']), callOf(['a'])]);
    expect(value(rankOfFirstRelevant(episode, judgement, options({ fusion: 'best_rank' })))).toBe(2);
    expect(value(rankOfFirstRelevant(episode, judgement, options({ fusion: 'concat' })))).toBe(3);
  });

  it('first_call ignores a rescue by a later search', () => {
    const episode = episodeOf([callOf(['x']), callOf(['a'])]);
    expect(value(hitAtK(episode, judgement, options({ fusion: 'first_call' }), 10))).toBe(0);
    expect(value(hitAtK(episode, judgement, options({ fusion: 'best_rank' }), 10))).toBe(1);
  });

  it('a reranked basis with null rerankRank still scores, via the recorded fallback', () => {
    const episode = episodeOf([callOf(['x', 'a'])]);
    const result = scoreEpisodeRank(episode, judgement, options({ basis: 'reranked' }));
    expect(result.fused?.basisIsPure).toBe(false);
    expect(value(result.metrics[metricKey('hit', 3)]!)).toBe(1);
  });
});

describe('scoreEpisodeRank', () => {
  it('produces every metric key for the configured ks', () => {
    const episode = episodeOf([callOf(['a'])]);
    const result = scoreEpisodeRank(episode, judgementOf([['a', 1]]), options({ ks: [1, 3] }));
    expect(Object.keys(result.metrics).sort()).toEqual(rankMetricKeys([1, 3]).sort());
    expect(result.unscorable).toBeNull();
    expect(result.rankOfFirstRelevant).toEqual({ scored: true, value: 1 });
  });

  it('stamps the same unscorable reason on every metric', () => {
    const result = scoreEpisodeRank(episodeOf(null), judgementOf([['a', 1]]), options({ ks: [1, 3] }));
    expect(result.unscorable?.reason).toBe('no_retrieval_calls');
    expect(result.fused).toBeNull();
    for (const key of rankMetricKeys([1, 3])) {
      expect(result.metrics[key]).toEqual(result.unscorable);
    }
    expect(result.rankOfFirstRelevant.scored).toBe(false);
  });

  it('carries identity and options through for the aggregate to key on', () => {
    const episode = episodeOf([callOf(['a'])], { itemId: 'item-7', episodeId: 'ep-7', runId: 'run-7' });
    const result = scoreEpisodeRank(episode, judgementOf([['a', 1]]), options());
    expect(result.itemId).toBe('item-7');
    expect(result.episodeId).toBe('ep-7');
    expect(result.runId).toBe('run-7');
    expect(result.options.fusion).toBe('best_rank');
  });
});
