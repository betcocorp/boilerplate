import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-1113 — generateAndSaveRunInsights talks to the model, the repository, and
 * recordGradingUsage; all three are stubbed so this stays a pure unit test.
 */
const {
  mockComplete,
  mockResolveHarnessInsightsModel,
  mockGetTestResultById,
  mockListAllResultItemsByResultId,
  mockGetTestItemsByTestId,
  mockSaveTestResultInsights,
  mockRecordGradingUsage,
} = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockResolveHarnessInsightsModel: vi.fn(async () => 'gpt-test'),
  mockGetTestResultById: vi.fn(),
  mockListAllResultItemsByResultId: vi.fn(),
  mockGetTestItemsByTestId: vi.fn(),
  mockSaveTestResultInsights: vi.fn(),
  mockRecordGradingUsage: vi.fn(),
}));

vi.mock('~/lib/llm/structured-completion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/llm/structured-completion')>()),
  completeStructuredWithUsage: mockComplete,
}));
vi.mock('~/lib/tests/harness-insights-model', () => ({
  resolveHarnessInsightsModel: mockResolveHarnessInsightsModel,
}));
vi.mock('./repository', () => ({
  getTestResultById: mockGetTestResultById,
  listAllResultItemsByResultId: mockListAllResultItemsByResultId,
  getTestItemsByTestId: mockGetTestItemsByTestId,
  saveTestResultInsights: mockSaveTestResultInsights,
}));
vi.mock('./response-payload', () => ({
  extractItemSimilarityScore: vi.fn(() => null),
}));
// B0-1113 — recordGradingUsage talks to Supabase; stubbed so this stays a pure unit test.
vi.mock('./grading-usage', () => ({
  recordGradingUsage: mockRecordGradingUsage,
}));

import { generateAndSaveRunInsights, runInsightSchema, runInsightsResponseSchema } from './run-insights';

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 0 };

const RUN = { id: 'run-1', test_id: 'test-1' };
const TEST_ITEMS = [{ id: 'item-1', prompt: 'How do I dilute Pine Quat?' }];
const RESULT_ITEMS = [
  {
    test_item_id: 'item-1',
    passed: false,
    response_payload: {},
    error_message: 'no tool call',
    elapsed_ms: 100,
  },
];

const VALID_INSIGHTS_JSON = JSON.stringify({
  insights: [
    {
      rank: 1,
      title: 'Agent skips retrieval',
      description: 'The agent never called a search tool on this item.',
      category: 'agent',
      impact: 'high',
    },
  ],
});

describe('runInsightSchema', () => {
  it('accepts a well-formed insight', () => {
    const result = runInsightSchema.safeParse({
      rank: 1,
      title: 'Agent skips retrieval on ambiguous prompts',
      description: '3 of 5 no-retrieval failures were ambiguous prompts missing a product name.',
      category: 'agent',
      impact: 'high',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown category', () => {
    const result = runInsightSchema.safeParse({
      rank: 1,
      title: 'Bad category',
      description: 'Should fail validation.',
      category: 'not-a-real-category',
      impact: 'high',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an unknown impact', () => {
    const result = runInsightSchema.safeParse({
      rank: 1,
      title: 'Bad impact',
      description: 'Should fail validation.',
      category: 'corpus',
      impact: 'critical',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty title or description', () => {
    expect(
      runInsightSchema.safeParse({
        rank: 1,
        title: '',
        description: 'Has a description.',
        category: 'corpus',
        impact: 'low',
      }).success,
    ).toBe(false);

    expect(
      runInsightSchema.safeParse({
        rank: 1,
        title: 'Has a title.',
        description: '',
        category: 'corpus',
        impact: 'low',
      }).success,
    ).toBe(false);
  });
});

describe('runInsightsResponseSchema', () => {
  it('requires at least one insight', () => {
    expect(runInsightsResponseSchema.safeParse({ insights: [] }).success).toBe(false);
  });

  it('accepts a well-formed response matching the model prompt schema', () => {
    const result = runInsightsResponseSchema.safeParse({
      insights: [
        {
          rank: 1,
          title: 'Corpus gap on floor coatings',
          description: 'Every failed-with-retrieval item referenced Basic Coatings finish removers.',
          category: 'corpus',
          impact: 'medium',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects a response with a malformed insights field', () => {
    expect(runInsightsResponseSchema.safeParse({ insights: 'not an array' }).success).toBe(false);
    expect(runInsightsResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('generateAndSaveRunInsights (B0-1113)', () => {
  beforeEach(() => {
    mockComplete.mockReset();
    mockResolveHarnessInsightsModel.mockReset();
    mockResolveHarnessInsightsModel.mockResolvedValue('gpt-test');
    mockGetTestResultById.mockReset();
    mockGetTestResultById.mockResolvedValue(RUN);
    mockListAllResultItemsByResultId.mockReset();
    mockListAllResultItemsByResultId.mockResolvedValue(RESULT_ITEMS);
    mockGetTestItemsByTestId.mockReset();
    mockGetTestItemsByTestId.mockResolvedValue(TEST_ITEMS);
    mockSaveTestResultInsights.mockReset();
    mockSaveTestResultInsights.mockResolvedValue({ insights_generated_at: '2026-09-29T00:00:00Z' });
    mockRecordGradingUsage.mockClear();
  });

  it('records grading usage against the run on a successful call', async () => {
    mockComplete.mockResolvedValue({ text: VALID_INSIGHTS_JSON, usage: USAGE });

    const result = await generateAndSaveRunInsights('run-1');

    expect(result.ok).toBe(true);
    expect(mockSaveTestResultInsights).toHaveBeenCalledOnce();

    // B0-1113 — the run-insights call's token usage is recorded against the run, with no single
    // test item (run-level analysis, not per-item grading).
    expect(mockRecordGradingUsage).toHaveBeenCalledWith({
      context: { testResultId: 'run-1' },
      callSite: 'run_insights',
      provider: 'openai',
      model: 'gpt-test',
      usage: USAGE,
    });
  });

  it('records nothing when the completion call throws', async () => {
    mockComplete.mockRejectedValue(new Error('transport failure'));

    await expect(generateAndSaveRunInsights('run-1')).rejects.toThrow('transport failure');

    expect(mockSaveTestResultInsights).not.toHaveBeenCalled();
    // B0-1113 — no usage on a thrown call: never reaches the usage line.
    expect(mockRecordGradingUsage).not.toHaveBeenCalled();
  });
});
