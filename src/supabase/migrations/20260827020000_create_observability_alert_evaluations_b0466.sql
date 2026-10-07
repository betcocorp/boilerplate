-- B0-466: durable verdict trail for the observability alert evaluator.
--
-- A silent alerter is indistinguishable from no alerter, so EVERY evaluation writes one row
-- here — including the ones that found nothing and the ones that failed. `verdict = 'ok'` with
-- a recent `evaluated_at` is the proof the cron is alive; the absence of recent rows is itself
-- the signal that the alerter stopped running.
--
-- Service-role only, like `api_request_log`: RLS is enabled with NO policies, so nothing but
-- the service-role key (the cron route) can read or write it.

CREATE TABLE IF NOT EXISTS public.observability_alert_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  -- How the evaluation was started. 'cron' is the scheduled GET; 'manual' is an operator POST.
  trigger text NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron', 'manual')),
  -- 'ok' = ran, no findings. 'findings' = at least one threshold tripped. 'error' = the
  -- evaluation itself failed, which is a distinct and equally reportable outcome.
  verdict text NOT NULL CHECK (verdict IN ('ok', 'findings', 'error')),
  finding_count integer NOT NULL DEFAULT 0 CHECK (finding_count >= 0),
  -- Highest severity across `findings`; NULL when there were none.
  max_severity text CHECK (max_severity IN ('warning', 'critical')),
  -- The structured findings exactly as emitted (alertFindingSchema in ~/lib/observability/alert-rules).
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The resolved thresholds the verdict was reached against, so a past verdict stays readable
  -- after someone retunes the `settings` rows.
  thresholds jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Observed metric summary (current/baseline buckets, sample sizes, skip reasons). This is what
  -- makes a `verdict = 'ok'` row informative rather than just "nothing happened".
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Per-channel delivery outcome (Sentry, optional webhook). Best-effort delivery is recorded,
  -- never allowed to change the verdict.
  delivery jsonb NOT NULL DEFAULT '{}'::jsonb,
  window_from timestamptz,
  window_to timestamptz,
  duration_ms integer,
  error text
);

CREATE INDEX IF NOT EXISTS observability_alert_evaluations_evaluated_at_idx
  ON public.observability_alert_evaluations (evaluated_at DESC);

CREATE INDEX IF NOT EXISTS observability_alert_evaluations_verdict_idx
  ON public.observability_alert_evaluations (verdict, evaluated_at DESC);

ALTER TABLE public.observability_alert_evaluations ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.observability_alert_evaluations IS
  'B0-466 — one row per observability alert evaluation (tool-call failure rate, golden-set pass rate). Written by /api/v1/observability/evaluate-alerts.';
