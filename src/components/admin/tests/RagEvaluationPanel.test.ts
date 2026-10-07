import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import {
  RagEvaluationPanel,
  type RagEvaluationPanelData,
} from '~/components/admin/tests/RagEvaluationPanel';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

it('shows the saved test outcome independently of retrieval misses and preserves result links', () => {
  const episodes: RagEvaluationPanelData['episodes'] = [
    { episodeId: 'failed-miss', itemId: 'item-23', rowIndex: 23, question: 'Failed question', passed: false, metrics: { 'hit@5': { scored: true, value: 0 } } },
    { episodeId: 'passed-miss', itemId: 'item-24', rowIndex: 24, question: 'Passed question', passed: true, metrics: { 'hit@5': { scored: true, value: 0 } } },
    { episodeId: 'hit', itemId: 'item-25', rowIndex: 25, question: 'Retrieved question', passed: false, metrics: { 'hit@5': { scored: true, value: 1 } } },
    { episodeId: 'unscored', itemId: 'item-26', rowIndex: 26, question: 'Unscored question', passed: false, metrics: { 'hit@5': { scored: false } } },
  ];
  const html = renderToStaticMarkup(createElement(RagEvaluationPanel, {
    runId: 'run-1',
    eligible: true,
    initialEvaluation: {
      status: 'ready', error: null, completedAt: null,
      coverage: null, labelling: null, aggregates: [], episodes,
    },
  }));
  const rows = html.match(/<li\b[^>]*>.*?<\/li>/g) ?? [];

  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain('Test failed');
  expect(rows[0]).toContain('href="#run-item-result-failed-miss"');
  expect(rows[0]).toContain('Row 23: Failed question');
  expect(rows[1]).toContain('Test passed');
  expect(rows[1]).toContain('href="#run-item-result-passed-miss"');
});
