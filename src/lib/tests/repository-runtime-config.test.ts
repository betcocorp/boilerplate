import { describe, expect, it, vi } from 'vitest';

/**
 * B0-494 — a run executed under the B0-452 kill switch has fictional confidence caps, so the
 * `/gate` endpoint must be able to tell CI "don't trust this run's confidence_ok" without reading
 * logs. `anyResultItemHasConfidenceGatingDisabled` is the paginated scan behind that check.
 */

type Row = { response_payload: unknown };

function fakeSupabaseReturning(rows: Row[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            range: async () => ({ data: rows, error: null }),
          }),
        }),
      }),
    }),
  };
}

let mockRows: Row[] = [];

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => fakeSupabaseReturning(mockRows),
}));

import { anyResultItemHasConfidenceGatingDisabled } from '~/lib/tests/repository';

function runtimeConfig(overrides: Partial<{ confidenceGatingDisabled: boolean }> = {}) {
  return {
    useValidator: false,
    earlyDeclineGateEnabled: true,
    aiSdkGenerationEnabled: false,
    rerankerActive: false,
    confidenceGatingDisabled: false,
    agentMode: 'orchestrator',
    routedDirectly: false,
    ...overrides,
  };
}

describe('anyResultItemHasConfidenceGatingDisabled (B0-494)', () => {
  it('is true when any item recorded confidenceGatingDisabled: true', async () => {
    mockRows = [
      { response_payload: { runtimeConfig: runtimeConfig() } },
      { response_payload: { runtimeConfig: runtimeConfig({ confidenceGatingDisabled: true }) } },
    ];
    expect(await anyResultItemHasConfidenceGatingDisabled('result-1')).toBe(true);
  });

  it('is false when every item ran with gating enabled', async () => {
    mockRows = [
      { response_payload: { runtimeConfig: runtimeConfig() } },
      { response_payload: { runtimeConfig: runtimeConfig() } },
    ];
    expect(await anyResultItemHasConfidenceGatingDisabled('result-2')).toBe(false);
  });

  it('is false for historical items with no runtimeConfig block at all', async () => {
    mockRows = [{ response_payload: { confidence: 0.9 } }, { response_payload: null }];
    expect(await anyResultItemHasConfidenceGatingDisabled('result-3')).toBe(false);
  });

  it('is false for an empty result set', async () => {
    mockRows = [];
    expect(await anyResultItemHasConfidenceGatingDisabled('result-4')).toBe(false);
  });
});
