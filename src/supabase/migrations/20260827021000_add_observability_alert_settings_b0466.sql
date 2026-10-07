-- B0-466: thresholds for the observability alert evaluator, in `settings` so they are tunable
-- from /admin/settings without a deploy (same pattern as the B0-618/B0-686 batches).
--
-- Defaults are calibrated against this project's real history (audit_logs `tool_succeeded` /
-- `tool_failed`, 2026-04-10 → 2026-08-27, day buckets on the settled denominator):
--   * the 2026-05-22 regression this ticket exists for went 1.28% (2026-05-20, 235 settled) →
--     68.93% (1,149 settled) in one step. It trips BOTH the absolute rule and the spike rule.
--   * the calmest recent regime sits at 0.00%–1.32% per day, and the noisiest ordinary day
--     (2026-08-26, 8.33% of 132 settled) must NOT alert — it is below the 15% absolute floor and
--     its +7.47pp step is below the 10pp spike delta.
-- Retuning these rows changes behaviour immediately; the resolved values are copied onto every
-- `observability_alert_evaluations` row so a past verdict stays interpretable afterwards.
--
-- The optional outbound webhook URL is deliberately NOT stored here: it is a credential, and
-- `settings` is a UI-editable table. It is read from the OBSERVABILITY_ALERT_WEBHOOK_URL env var.

INSERT INTO public.settings (key, value, value_type, description, allowed_values) VALUES
  ('ALERT_SENTRY_ENABLED', 'true', 'boolean',
   'Emit observability alert findings to Sentry via captureMessage', NULL),
  ('ALERT_TOOL_FAILURE_LOOKBACK_DAYS', '7', 'number',
   'Days of tool-call history the alert evaluator scans (day buckets)', NULL),
  ('ALERT_TOOL_FAILURE_RATE_WARNING', '0.15', 'number',
   'Tool-call failure rate (0-1) of settled calls that raises a warning', NULL),
  ('ALERT_TOOL_FAILURE_RATE_CRITICAL', '0.30', 'number',
   'Tool-call failure rate (0-1) of settled calls that raises a critical alert', NULL),
  ('ALERT_TOOL_FAILURE_MIN_SETTLED_CALLS', '50', 'number',
   'Minimum settled tool calls in a bucket before its failure rate is alertable', NULL),
  ('ALERT_TOOL_FAILURE_SPIKE_DELTA', '0.10', 'number',
   'Day-over-day tool failure-rate increase (0-1, absolute) that counts as a spike', NULL),
  ('ALERT_TOOL_FAILURE_SPIKE_RATIO', '3', 'number',
   'Multiple of the baseline tool failure rate that counts as a spike (with the delta, both must hold)', NULL),
  ('ALERT_GOLDEN_PASS_RATE_DROP_WARNING', '0.10', 'number',
   'Run-over-run golden-set pass-rate drop (0-1) that raises a warning', NULL),
  ('ALERT_GOLDEN_PASS_RATE_DROP_CRITICAL', '0.20', 'number',
   'Run-over-run golden-set pass-rate drop (0-1) that raises a critical alert', NULL),
  ('ALERT_GOLDEN_MIN_GRADED_ITEMS', '5', 'number',
   'Minimum graded golden-set items in a run before its pass rate is alertable', NULL),
  ('ALERT_GOLDEN_GATE_MISS_ENABLED', 'true', 'boolean',
   'Alert when a gating golden-set tier misses its tier_targets pass rate', NULL)
ON CONFLICT (key) DO NOTHING;
