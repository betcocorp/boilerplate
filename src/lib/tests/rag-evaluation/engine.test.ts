import { describe, expect, it } from 'vitest';

import { scoreRetrievalRun } from '~/lib/tests/rag-evaluation/engine';
import { DEFAULT_SCORING_OPTIONS, type Judgement } from '~/lib/tests/rag-evaluation/types';

import { cleanEpisode, nullCallsEpisode } from './fixtures/episodes';

const judgement: Judgement = {
  itemId: cleanEpisode.itemId,
  relevantDocuments: [{ documentId: 'doc-label-a', gain: 1 }],
  entities: [],
  isNegative: false,
  notes: null,
};

describe('scoreRetrievalRun', () => {
  it('produces one shared snapshot-ready result with coverage and denominators', () => {
    const result = scoreRetrievalRun(
      [cleanEpisode, nullCallsEpisode],
      [judgement],
      DEFAULT_SCORING_OPTIONS,
    );

    expect(result.coverage).toMatchObject({ requested: 7, resolved: 7, missing: 0 });
    expect(result.labelling.documentLabelledItemIds).toEqual([cleanEpisode.itemId]);
    expect(result.episodes).toHaveLength(2);
    expect(result.aggregates.find((metric) => metric.metric === 'hit@1')).toMatchObject({
      value: 1,
      scoredCount: 1,
      unscorableCount: 1,
    });
  });
});
