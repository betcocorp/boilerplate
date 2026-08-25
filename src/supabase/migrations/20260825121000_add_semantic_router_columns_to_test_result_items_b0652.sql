-- B0-652 — semantic-router columns for the eval harness, extending the B0-500/B0-501 dual-router
-- instrumentation (keyword_route / llm_route) to a THREE-way comparison: semantic router vs LLM
-- classifier vs ground truth (`intended_agent_label`).
--
-- Naming: the ticket text calls these `semantic_router_route` / `semantic_router_confidence` /
-- `semantic_router_margin`. They are named `semantic_*` here so the trio reads symmetrically with
-- the existing `keyword_route` / `llm_route` columns and so the column names match the
-- `RoutingComparisonFields` keys 1:1 (that struct IS the insert payload — see
-- `~/lib/tests/routing-comparison.ts`). Same data, shorter prefix.
--
-- Latency is split three ways on purpose. A cold semantic route pays an OpenAI embedding
-- round-trip, so a single "latency" number would make the ticket's "≤10ms p95" target look either
-- impossible or dishonest depending on which number you quote. `semantic_embedding_ms` is the
-- network-bound part, `semantic_scoring_ms` is the pure cosine-similarity math (the part a ≤10ms
-- budget can honestly be asserted against), and `semantic_route_latency_ms` is the total the caller
-- actually waited.
--
-- `routing_agreement` is a categorical three-way agreement label (see `computeRoutingAgreement`),
-- not a boolean: with three routers, "did they agree" has more than two useful answers, and knowing
-- WHICH pair agreed is the whole point during a cutover.
--
-- All columns are nullable with no backfill: rows written before this migration have no semantic
-- route, and inventing one would misrepresent history. Items where the semantic router could not be
-- reached at all also stay NULL (a missing measurement is not a fast or an ambiguous one).
alter table public.test_result_items
  add column if not exists semantic_route text,
  add column if not exists semantic_confidence double precision,
  add column if not exists semantic_margin double precision,
  add column if not exists semantic_path text,
  add column if not exists semantic_route_latency_ms integer,
  add column if not exists semantic_embedding_ms integer,
  add column if not exists semantic_scoring_ms integer,
  add column if not exists routing_agreement text;

comment on column public.test_result_items.semantic_route is
  'B0-652. The semantic (embedding-similarity) router''s decision for this item''s prompt, in the same value space as keyword_route/llm_route (SmeAgentId | ''ambiguous''). Instrumentation only — computed independently of routing_decision and never used to route the real answer. Null on rows predating this column or where the semantic router could not be reached.';

comment on column public.test_result_items.semantic_confidence is
  'B0-652. The semantic router''s 0-1 confidence for semantic_route (top-similarity based). Null when semantic_route is null.';

comment on column public.test_result_items.semantic_margin is
  'B0-652. Similarity gap between the semantic router''s top and runner-up routes. The margin threshold is one of the two gates that decide semantic vs fallback path.';

comment on column public.test_result_items.semantic_path is
  'B0-652. ''semantic'' when BOTH the confidence and margin thresholds passed (the router committed to a route), ''fallback'' when it degraded to ''ambiguous''. The false-positive rate counts path=''semantic'' AND semantic_route != intended_agent_label — i.e. confidently wrong.';

comment on column public.test_result_items.semantic_route_latency_ms is
  'B0-652. Total wall-clock ms the caller waited for the semantic route (embedding round-trip + scoring). Null on rows predating this column.';

comment on column public.test_result_items.semantic_embedding_ms is
  'B0-652. The embedding-call portion of semantic_route_latency_ms — network-bound, ~80-400ms cold, near-zero on a cache hit. Reported separately so a scoring-only latency budget stays honest.';

comment on column public.test_result_items.semantic_scoring_ms is
  'B0-652. The cosine-similarity scoring portion of semantic_route_latency_ms (no I/O). This is the number the ticket''s ≤10ms p95 target can legitimately be asserted against.';

comment on column public.test_result_items.routing_agreement is
  'B0-652. Categorical three-way agreement between keyword_route, llm_route and semantic_route: ''all_agree'' | ''keyword_llm'' | ''keyword_semantic'' | ''llm_semantic'' | ''all_differ''. Null when fewer than two of the three routes are present for the item.';

create index if not exists test_result_items_semantic_route_idx
  on public.test_result_items (semantic_route)
  where semantic_route is not null;
