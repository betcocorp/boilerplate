import { describe, expect, it } from 'vitest';

import {
  deriveHealthVerdict,
  describeGateFailure,
  formatPassRatePercent,
  tierStatusLine,
} from './verdict';

import type { GoldenSetMembership, GoldenSetRollupResult, GoldenTierRollup } from '~/lib/tests/golden-set';
import type { TierTarget } from '~/lib/tests/tier-targets';

const membership: GoldenSetMembership = {
  goldenTests: [{ id: 't1', name: 'Golden set', rowCount: 60 }],
  totalItems: 60,
  itemCountByTier: { 1: 48, 2: 10, 3: 2 },
  missingPriority: [],
};

function target(tier: 1 | 2 | 3, targetPassRate: number, isGate: boolean): TierTarget {
  return { tier, targetPassRate, isGate, label: `Tier ${tier} label` };
}

/** Seeded defaults: Tier 1 hard gate at 100%, Tier 2/3 non-gating. */
const defaultTargets: TierTarget[] = [
  target(1, 1, true),
  target(2, 0.8, false),
  target(3, 0, false),
];

function tierRollup(
  tier: 1 | 2 | 3,
  graded: number,
  passed: number,
): GoldenTierRollup {
  return {
    tier,
    itemCount: membership.itemCountByTier[tier],
    gradedCount: graded,
    passedCount: passed,
    passRate: graded > 0 ? passed / graded : null,
  };
}

function rollupResult(tiers: GoldenTierRollup[], runCreatedAts: string[] = []): GoldenSetRollupResult {
  return {
    kind: 'rollup',
    membership,
    tiers,
    resolvedRuns: runCreatedAts.map((createdAt, index) => ({
      testId: 't1',
      runId: `run-${index}`,
      appVersion: '2.1.0',
      createdAt,
    })),
    unattributedResultItemCount: 0,
    resultRowsOnMissingPriorityItems: 0,
  };
}

