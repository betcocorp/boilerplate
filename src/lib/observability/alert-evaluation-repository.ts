/**
 * B0-466 — the only writer for `public.observability_alert_evaluations`.
 *
 * Same split as `~/lib/observability/stalled-run-repository.ts`: all I/O for the alerter lives
 * here so the decision module (`alert-rules.ts`) stays pure. The table exists because a silent
 * alerter is indistinguishable from a broken one — a `verdict = 'ok'` row is the proof it ran and
 * looked at real data, and the absence of recent rows is itself the signal to investigate.
 *
 * Persistence is best-effort at the CALL SITE (see `run-alert-evaluation.ts`): a failed insert is
 * reported, never allowed to swallow findings that were already delivered.
 */

import { logWarn } from '~/lib/observability/logger';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { Json } from '~/types/supabase.public';

export const ALERT_EVALUATION_TABLE = 'observability_alert_evaluations';

export type AlertEvaluationVerdict = 'ok' | 'findings' | 'error';
export type AlertEvaluationTrigger = 'cron' | 'manual';

export type AlertEvaluationRecordInput = {
  evaluatedAt: string;
  trigger: AlertEvaluationTrigger;
  verdict: AlertEvaluationVerdict;
  findingCount: number;
  maxSeverity: 'warning' | 'critical' | null;
  findings: Json;
  thresholds: Json;
  metrics: Json;
  delivery: Json;
  windowFrom: string | null;
  windowTo: string | null;
  durationMs: number;
  error: string | null;
};

/** Returns the new row's id, or `null` when the insert failed (already logged). */
export async function recordAlertEvaluation(
  input: AlertEvaluationRecordInput,
): Promise<string | null> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from(ALERT_EVALUATION_TABLE)
      .insert({
        evaluated_at: input.evaluatedAt,
        trigger: input.trigger,
        verdict: input.verdict,
        finding_count: input.findingCount,
        max_severity: input.maxSeverity,
        findings: input.findings,
        thresholds: input.thresholds,
        metrics: input.metrics,
        delivery: input.delivery,
        window_from: input.windowFrom,
        window_to: input.windowTo,
        duration_ms: input.durationMs,
        error: input.error,
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(error.message);
    }
    return data?.id ?? null;
  } catch (error) {
    logWarn('observability_alert_evaluation_persist_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export type AlertEvaluationSummary = {
  id: string;
  evaluatedAt: string;
  trigger: string;
  verdict: string;
  findingCount: number;
  maxSeverity: string | null;
  error: string | null;
};

/** Most recent evaluations, newest first — the "did the alerter actually run?" read. */
export async function listRecentAlertEvaluations(limit = 10): Promise<AlertEvaluationSummary[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from(ALERT_EVALUATION_TABLE)
    .select('id,evaluated_at,trigger,verdict,finding_count,max_severity,error')
    .order('evaluated_at', { ascending: false })
    .limit(Math.min(100, Math.max(1, limit)));

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    evaluatedAt: row.evaluated_at,
    trigger: row.trigger,
    verdict: row.verdict,
    findingCount: row.finding_count,
    maxSeverity: row.max_severity,
    error: row.error,
  }));
}
