-- B0-818 — three grading passes by default.
--
-- The reference agent-evaluation methodology (§4b) grades every dataset three times and
-- consolidates on the median so a verdict that wobbles across passes is flagged for review
-- rather than trusted. Bex's REPORT_GRADING_PASSES row was set to 1 on 2026-08-27 as an
-- opt-in; Tom Bird (2026-09-03) decided the default follows the reference. Cost note: ~3x
-- grading calls per report (≈ 700 on the 234-case set). DEFAULT_GRADING_PASSES in
-- src/lib/tests/report/consolidate.ts moves to 3 in the same change so a missing row
-- behaves the same. Reports already generated keep the pass count they were graded at.
update public.settings
set value = '3',
    description = 'How many independent grading passes each case gets in a run report (1-9). Each pass is a separate grading call that never sees another pass''s scores; the report consolidates on the median per sub-score and per judged metric, and flags cases whose passes disagreed. Default 3 per the agent-evaluation methodology §4b (B0-818, 2026-09-03; was 1 from 2026-08-27). Read once per report and persisted on report_state.passes.'
where key = 'REPORT_GRADING_PASSES';

-- B0-811 — reporting thresholds for the two judged metrics (methodology §7c), mirroring the
-- reference judged_metrics.py THRESHOLDS exactly. Read once per report by
-- loadJudgedThresholds() (src/lib/tests/report/scoring-config.ts) and persisted on
-- report_state.judgedThresholds. None of these touches a score: they only decide which cases
-- the report names (review queue, the two exception cells) and how the bands are drawn.
insert into public.settings (key, value, value_type, description, allowed_values)
values
  ('REPORT_JUDGED_SIM_HIGH', '0.75', 'number',
   'Judged similarity (0-1) at or above which a case is in the "high" similarity band in the run report. Reported, never graded (methodology 7c). Reference default 0.75.', null),
  ('REPORT_JUDGED_SIM_LOW', '0.40', 'number',
   'Judged similarity (0-1) below which a case is in the "low" similarity band in the run report. Reported, never graded (methodology 7c). Reference default 0.40.', null),
  ('REPORT_JUDGED_LOW_CONFIDENCE', '70', 'number',
   'Evaluator confidence (0-100) at or below which a case joins the run report''s SME review queue. Reported, never graded (methodology 7c). Reference default 70.', null),
  ('REPORT_JUDGED_HIGH_SIM_FAIL', '0.60', 'number',
   'Judged similarity (0-1) at or above which a FAILING case is named as "close to the ideal and still failed" (shape right, substance wrong). Reference default 0.60.', null),
  ('REPORT_JUDGED_LOW_SIM_PASS', '0.50', 'number',
   'Judged similarity (0-1) below which a PASSING case is named as "passed while diverging from the ideal" (right by a different route). Reference default 0.50.', null),
  ('REPORT_JUDGED_CORR_MIN_N', '5', 'number',
   'Minimum number of cases with a judged similarity before the run report prints a similarity-vs-score correlation. Reference default 5.', null)
on conflict (key) do nothing;