describe('deriveHealthVerdict', () => {
  it('BLOCKED when a gating tier is below its stored target, naming rate, requirement and failing count', () => {
    const verdict = deriveHealthVerdict(
      rollupResult([tierRollup(1, 48, 46), tierRollup(2, 10, 10), tierRollup(3, 2, 2)]),
      defaultTargets,
    );

    expect(verdict.state).toBe('blocked');
    expect(verdict.failures).toEqual([
      { tier: 1, passRate: 46 / 48, targetPassRate: 1, failingCount: 2, gradedCount: 48 },
    ]);
    expect(verdict.sentence).toBe(
      'Tier 1 gate at 95.8% of the 100% required · 2 failing prompts',
    );
  });

  it('a non-gating tier scoring badly never yields BLOCKED', () => {
    const verdict = deriveHealthVerdict(
      // Tier 2 at 10% (far below its 80% target) but non-gating; Tier 1 gate passes.
      rollupResult([tierRollup(1, 48, 48), tierRollup(2, 10, 1), tierRollup(3, 2, 0)]),
      defaultTargets,
    );

    expect(verdict.state).toBe('clear');
    expect(verdict.failures).toEqual([]);
    expect(verdict.sentence).toContain('Every gating tier is at or above target');
    expect(verdict.sentence).toContain('Tier 1 at 100% of the 100% required');
  });

  it('UNKNOWN (never clear) when no golden sets exist', () => {
    const verdict = deriveHealthVerdict({ kind: 'no_golden_sets' }, defaultTargets);
    expect(verdict.state).toBe('unknown');
    expect(verdict.sentence).toBe('No golden sets are configured — verdict unknown');
  });

  it('UNKNOWN (never clear) when no golden-set run matches the selection', () => {
    const verdict = deriveHealthVerdict(
      { kind: 'no_golden_run_for_version', version: '9.9.9', membership },
      defaultTargets,
    );
    expect(verdict.state).toBe('unknown');
    expect(verdict.sentence).toBe('No golden-set run for this selection — verdict unknown');
  });

  it('UNKNOWN when a gating tier has no graded rows — a missing measurement is never a pass', () => {
    const verdict = deriveHealthVerdict(
      rollupResult([tierRollup(1, 0, 0), tierRollup(2, 10, 10), tierRollup(3, 2, 2)]),
      defaultTargets,
    );
    expect(verdict.state).toBe('unknown');
    expect(verdict.sentence).toBe(
      'No graded golden-set result for gating Tier 1 in this selection — verdict unknown',
    );
  });

  it('a real gate failure outranks another gate with no data', () => {
    const twoGates = [target(1, 1, true), target(2, 0.8, true), target(3, 0, false)];
    const verdict = deriveHealthVerdict(
      // Tier 2 gate below target with data; Tier 1 gate has no graded rows.
      rollupResult([tierRollup(1, 0, 0), tierRollup(2, 10, 7), tierRollup(3, 2, 2)]),
      twoGates,
    );
    expect(verdict.state).toBe('blocked');
    expect(verdict.sentence).toBe('Tier 2 gate at 70% of the 80% required · 3 failing prompts');
  });

  it('reports the most recent resolved run as the last sweep time', () => {
    const verdict = deriveHealthVerdict(
      rollupResult(
        [tierRollup(1, 48, 48), tierRollup(2, 10, 10), tierRollup(3, 2, 2)],
        ['2026-08-19T10:00:00.000Z', '2026-08-20T09:30:00.000Z'],
      ),
      defaultTargets,
    );
    expect(verdict.lastSweepAt).toBe('2026-08-20T09:30:00.000Z');
  });

  it('CLEAR in words when no gating tiers are configured', () => {
    const verdict = deriveHealthVerdict(
      rollupResult([tierRollup(1, 48, 40), tierRollup(2, 10, 5), tierRollup(3, 2, 0)]),
      [target(1, 1, false), target(2, 0.8, false), target(3, 0, false)],
    );
    expect(verdict.state).toBe('clear');
    expect(verdict.sentence).toBe('No gating tiers are configured — nothing can block');
  });
});

describe('formatPassRatePercent / describeGateFailure', () => {
  it('formats one decimal, dropping a trailing .0', () => {
    expect(formatPassRatePercent(46 / 48)).toBe('95.8%');
    expect(formatPassRatePercent(1)).toBe('100%');
    expect(formatPassRatePercent(0.8)).toBe('80%');
  });

  it('singularises a single failing prompt', () => {
    expect(
      describeGateFailure({
        tier: 1,
        passRate: 47 / 48,
        targetPassRate: 1,
        failingCount: 1,
        gradedCount: 48,
      }),
    ).toBe('Tier 1 gate at 97.9% of the 100% required · 1 failing prompt');
  });
});

describe('tierStatusLine', () => {
  it('gating tier below target reads "Below target"', () => {
    expect(tierStatusLine({ targetPassRate: 1, isGate: true }, 0.958)).toEqual({
      label: 'Below target',
      tone: 'critical',
    });
  });

  it('the SAME rate on a tier reclassified to non-gating stops saying "Below target"', () => {
    expect(tierStatusLine({ targetPassRate: 1, isGate: false }, 0.958)).toEqual({
      label: 'At risk',
      tone: 'warning',
    });
  });

  it('a passing non-gating tier reads "Not gating"; a passing gate reads "At target"', () => {
    expect(tierStatusLine({ targetPassRate: 0, isGate: false }, 0.5)).toEqual({
      label: 'Not gating',
      tone: 'neutral',
    });
    expect(tierStatusLine({ targetPassRate: 1, isGate: true }, 1)).toEqual({
      label: 'At target',
      tone: 'ok',
    });
  });

  it('a null pass rate reads "No data" regardless of gating', () => {
    expect(tierStatusLine({ targetPassRate: 1, isGate: true }, null)).toEqual({
      label: 'No data',
      tone: 'neutral',
    });
  });
});
