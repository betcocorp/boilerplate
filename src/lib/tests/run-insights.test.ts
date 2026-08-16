import { describe, expect, it } from 'vitest';

import { runInsightSchema, runInsightsResponseSchema } from './run-insights';

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
