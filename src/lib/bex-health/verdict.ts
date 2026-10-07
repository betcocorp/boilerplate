/**
 * B0-579 / B0-580 — pure verdict derivation for the Bex Health dashboard (epic B0-569).
 *
 * Inputs are exactly the two canonical readers' shapes — `getGoldenSetTierRollup` and
 * `getTierTargets` — so no target literal and no ad-hoc tier math can appear in a component.
 *
 * INVARIANTS (B0-579 AC):
 *  - Exactly three verdict states: `blocked` / `clear` / `unknown`.
 *  - A tier with `isGate === false` can never produce `blocked` (delegated to `verdictForTier`).
 *  - A missing measurement is never a pass: no rollup, or a gating tier with no graded rows,
 *    yields `unknown` — stated in words — never `clear`.
 *  - A real failing measurement outranks a missing one: one gate below target is `blocked`
 *    even if another gate has no data.
 */

import { verdictForTier, type TierTarget, type TierVerdict } from '~/lib/tests/tier-targets';

import type { GoldenSetRollupResult } from '~/lib/tests/golden-set';

export type HealthVerdictState = 'blocked' | 'clear' | 'unknown';

/** One gating tier below its stored target. */
export type GateFailure = {
  tier: number;
  /** 0..1 */
  passRate: number;
  /** 0..1, from `tier_targets` — never a literal. */
  targetPassRate: number;
  failingCount: number;
  gradedCount: number;
};

export type HealthVerdict = {
  state: HealthVerdictState;
  /** The verdict in words — colour is never the only signal. */
  sentence: string;
  /** Non-empty exactly when `state === 'blocked'`. */
  failures: GateFailure[];
  /** `created_at` of the most recent resolved golden run, when a rollup exists. */
  lastSweepAt: string | null;
  /** Total count of failing items across all golden sets (sum of failingCount from all failures). */
  totalFailingCount: number;
};

/** `0.9583…` → `95.8%`; `1` → `100%` (one decimal, trailing `.0` dropped). */
export function formatPassRatePercent(rate: number): string {
  const points = Math.round(rate * 1000) / 10;
  return Number.isInteger(points) ? `${points}%` : `${points.toFixed(1)}%`;
}

/** e.g. `Tier 1 gate at 95.8% of the 100% required · 2 failing prompts`. */
export function describeGateFailure(failure: GateFailure): string {
  const plural = failure.failingCount === 1 ? '' : 's';
  return (
    `Tier ${failure.tier} gate at ${formatPassRatePercent(failure.passRate)} of the ` +
    `${formatPassRatePercent(failure.targetPassRate)} required · ` +
    `${failure.failingCount} failing prompt${plural}`
  );
}

export function deriveHealthVerdict(
  rollup: GoldenSetRollupResult,
  targets: TierTarget[],
): HealthVerdict {
  if (rollup.kind === 'no_golden_sets') {
    return {
      state: 'unknown',
      sentence: 'No golden sets are configured — verdict unknown',
      failures: [],
      lastSweepAt: null,
      totalFailingCount: 0,
    };
  }

  if (rollup.kind === 'no_golden_run_for_version') {
    return {
      state: 'unknown',
      sentence: 'No golden-set run for this selection — verdict unknown',
      failures: [],
      lastSweepAt: null,
      totalFailingCount: 0,
    };
  }

  const lastSweepAt = rollup.resolvedRuns.reduce<string | null>(
    (latest, run) => (latest === null || run.createdAt > latest ? run.createdAt : latest),
    null,
  );

  const gatingTargets = targets.filter((target) => target.isGate);
  if (gatingTargets.length === 0) {
    return {
      state: 'clear',
      sentence: 'No gating tiers are configured — nothing can block',
      failures: [],
      lastSweepAt,
      totalFailingCount: 0,
    };
  }

  const failures: GateFailure[] = [];
  const gatesWithoutData: number[] = [];
  const passingGates: string[] = [];

  for (const target of gatingTargets) {
    const tierRollup = rollup.tiers.find((tier) => tier.tier === target.tier);
    const passRate = tierRollup?.passRate ?? null;
    const verdict: TierVerdict = verdictForTier(target, passRate);

    if (verdict === 'blocked' && tierRollup && passRate !== null) {
      failures.push({
        tier: target.tier,
        passRate,
        targetPassRate: target.targetPassRate,
        failingCount: tierRollup.gradedCount - tierRollup.passedCount,
        gradedCount: tierRollup.gradedCount,
      });
    } else if (verdict === 'no_data') {
      gatesWithoutData.push(target.tier);
    } else if (verdict === 'pass' && passRate !== null) {
      passingGates.push(
        `Tier ${target.tier} at ${formatPassRatePercent(passRate)} of the ` +
          `${formatPassRatePercent(target.targetPassRate)} required`,
      );
    }
  }

  // A real failing measurement outranks a missing one.
  const totalFailingCount = failures.reduce((sum, failure) => sum + failure.failingCount, 0);

  if (failures.length > 0) {
    return {
      state: 'blocked',
      sentence: failures.map(describeGateFailure).join('; '),
      failures,
      lastSweepAt,
      totalFailingCount,
    };
  }

  if (gatesWithoutData.length > 0) {
    const tierList = gatesWithoutData.map((tier) => `Tier ${tier}`).join(', ');
    return {
      state: 'unknown',
      sentence: `No graded golden-set result for gating ${tierList} in this selection — verdict unknown`,
      failures: [],
      lastSweepAt,
      totalFailingCount,
    };
  }

  return {
    state: 'clear',
    sentence: `Every gating tier is at or above target — ${passingGates.join('; ')}`,
    failures: [],
    lastSweepAt,
    totalFailingCount,
  };
}

// ---------------------------------------------------------------------------
// B0-580 — per-tier status line for the tier cards
// ---------------------------------------------------------------------------

export type TierStatusTone = 'critical' | 'warning' | 'ok' | 'neutral';

export type TierStatus = { label: string; tone: TierStatusTone };

/**
 * The tier card's status line, derived from the STORED target (`verdictForTier`) — a tier
 * reclassified to non-gating stops saying "Below target" with no code change here.
 */
export function tierStatusLine(
  target: Pick<TierTarget, 'targetPassRate' | 'isGate'>,
  passRate: number | null,
): TierStatus {
  const verdict = verdictForTier(target, passRate);
  switch (verdict) {
    case 'blocked':
      return { label: 'Below target', tone: 'critical' };
    case 'miss':
      return { label: 'At risk', tone: 'warning' };
    case 'pass':
      return target.isGate
        ? { label: 'At target', tone: 'ok' }
        : { label: 'Not gating', tone: 'neutral' };
    case 'no_data':
      return { label: 'No data', tone: 'neutral' };
  }
}
