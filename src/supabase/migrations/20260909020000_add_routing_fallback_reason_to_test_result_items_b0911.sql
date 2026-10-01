-- B0-911 — `routing_fallback_reason` on test_result_items, so a run whose routing pipeline was
-- DEGRADED is readable from the data instead of only from a log line nobody reads.
--
-- Motivating incident (2026-09-08): a paired 106-case OpenAI-vs-Anthropic comparison ran with
-- `classifyUserIntent` 400ing on every single item. Both `classifyUserIntent`
-- (`~/lib/orchestrator/intent-classifier.ts`) and `analyzeTurnSignals`
-- (`~/lib/orchestrator/signals/analyze-turn-signals.ts`) catch every provider failure, log via
-- `logError`, and return a keyword-router fallback carrying `source: 'keyword_fallback'` plus a
-- `fallbackReason`. The run therefore completed, produced a letter grade, and looked healthy — and
-- that grade was then read as a vendor verdict. The only surviving signals were indirect
-- (`routing_confidence` 0.000 and `llm_route` 'ambiguous' on all 106 rows); the REASON existed only
-- in memory. This column persists it.
--
-- Plain (non-generated) nullable text, same precedent as the B0-500 `keyword_route` / `llm_route` /
-- `routing_confidence` columns it sits beside: the value is not present anywhere in
-- `response_payload`, it is computed as instrumentation at insert time by
-- `~/lib/tests/run-executor.ts`, and it is NULL on the happy path (no fallback happened) as well as
-- for every row written before this migration. No backfill: a historical row has no way to know its
-- fallback reason, and inventing one would misrepresent history. The rate/mean-confidence health
-- check in `~/lib/tests/run-health.ts` still flags those historical rows as degraded off
-- `routing_confidence` alone — it just cannot name their reason, and says so.
alter table public.test_result_items
  add column if not exists routing_fallback_reason text;

comment on column public.test_result_items.routing_fallback_reason is
  'B0-911. Why this item''s routing pipeline fell back to the keyword router, stored verbatim and prefixed with which pass fell back (''signals: <reason>'' for the live analyzeTurnSignals pass on the answer path, ''llm_router: <reason>'' for the harness''s own classifyUserIntent instrumentation call). NULL means no fallback was observed for this item (the happy path) OR the row predates this column — the two are told apart by whether routing_confidence is null. Read by computeRunRoutingHealth (~/lib/tests/run-health.ts), which turns per-item fallbacks into the run-level degraded-pipeline banner shown above the grade.';

create index if not exists test_result_items_routing_fallback_reason_idx
  on public.test_result_items (test_result_id)
  where routing_fallback_reason is not null;
