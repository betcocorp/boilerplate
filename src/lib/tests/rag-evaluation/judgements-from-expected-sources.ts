import type { TestItemRecord } from '~/lib/tests/types';

import type { Judgement } from './types';

export type ExpectedSourceJudgementItem = Pick<
  TestItemRecord,
  'id' | 'row_index' | 'prompt' | 'expected_sources'
>;

export type OmittedExpectedSourceItem = {
  itemId: string;
  rowIndex: number;
  question: string;
  reason: 'no_expected_sources';
};

export type ExpectedSourceJudgementExport = {
  judgements: Judgement[];
  omitted: OmittedExpectedSourceItem[];
};

/**
 * Converts reviewed `test_items.expected_sources` document ids into the binary document-relevance
 * judgements consumed by the Phase 3 scorer.
 *
 * Empty source lists are deliberately omitted rather than emitted as `isNegative: true`: the
 * database has no replacement for the retired negative-example flag, so an empty list means
 * "unlabelled" unless a human explicitly says otherwise. Duplicate ids are removed in author order.
 */
export function buildJudgementsFromExpectedSources(
  items: readonly ExpectedSourceJudgementItem[],
): ExpectedSourceJudgementExport {
  const judgements: Judgement[] = [];
  const omitted: OmittedExpectedSourceItem[] = [];

  for (const item of items) {
    const documentIds = [
      ...new Set(
        (item.expected_sources ?? [])
          .map((documentId) => documentId.trim())
          .filter(Boolean),
      ),
    ];

    if (documentIds.length === 0) {
      omitted.push({
        itemId: item.id,
        rowIndex: item.row_index,
        question: item.prompt,
        reason: 'no_expected_sources',
      });
      continue;
    }

    judgements.push({
      itemId: item.id,
      relevantDocuments: documentIds.map((documentId) => ({ documentId, gain: 1 })),
      entities: [],
      isNegative: false,
      notes: 'Generated from test_items.expected_sources; binary document relevance only.',
    });
  }

  return { judgements, omitted };
}
