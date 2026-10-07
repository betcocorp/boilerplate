import { describe, expect, it } from 'vitest';

import {
  PROVIDER_FAULT_INVALID_RATE_THRESHOLD,
  computeRunProviderHealth,
  type RunProviderFaultInput,
} from './run-provider-health';

function answered(): RunProviderFaultInput {
  return { providerFault: null };
}

function faulted(kind: string): RunProviderFaultInput {
  return { providerFault: kind };
}

describe('computeRunProviderHealth (B0-1014)', () => {
  it('reports a clean run as valid', () => {
    const health = computeRunProviderHealth(Array.from({ length: 20 }, answered));

    expect(health.invalid).toBe(false);
    expect(health.totalItems).toBe(20);
    expect(health.faultedItems).toBe(0);
    expect(health.faultRate).toBe(0);
    expect(health.kinds).toEqual([]);
    expect(health.topKind).toBeNull();
  });

  it('reproduces the 2026-09-14 outage: every item refused by the provider', () => {
    const health = computeRunProviderHealth(
      Array.from({ length: 106 }, () => faulted('insufficient_quota')),
    );

    expect(health.invalid).toBe(true);
    expect(health.totalItems).toBe(106);
    expect(health.faultedItems).toBe(106);
    expect(health.faultRate).toBe(1);
    expect(health.topKind).toBe('insufficient_quota');
    expect(health.kinds).toEqual([{ kind: 'insufficient_quota', count: 106 }]);
  });

  it('trips at exactly the threshold and stays valid just under it', () => {
    // 5 of 100 === 0.05 exactly: at the threshold, so invalid.
    const atThreshold = computeRunProviderHealth([
      ...Array.from({ length: 5 }, () => faulted('rate_limited')),
      ...Array.from({ length: 95 }, answered),
    ]);
    expect(atThreshold.faultRate).toBe(PROVIDER_FAULT_INVALID_RATE_THRESHOLD);
    expect(atThreshold.invalid).toBe(true);

    // 4 of 100 === 0.04: below the threshold, so the pass rate still means something.
    const belowThreshold = computeRunProviderHealth([
      ...Array.from({ length: 4 }, () => faulted('rate_limited')),
      ...Array.from({ length: 96 }, answered),
    ]);
    expect(belowThreshold.faultRate).toBe(0.04);
    expect(belowThreshold.invalid).toBe(false);
    expect(belowThreshold.faultedItems).toBe(4);
  });

  it('counts every item in the denominator, including the answered ones', () => {
    const health = computeRunProviderHealth([
      faulted('provider_unavailable'),
      answered(),
      answered(),
      answered(),
    ]);

    expect(health.totalItems).toBe(4);
    expect(health.faultRate).toBe(0.25);
  });

  it('orders kinds by count, breaking ties alphabetically', () => {
    const health = computeRunProviderHealth([
      faulted('rate_limited'),
      faulted('rate_limited'),
      faulted('rate_limited'),
      faulted('provider_unavailable'),
      faulted('provider_unavailable'),
      faulted('invalid_credentials'),
      faulted('invalid_credentials'),
      faulted('insufficient_quota'),
    ]);

    expect(health.kinds).toEqual([
      { kind: 'rate_limited', count: 3 },
      // Tie at 2 → alphabetical, so the render order never flips between page loads.
      { kind: 'invalid_credentials', count: 2 },
      { kind: 'provider_unavailable', count: 2 },
      { kind: 'insufficient_quota', count: 1 },
    ]);
    expect(health.topKind).toBe('rate_limited');
  });

  it('returns a clean verdict for an empty run rather than dividing by zero', () => {
    const health = computeRunProviderHealth([]);

    expect(health.totalItems).toBe(0);
    expect(health.faultedItems).toBe(0);
    expect(health.faultRate).toBeNull();
    expect(health.invalid).toBe(false);
    expect(health.kinds).toEqual([]);
    expect(health.topKind).toBeNull();
  });

  it('counts a fault string it does not recognize — the column is free text', () => {
    const health = computeRunProviderHealth([
      faulted('some_future_kind_nobody_has_added_yet'),
      ...Array.from({ length: 9 }, answered),
    ]);

    expect(health.invalid).toBe(true);
    expect(health.faultedItems).toBe(1);
    expect(health.topKind).toBe('some_future_kind_nobody_has_added_yet');
  });

  it('treats a blank or whitespace-only fault as "answered"', () => {
    const health = computeRunProviderHealth([
      { providerFault: '' },
      { providerFault: '   ' },
      answered(),
    ]);

    expect(health.faultedItems).toBe(0);
    expect(health.faultRate).toBe(0);
    expect(health.invalid).toBe(false);
  });
});
