alter table public.test_results
  add column if not exists report_overall_avg numeric
    generated always as ((report_state->'overall'->>'avg')::numeric) stored,
  add column if not exists report_overall_grade text
    generated always as (report_state->'overall'->>'grade') stored;

comment on column public.test_results.report_overall_avg is 'B0-1087 (follow-up to B0-786): extracted from report_state.overall.avg for SQL trend queries without jsonb scanning.';
comment on column public.test_results.report_overall_grade is 'B0-1087 (follow-up to B0-786): extracted from report_state.overall.grade.';
