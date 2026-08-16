-- B0-524: capture per-router wall-clock latency for the B0-501 dual-router eval instrumentation,
-- so B0-509's RoutingComparisonDashboard latency section has real data instead of "not available yet".
alter table public.test_result_items
  add column keyword_route_latency_ms integer null,
  add column llm_route_latency_ms integer null;

comment on column public.test_result_items.keyword_route_latency_ms is
  'Wall-clock ms for routeUserMessageToSme() in run-executor.ts dual-router instrumentation (B0-501/B0-524). Null on rows predating this column.';

comment on column public.test_result_items.llm_route_latency_ms is
  'Wall-clock ms for classifyUserIntent() in run-executor.ts dual-router instrumentation (B0-501/B0-524), including any cache hit or keyword-fallback path. Null on rows predating this column.';
