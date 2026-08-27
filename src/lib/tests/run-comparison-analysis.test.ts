import { describe, expect, it } from 'vitest';

import {
  runComparisonAnalysisSchema,
  runComparisonFailureAnalysisSchema,
} from './run-comparison-analysis';

describe('runComparisonFailureAnalysisSchema', () => {
  it('accepts a well-formed failure analysis', () => {
    const result = runComparisonFailureAnalysisSchema.safeParse({
      testItemId: 'abc-123',
      cause: 'The corpus no longer has a Basic Coatings SDS chunk for this dilution question.',
      fix: 'Re-ingest the Basic Coatings label after the B0-260 conversion fix.',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an empty cause or fix', () => {
    expect(
      runComparisonFailureAnalysisSchema.safeParse({
        testItemId: 'abc-123',
        cause: '',
        fix: 'Something.',
      }).success,
    ).toBe(false);

    expect(
      runComparisonFailureAnalysisSchema.safeParse({
        testItemId: 'abc-123',
        cause: 'Something.',
        fix: '',
      }).success,
    ).toBe(false);
  });

  it('rejects a missing testItemId', () => {
    expect(
      runComparisonFailureAnalysisSchema.safeParse({
        cause: 'Something.',
        fix: 'Something else.',
      }).success,
    ).toBe(false);
  });
});

describe('runComparisonAnalysisSchema', () => {
  it('accepts a well-formed response with failures', () => {
    const result = runComparisonAnalysisSchema.safeParse({
      verdict: 'regressed',
      verdictSummary: 'Pass rate dropped 12 points after the reranker rollout in the current run notes.',
      failures: [
        { testItemId: 'a', cause: 'Reranker demoted the correct chunk.', fix: 'Tune the rerank weight.' },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts an empty failures array (no new failures)', () => {
    const result = runComparisonAnalysisSchema.safeParse({
      verdict: 'flat',
      verdictSummary: 'No new failures and no recoveries versus the previous run.',
      failures: [],
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown verdict', () => {
    expect(
      runComparisonAnalysisSchema.safeParse({
        verdict: 'worse',
        verdictSummary: 'Bad verdict value.',
        failures: [],
      }).success,
    ).toBe(false);
  });

  it('rejects a missing verdictSummary', () => {
    expect(
      runComparisonAnalysisSchema.safeParse({
        verdict: 'flat',
        failures: [],
      }).success,
    ).toBe(false);
  });
});
