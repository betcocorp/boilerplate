-- Cost monitoring (epic B0-562) — "runs covered" summary card.
--
-- The B0-565 views group by (bucket, model), so summing step_count/tokens/cost across buckets is
-- safe (each step belongs to exactly one bucket+model), but a single workflow_run has multiple
-- steps and can call more than one model, so summing a per-bucket-per-model run count would
-- double- (or triple-) count runs. This needs one exact `count(distinct workflow_run_id)` over the
-- caller's date range instead, so it's a parameterized function (the `admin_latest_failures_page`
-- precedent), not a plain view.

CREATE OR REPLACE FUNCTION public.cost_covered_run_count(
  p_start timestamptz,
  p_end   timestamptz
)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT count(DISTINCT workflow_run_id)::integer
  FROM public.workflow_steps
  WHERE output->>'model' IS NOT NULL
    AND output->'usage' IS NOT NULL
    AND started_at >= p_start
    AND started_at <= p_end;
$$;

COMMENT ON FUNCTION public.cost_covered_run_count(timestamptz, timestamptz) IS
  'Cost monitoring dashboard — distinct workflow_runs with at least one cost-tracked step in [p_start, p_end].';

-- Same lockdown as the B0-282/283 security pass: PostgREST exposes every public-schema function to
-- anon/authenticated via /rest/v1/rpc/* by default; this is service-role-only (called from
-- ~/lib/observability/cost-metrics.ts).
REVOKE EXECUTE ON FUNCTION public.cost_covered_run_count(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cost_covered_run_count(timestamptz, timestamptz) TO service_role;
ALTER FUNCTION public.cost_covered_run_count(timestamptz, timestamptz) SET search_path = public, pg_catalog;
