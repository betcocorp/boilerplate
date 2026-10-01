import { describe, expect, it } from 'vitest';

import { mapPromptHistoryRows } from '~/lib/observability/prompt-history';

/**
 * B0-421 — the strip's dots come straight out of this mapper, and every rejection it makes is
 * silent (a dropped dot just is not there). So the narrowing is asserted directly rather than
 * inferred from the rendered strip.
 */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    workflow_run_id: 'run-1',
    passed: true,
    created_at: '2026-08-04T10:00:00.000Z',
    ...overrides,
  };
}

describe('mapPromptHistoryRows', () => {
  it('reverses the query order so the strip reads oldest to newest', () => {
    const outcomes = mapPromptHistoryRows([
      row({ id: 'newest', created_at: '2026-08-04T12:00:00.000Z' }),
      row({ id: 'middle', created_at: '2026-08-04T11:00:00.000Z' }),
      row({ id: 'oldest', created_at: '2026-08-04T10:00:00.000Z' }),
    ]);

    expect(outcomes.map((outcome) => outcome.resultItemId)).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
  });

  it('keeps an execution whose workflow run is missing, unlinked', () => {
    // 1,488 of 10,176 rows: search-eval rows, error rows, and runs since deleted. The outcome
    // still happened, so the dot must render — it just has no trace to open.
    const outcomes = mapPromptHistoryRows([row({ workflow_run_id: null })]);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.workflowRunId).toBeNull();
    expect(outcomes[0]?.passed).toBe(true);
  });

  it('drops rows with no id or no timestamp', () => {
    // Without an id the dot cannot be marked "this run"; without a timestamp it cannot be placed.
    const outcomes = mapPromptHistoryRows([
      row(),
      row({ id: null }),
      row({ id: 'no-timestamp', created_at: null }),
    ]);

    expect(outcomes.map((outcome) => outcome.resultItemId)).toEqual(['item-1']);
  });

  it('treats a non-true passed value as a failure rather than coercing', () => {
    const outcomes = mapPromptHistoryRows([
      row({ id: 'failed', passed: false }),
      row({ id: 'missing', passed: undefined }),
    ]);

    expect(outcomes.every((outcome) => outcome.passed === false)).toBe(true);
  });

  it('returns an empty list for a non-array or empty input', () => {
    expect(mapPromptHistoryRows(null)).toEqual([]);
    expect(mapPromptHistoryRows([])).toEqual([]);
    expect(mapPromptHistoryRows('nonsense')).toEqual([]);
  });
});
