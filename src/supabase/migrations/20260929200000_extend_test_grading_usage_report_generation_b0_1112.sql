-- B0-1112 — extend public.test_grading_usage (B0-1109) to also fit the four report-generation
-- grading call sites (case_scorer, synthesizer_digest, synthesizer_final, run_insights,
-- run_comparison_analysis). run_insights and run_comparison_analysis grade a whole run/comparison,
-- and synthesizer grades across many cases at once — none has a single test_item_id. case_scorer
-- does have a test_item_id but makes multiple passes per item, so pass_index disambiguates them.

alter table public.test_grading_usage alter column test_item_id drop not null;
alter table public.test_grading_usage add column pass_index integer null;

alter table public.test_grading_usage drop constraint test_grading_usage_call_site_check;
alter table public.test_grading_usage add constraint test_grading_usage_call_site_check
  check (call_site in (
    'criteria_grader', 'decline_grader', 'failure_root_cause',
    'case_scorer', 'synthesizer_digest', 'synthesizer_final',
    'run_insights', 'run_comparison_analysis'
  ));

comment on column public.test_grading_usage.test_item_id is
  'B0-1112 — nullable: run_insights, run_comparison_analysis and synthesizer_* calls grade a whole run/comparison/many-cases, not one item.';

comment on column public.test_grading_usage.pass_index is
  'B0-1112 — disambiguates case_scorer''s multiple grading passes per test_item_id; null for call sites that only ever run once per item or run.';

comment on table public.test_grading_usage is
  'B0-1109/B0-1112 — per-call token usage for both the three per-item test-execution graders (criteria/decline/failure-root-cause) and the report-generation grading call sites (case_scorer, synthesizer_digest, synthesizer_final, run_insights, run_comparison_analysis), so grading cost per run is queryable via test_grading_cost_by_run.';
