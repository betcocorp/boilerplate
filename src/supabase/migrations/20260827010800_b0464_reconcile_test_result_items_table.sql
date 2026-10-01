-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed from the live catalog on 2026-08-27 (pg_attribute/pg_attrdef for the generated-column
-- expressions, pg_constraint, pg_indexes, pg_description), not from memory.
--
-- `public.test_result_items` is named by many committed migrations (B0-394, B0-472, B0-495, B0-500,
-- B0-652 all ALTER it) but its CREATE TABLE was never committed. The name-based `rel-missing` check
-- therefore missed it; the tightened check added in this ticket (which requires a migration to
-- actually CREATE the relation, not merely mention it) surfaced it.
--
-- The full live shape is transcribed here, generated columns included, so this one file is a
-- faithful record of the live relation. Statements are all no-ops against the current live DB.

create table if not exists public.test_result_items (
  id uuid primary key default gen_random_uuid(),
  test_result_id uuid not null references public.test_results (id) on delete cascade,
  test_item_id uuid not null references public.test_items (id) on delete cascade,
  row_index integer not null,
  status text not null default 'completed'::text,
  passed boolean not null default false,
  elapsed_ms integer not null,
  error_message text,
  response_text text,
  response_payload jsonb,
  created_at timestamptz not null default now(),
  ttft_ms integer,
  workflow_run_id uuid references public.workflow_runs (id) on delete set null,
  prompt_version text generated always as
    (nullif((response_payload ->> 'promptVersion'::text), ''::text)) stored,
  answer_provenance text generated always as
    (nullif((response_payload ->> 'answerProvenance'::text), ''::text)) stored,
  app_version text,
  routing_decision text generated always as
    (nullif((response_payload ->> 'routingDecision'::text), ''::text)) stored,
  keyword_route text,
  llm_route text,
  routing_confidence double precision,
  intended_agent_label text,
  keyword_route_latency_ms integer,
  llm_route_latency_ms integer,
  max_similarity double precision generated always as (
    case
      when jsonb_typeof(((response_payload -> 'similaritySummary'::text) -> 'selectedTopSimilarity'::text)) = 'number'::text
        then (((response_payload -> 'similaritySummary'::text) ->> 'selectedTopSimilarity'::text))::double precision
      else null::double precision
    end
  ) stored,
  confidence double precision generated always as (
    case
      when jsonb_typeof((response_payload -> 'confidence'::text)) = 'number'::text
        then ((response_payload ->> 'confidence'::text))::double precision
      else null::double precision
    end
  ) stored,
  confidence_provenance text generated always as
    (nullif((response_payload ->> 'confidenceProvenance'::text), ''::text)) stored,
  agent_confidence double precision generated always as (
    case
      when jsonb_typeof((response_payload -> 'agentConfidence'::text)) = 'number'::text
        then ((response_payload ->> 'agentConfidence'::text))::double precision
      else null::double precision
    end
  ) stored,
  semantic_route text,
  semantic_confidence double precision,
  semantic_margin double precision,
  semantic_path text,
  semantic_route_latency_ms integer,
  semantic_embedding_ms integer,
  semantic_scoring_ms integer,
  routing_agreement text
);

-- Base columns only: everything above `ttft_ms` predates any committed ALTER, so these are the
-- statements that actually record the drift when the table already exists.
alter table public.test_result_items add column if not exists status text not null default 'completed'::text;
alter table public.test_result_items add column if not exists passed boolean not null default false;
alter table public.test_result_items add column if not exists error_message text;
alter table public.test_result_items add column if not exists response_text text;
alter table public.test_result_items add column if not exists response_payload jsonb;
alter table public.test_result_items add column if not exists created_at timestamptz not null default now();

create index if not exists idx_test_result_items_result_id
  on public.test_result_items using btree (test_result_id, row_index);

-- RLS + test_result_items_service_role policy already checked in via
-- 20260715090200_enable_rls_and_policies.sql.
alter table public.test_result_items enable row level security;
