-- B0-1109 — per-call token usage for the three per-item test-run graders (criteria/decline/
-- failure-root-cause), so a run's grading cost is exact. Report-generation grading (case-scorer,
-- synthesizer, run-insights, run-comparison-analysis) is explicitly OUT of scope here.

create table public.test_grading_usage (
  id uuid primary key default gen_random_uuid(),
  test_result_id uuid not null references public.test_results(id) on delete cascade,
  test_item_id uuid not null references public.test_items(id) on delete cascade,
  call_site text not null check (call_site in ('criteria_grader', 'decline_grader', 'failure_root_cause')),
  provider text not null check (provider in ('openai', 'anthropic')),
  model text not null,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  cached_prompt_tokens integer not null default 0,
  total_tokens integer not null default 0,
  created_at timestamptz not null default now()
);

create index test_grading_usage_test_result_id_idx on public.test_grading_usage (test_result_id);

comment on table public.test_grading_usage is
  'B0-1109 — per-call token usage for the three per-item test-run graders (criteria/decline/failure-root-cause), so grading cost per run is queryable via test_grading_cost_by_run. Report-generation grading (case-scorer, synthesizer, run-insights) is NOT captured here — separate scope.';

-- Same cost formula and lateral-join pattern as public.cost_by_model_per_day / _per_month
-- (20260819130000_model_pricing_and_cost_views_b0564_b0565.sql): cached tokens billed at
-- cached_input_cost_per_mtok when the model has a published cached rate, else fall back to
-- input_cost_per_mtok; joined to the latest model_pricing row effective on or before the call.
create or replace view public.test_grading_cost_by_run as
select
  tgu.test_result_id,
  count(*) as call_count,
  sum(tgu.prompt_tokens) as prompt_tokens,
  sum(tgu.completion_tokens) as completion_tokens,
  sum(tgu.cached_prompt_tokens) as cached_prompt_tokens,
  sum(tgu.total_tokens) as total_tokens,
  sum(
    (tgu.prompt_tokens - tgu.cached_prompt_tokens)::numeric / 1000000.0 * mp.input_cost_per_mtok
    + tgu.cached_prompt_tokens::numeric
      / 1000000.0 * coalesce(mp.cached_input_cost_per_mtok, mp.input_cost_per_mtok)
    + tgu.completion_tokens::numeric / 1000000.0 * mp.output_cost_per_mtok
  ) as estimated_cost_usd
from public.test_grading_usage tgu
cross join lateral (
  select p.input_cost_per_mtok, p.cached_input_cost_per_mtok, p.output_cost_per_mtok
  from public.model_pricing p
  where p.model_id = tgu.model
    and p.effective_date <= tgu.created_at::date
  order by p.effective_date desc
  limit 1
) mp
group by 1;

comment on view public.test_grading_cost_by_run is
  'B0-1109 — total per-item-grading token usage and estimated $ cost for one test run (test_result_id), from test_grading_usage joined to the latest model_pricing row effective on or before each call.';
