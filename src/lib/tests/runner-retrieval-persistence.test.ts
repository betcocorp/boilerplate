import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runBexChatTurn } = vi.hoisted(() => ({ runBexChatTurn: vi.fn() }));

vi.mock('~/lib/bex/run-chat-turn', () => ({ runBexChatTurn }));
vi.mock('./criteria-grader', () => ({ gradeWithCriteria: vi.fn(async () => null) }));
vi.mock('./decline-grader', () => ({ gradeSemanticDecline: vi.fn(async () => null) }));

import { runSingleTestItem } from './runner';
import type { TestItemRecord } from './types';

function testItem(): TestItemRecord {
  return {
    id: 'item-1',
    row_index: 1,
    prompt: 'How should I maintain this floor?',
    input_payload: {},
    expected_concepts: [],
    minimum_concepts: [],
    ideal_response: null,
  } as TestItemRecord;
}

describe('test runner retrieval persistence', () => {
  beforeEach(() => {
    runBexChatTurn.mockReset();
  });

  it('persists workflow retrieval_calls unchanged in response_payload', async () => {
    const retrievalCalls = [
      {
        tool_name: 'search_product_docs',
        call_id: 'call-1',
        retrieval_strategy: 'hybrid',
        chunks: [
          {
            document_id: 'doc-1',
            chunk_id: 'chunk-1',
            similarity: 0.81,
            rerank_score: 0.94,
            rerank_rank: 0,
          },
        ],
      },
    ];
    runBexChatTurn.mockResolvedValue({
      answerText: 'Use the documented maintenance procedure.',
      workflowRunId: '11111111-1111-4111-8111-111111111111',
      retrieval_calls: retrievalCalls,
      retrieved_document_chunks: [
        { document_id: 'doc-1', chunk_id: 'chunk-1' },
      ],
    });

    const result = await runSingleTestItem('result-1', testItem());
    const payload = result.item.response_payload as Record<string, unknown>;

    expect(result.item.workflow_run_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(payload.retrieval_calls).toEqual(retrievalCalls);
    expect(payload.retrieved_document_chunks).toEqual([
      { document_id: 'doc-1', chunk_id: 'chunk-1' },
    ]);
  });
});
