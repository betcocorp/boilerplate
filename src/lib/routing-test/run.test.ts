import { describe, expect, it } from 'vitest';

import { runRoutingTest } from '~/lib/routing-test/run';
import type { RoutingTestItemRecord } from '~/lib/routing-test/types';

function item(
  overrides: Partial<RoutingTestItemRecord> & Pick<RoutingTestItemRecord, 'prompt' | 'expected_agent'>,
): RoutingTestItemRecord {
  return {
    id: overrides.id ?? `id-${overrides.prompt.length}-${overrides.expected_agent}`,
    created_at: '2026-08-25T00:00:00.000Z',
    updated_at: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * The keyword router is synchronous and pure (no OpenAI, no Supabase), so a keyword run is safe to
 * exercise end to end here. The semantic path is deliberately not exercised — it would make a real
 * embedding call.
 */
describe('runRoutingTest — keyword (B0-659)', () => {
  it('scores each item and reports the summary', async () => {
    const result = await runRoutingTest(
      [
        item({
          prompt: 'How do I set the dilution ratio on the proportioner?',
          expected_agent: 'dilution',
        }),
        item({ prompt: 'zzz qqq', expected_agent: 'product' }),
      ],
      'keyword',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.routerType).toBe('keyword');
    expect(result.items).toHaveLength(2);
    expect(result.summary.total).toBe(2);
    expect(result.items.every((row) => row.error === null)).toBe(true);
    expect(result.items.every((row) => row.detail?.kind === 'keyword')).toBe(true);
    expect(result.summary.correct).toBe(
      result.items.filter((row) => row.passed).length,
    );
  });

  it('reports an unroutable prompt as ambiguous and failing, not as unscored', async () => {
    const result = await runRoutingTest(
      [item({ prompt: '   ', expected_agent: 'product' })],
      'keyword',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.items[0]?.predicted).toBe('ambiguous');
    expect(result.items[0]?.passed).toBe(false);
    expect(result.summary).toMatchObject({ total: 1, correct: 0, accuracy: 0 });
  });

  it('returns an empty-but-ok run with a warning when there are no items', async () => {
    const result = await runRoutingTest([], 'keyword');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.items).toEqual([]);
    expect(result.warning).toBeTruthy();
  });
});
