-- B0-500 — routing-comparison columns on test_result_items, so the eval harness can compare the
-- keyword router (`routeUserMessageToSme`) against the LLM intent classifier (`classifyUserIntent`,
-- B0-503/504) per item, keyed against ground truth (`test_items.intended_agent_item` / the parent
-- `tests.intended_agent`). Persisted by the B0-501 dual-router instrumentation in
-- `~/lib/tests/run-executor.ts`; this migration only adds the columns.
--
-- `routing_decision` is a GENERATED column, same treatment as `prompt_version`/`answer_provenance`
-- (B0-394): it is already serialized on every chat item's `response_payload.routingDecision` (the
-- REAL routing decision that produced the answer — see `productSupportOutcomeSchema` /
-- `run-product-support-workflow.ts`), so promoting it out of jsonb avoids storing it twice and keeps
-- it queryable/indexable. It is the baseline the other two columns are compared against.
--
-- `keyword_route` / `llm_route` / `routing_confidence` / `intended_agent_label` are plain
-- (non-generated) columns instead, unlike `routing_decision`: they are NOT already present anywhere
-- in `response_payload` — B0-501 computes them as pure instrumentation (calling both routers itself,
-- independent of whatever routed the real answer) and writes them directly at insert time, the same
-- precedent as `ttft_ms`/`app_version`. A generated-column cast (e.g. `::double precision` for
-- `routing_confidence`) would risk turning one unexpected payload value into a failed test-run write
-- (the exact risk the B0-394 migration comment calls out) for no benefit, since this data isn't
-- already sitting in `response_payload` to begin with.
--
-- All five columns are nullable with no backfill: every row written before this migration has no way
-- to know its routing comparison, so it stays NULL rather than being backfilled with a value that
-- would misrepresent history.
alter table public.test_result_items
  add column if not exists routing_decision text
    generated always as (nullif(response_payload ->> 'routingDecision', '')) stored,
  add column if not exists keyword_route text,
  add column if not exists llm_route text,
  add column if not exists routing_confidence double precision,
  add column if not exists intended_agent_label text;

comment on column public.test_result_items.routing_decision is
  'B0-500. Generated from response_payload->>''routingDecision'' — the REAL routing decision that produced this item''s answer (SmeAgentId or ''ambiguous''). Null for items predating routing-decision stamping or where the workflow declined before routing.';

comment on column public.test_result_items.keyword_route is
  'B0-500/B0-501. The keyword router''s (routeUserMessageToSme) decision for this item''s prompt, normalized to SmeAgentId | ''ambiguous'' (no-signal collapses to ''ambiguous''). Instrumentation only — computed independently of routing_decision and never used to route the real answer. Null for items recorded before this eval-harness instrumentation landed.';

comment on column public.test_result_items.llm_route is
  'B0-500/B0-501. The LLM intent classifier''s (classifyUserIntent) decision for this item''s prompt (SmeAgentId | ''ambiguous''). Instrumentation only. When BEX_LLM_ROUTER_ENABLED is not ''true'', classifyUserIntent itself returns the keyword-router fallback, so this will equal keyword_route rather than reflect a real model call — see run-executor.ts for the flag. Null for items recorded before this instrumentation landed.';

comment on column public.test_result_items.routing_confidence is
  'B0-500/B0-501. classifyUserIntent''s calibrated 0-1 confidence for llm_route. Fixed placeholder values (0.5 matched / 0 ambiguous) when classifyUserIntent fell back to the keyword router (BEX_LLM_ROUTER_ENABLED off, or an LLM error/timeout) rather than a real model call. Null for items recorded before this instrumentation landed.';

comment on column public.test_result_items.intended_agent_label is
  'B0-500/B0-501. Ground-truth SME agent id for this item, snapshotted at run time from test_items.intended_agent_item (B0-498) and falling back to the parent tests.intended_agent (suite-level tag) when the per-item value is unset. Null when neither is set.';

create index if not exists test_result_items_routing_decision_idx
  on public.test_result_items (routing_decision)
  where routing_decision is not null;

create index if not exists test_result_items_llm_route_idx
  on public.test_result_items (llm_route)
  where llm_route is not null;
