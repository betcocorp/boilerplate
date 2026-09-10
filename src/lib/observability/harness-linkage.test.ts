import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getHarnessContextForRun,
  mapHarnessContextRow,
} from '~/lib/observability/harness-linkage';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

/** Minimal service-role stub: `.from().select().eq().limit()` resolves to a fixed result. */
function useResult(result: { data: unknown; error: unknown }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    limit: () => Promise.resolve(result),
  };
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    from: () => builder,
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
}

function useThrowingClient(message: string) {
  vi.mocked(getSupabaseServiceRoleClient).mockImplementation(() => {
    throw new Error(message);
  });
}

const FULL_ROW = {
  id: 'item-1',
  workflow_run_id: 'run-1',
  test_item_id: 'ti-1',
  test_result_id: 'tr-1',
  row_index: 99,
  passed: false,
  status: 'completed',
  elapsed_ms: 4200,
  response_text: 'Dilute at 2 oz/gal.',
  error_message: null,
  response_payload: {
    sources: [{ similarity: 0.42 }, { similarity: 0.81 }],
  },
  test_items: {
    id: 'ti-1',
    row_index: 7,
    prompt: 'What is the dilution for Green Earth Peroxide Cleaner?',
    minimum_concepts: ['states the labeled dilution', 'cites the product label'],
    priority: 2,
    ideal_response: '2 oz/gal for general cleaning.',
  },
  test_results: {
    id: 'tr-1',
    test_id: 'test-1',
    started_at: '2026-08-10T12:00:00.000Z',
    created_at: '2026-08-10T11:59:00.000Z',
    tests: { id: 'test-1', name: 'Product Support Golden Set' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The mapper is where every "this is not a harness run" decision is made, and each one is silent by
 * design — the verdict band simply does not render. So the narrowing is asserted directly here
 * rather than inferred from the page.
 */
describe('mapHarnessContextRow', () => {
  it('maps a fully populated joined row', () => {
    expect(mapHarnessContextRow(FULL_ROW)).toEqual({
      resultItemId: 'item-1',
      workflowRunId: 'run-1',
      testId: 'test-1',
      testName: 'Product Support Golden Set',
      testResultId: 'tr-1',
      runStartedAt: '2026-08-10T12:00:00.000Z',
      testItemId: 'ti-1',
      rowIndex: 7,
      prompt: 'What is the dilution for Green Earth Peroxide Cleaner?',
      mandatoryConcepts: ['states the labeled dilution', 'cites the product label'],
      priority: 2,
      idealResponse: '2 oz/gal for general cleaning.',
      passed: false,
      status: 'completed',
      elapsedMs: 4200,
      similarity: 0.81,
      responseText: 'Dilute at 2 oz/gal.',
      errorMessage: null,
    });
  });

  it('accepts embedded relations arriving as single-element arrays', () => {
    const context = mapHarnessContextRow({
      ...FULL_ROW,
      test_items: [FULL_ROW.test_items],
      test_results: [
        { ...FULL_ROW.test_results, tests: [FULL_ROW.test_results.tests] },
      ],
    });
    expect(context?.testId).toBe('test-1');
    expect(context?.testName).toBe('Product Support Golden Set');
    expect(context?.rowIndex).toBe(7);
  });

  /* The state of every row in the database today: no priority, no ideal response. */
  it('reports an absent priority and ideal response as null rather than defaulting them', () => {
    const context = mapHarnessContextRow({
      ...FULL_ROW,
      test_items: { ...FULL_ROW.test_items, priority: null, ideal_response: null },
    });
    expect(context?.priority).toBeNull();
    expect(context?.idealResponse).toBeNull();
  });

  /**
   * B0-932 — `expected_should_answer` is gone; `minimum_concepts` is the prompt's expectation.
   * An item that declares none must read as an empty list, never as a fabricated expectation, and
   * a malformed value must degrade the same way rather than throwing.
   */
  it('reports an item with no mandatory concepts as an empty list', () => {
    expect(
      mapHarnessContextRow({
        ...FULL_ROW,
        test_items: { ...FULL_ROW.test_items, minimum_concepts: [] },
      })?.mandatoryConcepts,
    ).toEqual([]);
  });

  it('degrades a missing or malformed minimum_concepts to an empty list', () => {
    expect(
      mapHarnessContextRow({
        ...FULL_ROW,
        test_items: { ...FULL_ROW.test_items, minimum_concepts: null },
      })?.mandatoryConcepts,
    ).toEqual([]);
    expect(
      mapHarnessContextRow({
        ...FULL_ROW,
        test_items: { ...FULL_ROW.test_items, minimum_concepts: 'not an array' },
      })?.mandatoryConcepts,
    ).toEqual([]);
  });

  it('copies every concept phrase verbatim and drops only blanks', () => {
    expect(
      mapHarnessContextRow({
        ...FULL_ROW,
        test_items: {
          ...FULL_ROW.test_items,
          minimum_concepts: ['4 oz/gal per the label', '   ', 'EPA Reg. No. 1839-83'],
        },
      })?.mandatoryConcepts,
    ).toEqual(['4 oz/gal per the label', 'EPA Reg. No. 1839-83']);
  });

  it('prefers the prompt row index but falls back to the per-run copy', () => {
    expect(
      mapHarnessContextRow({
        ...FULL_ROW,
        test_items: { ...FULL_ROW.test_items, row_index: null },
      })?.rowIndex,
    ).toBe(99);
  });

  it('falls back to the run created_at when it never started', () => {
    expect(
      mapHarnessContextRow({
        ...FULL_ROW,
        test_results: { ...FULL_ROW.test_results, started_at: null },
      })?.runStartedAt,
    ).toBe('2026-08-10T11:59:00.000Z');
  });

  it('returns null when the prompt is gone', () => {
    expect(mapHarnessContextRow({ ...FULL_ROW, test_items: null })).toBeNull();
    expect(
      mapHarnessContextRow({
        ...FULL_ROW,
        test_items: { ...FULL_ROW.test_items, prompt: '' },
      }),
    ).toBeNull();
  });

  it('returns null when the run linkage is gone', () => {
    expect(mapHarnessContextRow({ ...FULL_ROW, test_results: null })).toBeNull();
    expect(
      mapHarnessContextRow({ ...FULL_ROW, workflow_run_id: null }),
    ).toBeNull();
  });

  it('returns null for absent or malformed rows', () => {
    expect(mapHarnessContextRow(null)).toBeNull();
    expect(mapHarnessContextRow(undefined)).toBeNull();
    expect(mapHarnessContextRow('nope')).toBeNull();
    expect(mapHarnessContextRow([])).toBeNull();
  });

  it('reports similarity as absent rather than zero when the payload recorded none', () => {
    expect(
      mapHarnessContextRow({ ...FULL_ROW, response_payload: null })?.similarity,
    ).toBeNull();
    expect(
      mapHarnessContextRow({ ...FULL_ROW, response_payload: { sources: [] } })
        ?.similarity,
    ).toBeNull();
  });
});

/**
 * The reader must never throw: its `null` is what makes the verdict band *absent* for live-chat and
 * orphaned runs instead of erroring, and a thrown error here would take down a trace page whose own
 * content loaded fine.
 */
describe('getHarnessContextForRun', () => {
  it('resolves a harness run to its execution', async () => {
    useResult({ data: [FULL_ROW], error: null });
    const context = await getHarnessContextForRun('run-1');
    expect(context?.resultItemId).toBe('item-1');
    expect(context?.testItemId).toBe('ti-1');
    expect(context?.testResultId).toBe('tr-1');
  });

  it('returns null for a run no harness item points at', async () => {
    useResult({ data: [], error: null });
    await expect(getHarnessContextForRun('run-live')).resolves.toBeNull();
  });

  it('returns null instead of throwing when the query fails', async () => {
    useResult({ data: null, error: { message: 'column does not exist' } });
    await expect(getHarnessContextForRun('run-1')).resolves.toBeNull();
  });

  it('returns null instead of throwing when the client cannot be built', async () => {
    useThrowingClient('Supabase service role environment variables are not configured.');
    await expect(getHarnessContextForRun('run-1')).resolves.toBeNull();
  });

  it('skips the query entirely for a blank run id', async () => {
    await expect(getHarnessContextForRun('   ')).resolves.toBeNull();
    expect(getSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });
});
