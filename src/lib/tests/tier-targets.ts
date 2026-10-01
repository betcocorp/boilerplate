import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { GoldenTier } from './golden-set';

/**
 * B0-573 — per-tier pass-rate targets and gate semantics, read from `public.tier_targets`.
 *
 * The verdict strip and tier cards consume THIS reader; no target literal may appear in a
 * component or page. Changing a row in `tier_targets` (via the /admin/tests edit surface)
 * changes behaviour with no deploy.
 *
 * Seeded defaults (see migration `create_tier_targets_b0573`):
 *   Tier 1 — 1.00, hard gate (the only BLOCKED-capable tier by default)
 *   Tier 2 — 0.80, target only (non-gating)
 *   Tier 3 — exploratory, non-gating
 */
export type TierTarget = {
  tier: GoldenTier;
  targetPassRate: number;
  isGate: boolean;
  label: string;
};

/**
 * Verdict for one tier against its target.
 *
 * INVARIANT (B0-573 AC): a tier with `isGate === false` can NEVER be `blocked` — a missed
 * non-gating target is a `miss`, which is informational, not release-blocking. `no_data`
 * means no graded golden-set rows existed for the tier (distinct from a 0% pass rate).
 */
export type TierVerdict = 'pass' | 'miss' | 'blocked' | 'no_data';

export function verdictForTier(
  target: Pick<TierTarget, 'targetPassRate' | 'isGate'>,
  passRate: number | null,
): TierVerdict {
  if (passRate === null) {
    return 'no_data';
  }
  if (passRate >= target.targetPassRate) {
    return 'pass';
  }
  // Below target: only a gating tier can block.
  return target.isGate ? 'blocked' : 'miss';
}

export async function getTierTargets(): Promise<TierTarget[]> {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('tier_targets')
    .select('tier, target_pass_rate, is_gate, label')
    .order('tier', { ascending: true });

  const rows = assertNoError(result) ?? [];
  return rows.map((row) => ({
    tier: row.tier as GoldenTier,
    targetPassRate: Number(row.target_pass_rate),
    isGate: row.is_gate,
    label: row.label,
  }));
}

export type TierTargetUpdate = {
  targetPassRate: number;
  isGate: boolean;
  label: string;
};

/**
 * Updates one tier's row and returns `{ old, new }` so the caller (the admin server action)
 * can record both values in `audit_logs` — the audit write itself stays in the action, next
 * to the actor lookup.
 */
export async function updateTierTarget(
  tier: GoldenTier,
  update: TierTargetUpdate,
): Promise<{ previous: TierTarget; next: TierTarget }> {
  const supabase = getSupabaseServiceRoleClient();

  const before = await supabase
    .from('tier_targets')
    .select('tier, target_pass_rate, is_gate, label')
    .eq('tier', tier)
    .single();
  const beforeRow = assertNoError(before);
  if (!beforeRow) {
    throw new Error(`tier_targets row for tier ${tier} not found`);
  }

  const after = await supabase
    .from('tier_targets')
    .update({
      target_pass_rate: update.targetPassRate,
      is_gate: update.isGate,
      label: update.label,
      updated_at: new Date().toISOString(),
    })
    .eq('tier', tier)
    .select('tier, target_pass_rate, is_gate, label')
    .single();
  const afterRow = assertNoError(after);
  if (!afterRow) {
    throw new Error(`tier_targets row for tier ${tier} disappeared during update`);
  }

  const toTarget = (row: {
    tier: number;
    target_pass_rate: number | string;
    is_gate: boolean;
    label: string;
  }): TierTarget => ({
    tier: row.tier as GoldenTier,
    targetPassRate: Number(row.target_pass_rate),
    isGate: row.is_gate,
    label: row.label,
  });

  return { previous: toTarget(beforeRow), next: toTarget(afterRow) };
}
