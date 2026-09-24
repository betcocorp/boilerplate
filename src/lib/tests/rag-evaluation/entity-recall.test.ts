import { describe, expect, it } from 'vitest';

import {
  entityRecallMetrics,
  scoreEntityRecall,
  scoreEpisodeEntityRecall,
} from './entity-recall';
import {
  DEFAULT_SCORING_OPTIONS,
  type Coverage,
  type EntityRequirement,
  type Judgement,
  type RankedCandidate,
  type RetrievalEpisode,
} from './types';

/* Fixtures are declared inline so these tests never depend on another agent's fixture module. */

const candidate = (overrides: Partial<RankedCandidate> & { rank: number }): RankedCandidate => ({
  documentId: `doc-${overrides.rank}`,
  chunkId: `chunk-${overrides.rank}`,
  documentKind: 'sds',
  documentTitle: null,
  similarity: 0.5,
  rerankScore: null,
  rerankRank: null,
  text: null,
  resolution: 'resolved',
  ...overrides,
});

const requirement = (overrides: Partial<EntityRequirement> = {}): EntityRequirement => ({
  key: 'epa_registration',
  kind: 'epa_registration',
  values: ['1839-95'],
  required: true,
  ...overrides,
});

const coverage = (resolvedShare: number | null): Coverage => ({
  requested: 10,
  resolved: 8,
  missing: 2,
  synthetic: 0,
  noChunkId: 0,
  resolvedShare,
});

describe('scoreEntityRecall', () => {
  it('finds an entity and reports the 1-based rank of the chunk that first contained it', () => {
    const result = scoreEntityRecall(
      [
        candidate({ rank: 0, text: 'Section 1. Identification. Betco Triforce.' }),
        candidate({ rank: 1, text: 'EPA Reg. No. 1839-95 — see label for directions.' }),
      ],
      [requirement()],
    );

    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.required).toEqual({ total: 1, found: 1, recall: 1 });
    expect(result.value.entities[0]).toMatchObject({
      found: true,
      rank: 2,
      chunkId: 'chunk-1',
      documentId: 'doc-1',
      matchedValue: '1839-95',
    });
    expect(result.value.meanFoundRank).toBe(2);
    expect(result.value.worstFoundRank).toBe(2);
  });

  it('surfaces an entity buried deep in the list with its real rank', () => {
    const candidates = Array.from({ length: 20 }, (_, index) =>
      candidate({ rank: index, text: index === 17 ? 'EPA Reg. No. 1839-95' : 'label column only' }),
    );
    const result = scoreEntityRecall(candidates, [requirement()]);
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.entities[0]?.rank).toBe(18);
  });

  it('treats array order as the ranking, not the per-call `rank` field', () => {
    // A fused list keeps each candidate's original per-call rank; its real position is the fused
    // one, so the reported rank must follow the array.
    const result = scoreEntityRecall(
      [
        candidate({ rank: 9, chunkId: 'first', text: 'nothing useful' }),
        candidate({ rank: 0, chunkId: 'second', text: 'EPA Reg. No. 1839-95' }),
      ],
      [requirement()],
    );
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.entities[0]).toMatchObject({ rank: 2, chunkId: 'second' });
  });

  it('does NOT match an EPA number split across a chunk boundary', () => {
    const result = scoreEntityRecall(
      [
        candidate({ rank: 0, text: 'Regulatory information. EPA Reg. No. 1839-' }),
        candidate({ rank: 1, text: '95. Restricted use pesticide.' }),
      ],
      [requirement()],
    );
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.entities[0]?.found).toBe(false);
    expect(result.value.required.recall).toBe(0);
  });

  it('matches a dilution written three ways in one chunk, numerically', () => {
    const text = 'Routine cleaning: 1:64 (2 oz/gal). Heavy soil: 4 ounces per gallon.';
    const result = scoreEntityRecall(
      [candidate({ rank: 0, text })],
      [
        requirement({ key: 'routine', kind: 'dilution', values: ['2 oz per gallon'] }),
        requirement({ key: 'heavy', kind: 'dilution', values: ['1:32'] }),
        requirement({ key: 'absent', kind: 'dilution', values: ['1:256'] }),
      ],
    );
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.entities.map((entity) => entity.found)).toEqual([true, true, false]);
    expect(result.value.required).toEqual({ total: 3, found: 2, recall: 2 / 3 });
  });

  it('matches literals across unicode and curly-quote variants', () => {
    const result = scoreEntityRecall(
      [
        candidate({
          rank: 0,
          text: 'Skin contact : Wash with soap. Don’t reuse clothing—get medical\nattention immediately.',
        }),
      ],
      [
        requirement({ key: 'first_aid', kind: 'literal', values: ['get medical attention'] }),
        requirement({ key: 'reuse', kind: 'literal', values: ["don't reuse clothing—get"] }),
      ],
    );
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.entities.every((entity) => entity.found)).toBe(true);
  });

  it('ignores an entity that is present only in an UNRESOLVED chunk', () => {
    const result = scoreEntityRecall(
      [
        candidate({ rank: 0, text: 'nothing useful here' }),
        candidate({
          rank: 1,
          text: 'EPA Reg. No. 1839-95',
          resolution: 'missing',
        }),
        candidate({ rank: 2, text: 'DIN 02245678', resolution: 'synthetic' }),
      ],
      [requirement(), requirement({ key: 'din', kind: 'din', values: ['02245678'] })],
    );
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.searchedCandidates).toBe(1);
    expect(result.value.entities.every((entity) => entity.found)).toBe(false);
  });

  it('is unscorable, not zero, when no candidate has resolved text', () => {
    const result = scoreEntityRecall(
      [
        candidate({ rank: 0, text: 'EPA Reg. No. 1839-95', resolution: 'missing' }),
        candidate({ rank: 1, text: null, resolution: 'no_chunk_id' }),
      ],
      [requirement()],
    );
    expect(result).toMatchObject({ scored: false, reason: 'no_resolved_text' });
  });

  it('is unscorable when there are zero candidates', () => {
    expect(scoreEntityRecall([], [requirement()])).toMatchObject({
      scored: false,
      reason: 'empty_retrieval',
    });
  });

  it('is unscorable when the item has no entity requirements', () => {
    expect(scoreEntityRecall([candidate({ rank: 0, text: 'x' })], [])).toMatchObject({
      scored: false,
      reason: 'no_judgement',
    });
  });

  it('honours the coverage floor', () => {
    const candidates = [candidate({ rank: 0, text: 'EPA Reg. No. 1839-95' })];
    expect(scoreEntityRecall(candidates, [requirement()], coverage(0.5))).toMatchObject({
      scored: false,
      reason: 'coverage_below_floor',
    });
    expect(scoreEntityRecall(candidates, [requirement()], coverage(0.9)).scored).toBe(true);
    // A null resolvedShare cannot be compared to the floor; it must fall through, not block.
    expect(scoreEntityRecall(candidates, [requirement()], coverage(null)).scored).toBe(true);
  });

  it('reports non-required entities separately from the headline score', () => {
    const result = scoreEntityRecall(
      [candidate({ rank: 0, text: 'EPA Reg. No. 1839-95. Contact time 10 minutes.' })],
      [
        requirement(),
        requirement({ key: 'contact', kind: 'contact_time', values: ['600 seconds'], required: false }),
        requirement({ key: 'din', kind: 'din', values: ['02245678'], required: false }),
      ],
    );
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.required).toEqual({ total: 1, found: 1, recall: 1 });
    expect(result.value.optional).toEqual({ total: 2, found: 1, recall: 0.5 });
    // Optional hits never move the headline mean rank.
    expect(result.value.meanFoundRank).toBe(1);
  });

  it('reports an empty optional bucket as null recall, not zero', () => {
    const result = scoreEntityRecall([candidate({ rank: 0, text: '1839-95' })], [requirement()]);
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.optional).toEqual({ total: 0, found: 0, recall: null });
  });

  it('excludes configured document kinds from the searched candidates', () => {
    const result = scoreEntityRecall(
      [candidate({ rank: 0, documentKind: 'facts', text: 'EPA Reg. No. 1839-95' })],
      [requirement()],
      null,
      { coverageFloor: 0.8, excludeKinds: ['facts'] },
    );
    expect(result).toMatchObject({ scored: false, reason: 'no_resolved_text' });
  });
});

