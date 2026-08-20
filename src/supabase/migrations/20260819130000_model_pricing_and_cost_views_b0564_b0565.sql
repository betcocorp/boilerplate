-- B0-564 / B0-565 — model_pricing table + cost rollup views (epic B0-562, cost observability).
--
-- Depends on B0-563's stamp of `output.model` (plain string) + `output.usage.{promptTokens,
-- completionTokens,cachedPromptTokens,totalTokens}` on every `public.workflow_steps` row that
-- makes a model call (`orchestration_planner`, `openai_responses_agent`, `validator`, `revision`).
-- Rows predating that fix have no `output.model` and are excluded by every view below, so
-- historical cost is understated for those rows rather than silently wrong.

-- ── 1. model_pricing ─────────────────────────────────────────────────────────

create table if not exists public.model_pricing (
  id uuid primary key default gen_random_uuid(),
  model_id text not null,
  input_cost_per_mtok numeric(10,4) not null,
  -- B0-565: `workflow_steps.output.usage.promptTokens` already INCLUDES cached tokens as a subset
  -- (see B0-324), and OpenAI bills cached input at a separate discounted rate. Nullable: falls back
  -- to `input_cost_per_mtok` in the views below for a model with no published cached rate.
  cached_input_cost_per_mtok numeric(10,4) null,
  output_cost_per_mtok numeric(10,4) not null,
  effective_date date not null,
  updated_by text null,
  notes text null,
  created_at timestamptz not null default now(),
  unique (model_id, effective_date)
);

create index if not exists model_pricing_model_id_effective_date_idx
  on public.model_pricing (model_id, effective_date desc);

comment on table public.model_pricing is
  'B0-564 — per-model $/Mtok pricing, dated so a rate change only prices steps run on/after it.';

-- Seed: the models this codebase actually calls today (`~/lib/openai/client.ts`
-- resolveResponsesModel, `~/lib/orchestrator/intent-classifier.ts` resolveRouterModel). Rates are
-- OpenAI's published standard API pricing, fetched from platform.openai.com/docs/pricing on
-- 2026-08-19 — not fabricated/estimated. Re-verify and insert a new (model_id, effective_date) row
-- rather than editing these if OpenAI's rates change; never overwrite a historical row.
insert into public.model_pricing
  (model_id, input_cost_per_mtok, cached_input_cost_per_mtok, output_cost_per_mtok, effective_date, updated_by, notes)
values
  ('gpt-4.1',      2.00, 0.50,  8.00, '2026-08-19', 'seed_migration', 'B0-564 seed — OpenAI published standard pricing, fetched 2026-08-19.'),
  ('gpt-4.1-mini',  0.40, 0.10,  1.60, '2026-08-19', 'seed_migration', 'B0-564 seed — OpenAI published standard pricing, fetched 2026-08-19. Default preview model (BEX_RESPONSES_MODEL).'),
  ('gpt-4o',        2.50, 1.25, 10.00, '2026-08-19', 'seed_migration', 'B0-564 seed — OpenAI published standard pricing, fetched 2026-08-19.'),
  ('gpt-4o-mini',   0.15, 0.075, 0.60, '2026-08-19', 'seed_migration', 'B0-564 seed — OpenAI published standard pricing, fetched 2026-08-19. Default router/classifier model (BEX_ROUTER_MODEL).')
on conflict (model_id, effective_date) do nothing;

-- ── 2. Cost rollup views ─────────────────────────────────────────────────────

-- One bucketed rollup, parameterized by date_trunc unit, factored out so the day/month views stay
-- byte-identical in shape and cost formula.
create or replace view public.cost_by_model_per_day as
select
  date_trunc('day', ws.started_at) as bucket,
  ws.output->>'model' as model_id,
  count(*) as step_count,
  sum((ws.output->'usage'->>'promptTokens')::numeric) as prompt_tokens,
  sum((ws.output->'usage'->>'completionTokens')::numeric) as completion_tokens,
  sum((ws.output->'usage'->>'cachedPromptTokens')::numeric) as cached_prompt_tokens,
  sum((ws.output->'usage'->>'totalTokens')::numeric) as total_tokens,
  sum(
    ((ws.output->'usage'->>'promptTokens')::numeric - (ws.output->'usage'->>'cachedPromptTokens')::numeric)
      / 1000000.0 * mp.input_cost_per_mtok
    + (ws.output->'usage'->>'cachedPromptTokens')::numeric
      / 1000000.0 * coalesce(mp.cached_input_cost_per_mtok, mp.input_cost_per_mtok)
    + (ws.output->'usage'->>'completionTokens')::numeric / 1000000.0 * mp.output_cost_per_mtok
  ) as estimated_cost_usd
from public.workflow_steps ws
cross join lateral (
  select p.input_cost_per_mtok, p.cached_input_cost_per_mtok, p.output_cost_per_mtok
  from public.model_pricing p
  where p.model_id = ws.output->>'model'
    and p.effective_date <= ws.started_at::date
  order by p.effective_date desc
  limit 1
) mp
where ws.output->>'model' is not null
  and ws.output->'usage' is not null
group by 1, 2;

comment on view public.cost_by_model_per_day is
  'B0-565 — daily $ + token rollup per model, from workflow_steps joined to the latest model_pricing row effective on or before the step.';

create or replace view public.cost_by_model_per_month as
select
  date_trunc('month', ws.started_at) as bucket,
  ws.output->>'model' as model_id,
  count(*) as step_count,
  sum((ws.output->'usage'->>'promptTokens')::numeric) as prompt_tokens,
  sum((ws.output->'usage'->>'completionTokens')::numeric) as completion_tokens,
  sum((ws.output->'usage'->>'cachedPromptTokens')::numeric) as cached_prompt_tokens,
  sum((ws.output->'usage'->>'totalTokens')::numeric) as total_tokens,
  sum(
    ((ws.output->'usage'->>'promptTokens')::numeric - (ws.output->'usage'->>'cachedPromptTokens')::numeric)
      / 1000000.0 * mp.input_cost_per_mtok
    + (ws.output->'usage'->>'cachedPromptTokens')::numeric
      / 1000000.0 * coalesce(mp.cached_input_cost_per_mtok, mp.input_cost_per_mtok)
    + (ws.output->'usage'->>'completionTokens')::numeric / 1000000.0 * mp.output_cost_per_mtok
  ) as estimated_cost_usd
from public.workflow_steps ws
cross join lateral (
  select p.input_cost_per_mtok, p.cached_input_cost_per_mtok, p.output_cost_per_mtok
  from public.model_pricing p
  where p.model_id = ws.output->>'model'
    and p.effective_date <= ws.started_at::date
  order by p.effective_date desc
  limit 1
) mp
where ws.output->>'model' is not null
  and ws.output->'usage' is not null
group by 1, 2;

comment on view public.cost_by_model_per_month is
  'B0-565 — monthly $ + token rollup per model. Same shape/formula as cost_by_model_per_day, bucketed by calendar month.';

create or replace view public.cost_comparison_yoy as
select
  cur.bucket as month,
  cur.model_id,
  cur.total_tokens as current_total_tokens,
  cur.estimated_cost_usd as current_cost_usd,
  prior.total_tokens as prior_year_total_tokens,
  prior.estimated_cost_usd as prior_year_cost_usd,
  case
    when prior.estimated_cost_usd is null or prior.estimated_cost_usd = 0 then null
    else (cur.estimated_cost_usd - prior.estimated_cost_usd) / prior.estimated_cost_usd
  end as yoy_cost_change_pct
from public.cost_by_model_per_month cur
left join public.cost_by_model_per_month prior
  on prior.model_id = cur.model_id
  and prior.bucket = cur.bucket - interval '1 year';

comment on view public.cost_comparison_yoy is
  'B0-565 — each month vs. the same calendar month one year prior, per model. NULL prior-year columns mean no data existed then, not zero cost.';
