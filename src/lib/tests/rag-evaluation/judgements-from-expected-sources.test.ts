import { describe, expect, it } from 'vitest';

import { buildJudgementsFromExpectedSources } from './judgements-from-expected-sources';

const item = (
  id: string,
  rowIndex: number,
  expectedSources: string[] | null,
) => ({
  id,
  row_index: rowIndex,
  prompt: `Question ${rowIndex}`,
  expected_sources: expectedSources,
});

describe('buildJudgementsFromExpectedSources', () => {
  it('maps document ids to binary Phase 3 relevance judgements', () => {
    const result = buildJudgementsFromExpectedSources([
      item('item-1', 1, ['doc-a', 'doc-b']),
    ]);

    expect(result.judgements).toEqual([
      {
        itemId: 'item-1',
        relevantDocuments: [
          { documentId: 'doc-a', gain: 1 },
          { documentId: 'doc-b', gain: 1 },
        ],
        entities: [],
        isNegative: false,
        notes: 'Generated from test_items.expected_sources; binary document relevance only.',
      },
    ]);
    expect(result.omitted).toEqual([]);
  });

  it('omits an empty source list as unlabelled rather than inventing a negative', () => {
    const result = buildJudgementsFromExpectedSources([
      item('item-empty', 7, []),
      item('item-null', 8, null),
    ]);

    expect(result.judgements).toEqual([]);
    expect(result.omitted).toEqual([
      {
        itemId: 'item-empty',
        rowIndex: 7,
        question: 'Question 7',
        reason: 'no_expected_sources',
      },
      {
        itemId: 'item-null',
        rowIndex: 8,
        question: 'Question 8',
        reason: 'no_expected_sources',
      },
    ]);
  });

  it('trims, removes blanks, and de-duplicates document ids in author order', () => {
    const result = buildJudgementsFromExpectedSources([
      item('item-1', 1, [' doc-b ', '', 'doc-a', 'doc-b']),
    ]);

    expect(result.judgements[0]?.relevantDocuments).toEqual([
      { documentId: 'doc-b', gain: 1 },
      { documentId: 'doc-a', gain: 1 },
    ]);
  });
});