describe('scoreEpisodeEntityRecall', () => {
  const judgement: Judgement = {
    itemId: 'item-1',
    relevantDocuments: [{ documentId: 'doc-0', gain: 2 }],
    entities: [requirement()],
    isNegative: false,
    notes: null,
  };

  const episode = (calls: RetrievalEpisode['calls']): RetrievalEpisode => ({
    episodeId: 'ep-1',
    itemId: 'item-1',
    runId: 'run-1',
    questionSetId: 'qs-1',
    questionSetName: null,
    rowIndex: 0,
    question: 'What is the EPA registration number?',
    answer: null,
    reference: null,
    passed: false,
    calls,
    coverage: coverage(1),
  });

  it('distinguishes null calls from an empty call list', () => {
    expect(scoreEpisodeEntityRecall(episode(null), judgement)).toMatchObject({
      scored: false,
      reason: 'no_retrieval_calls',
    });
    expect(scoreEpisodeEntityRecall(episode([]), judgement)).toMatchObject({
      scored: false,
      reason: 'empty_retrieval',
    });
  });

  it('is unscorable without a judgement', () => {
    expect(scoreEpisodeEntityRecall(episode([]), null)).toMatchObject({
      scored: false,
      reason: 'no_judgement',
    });
  });

  it('fuses the turn’s calls before scoring', () => {
    const result = scoreEpisodeEntityRecall(
      episode([
        { toolName: 'search', callId: '1', strategy: 'hybrid', candidates: [candidate({ rank: 0, text: 'no' })] },
        {
          toolName: 'search',
          callId: '2',
          strategy: 'hybrid',
          candidates: [candidate({ rank: 0, chunkId: 'z', documentId: 'doc-z', text: 'EPA Reg. No. 1839-95' })],
        },
      ]),
      judgement,
      DEFAULT_SCORING_OPTIONS,
    );
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.entities[0]).toMatchObject({ found: true, documentId: 'doc-z' });
  });

  it('projects onto the flat snapshot metric shape', () => {
    const metrics = entityRecallMetrics(
      episode([
        {
          toolName: 'search',
          callId: '1',
          strategy: 'hybrid',
          candidates: [candidate({ rank: 0, text: 'EPA Reg. No. 1839-95' })],
        },
      ]),
      judgement,
    );
    expect(metrics['entity_recall.required']).toEqual({ scored: true, value: 1 });
    expect(metrics['entity_recall.mean_found_rank']).toEqual({ scored: true, value: 1 });
    // No non-required entities labelled: unscorable, never 0.
    expect(metrics['entity_recall.optional']).toMatchObject({ scored: false, reason: 'no_judgement' });
  });

  it('propagates the unscorable reason to every flat metric', () => {
    const metrics = entityRecallMetrics(episode(null), judgement);
    for (const value of Object.values(metrics)) {
      expect(value).toMatchObject({ scored: false, reason: 'no_retrieval_calls' });
    }
  });
});
