-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed from the live catalog on 2026-08-27, not from memory.
--
-- `public.ai_suggestions` is named by 20260715090200_enable_rls_and_policies.sql (RLS) and by the
-- B0-420 metadata comment, but its CREATE TABLE was never committed. Surfaced by the tightened
-- `rel-missing` check added in this ticket.
--
-- Deliberately un-keyed to any one parent: entity_id is text, not a uuid FK, because a suggestion
-- set can hang off a test item or a workflow run. Transcribed as-is.
--
-- Every statement below is a NO-OP against the current live database.

create table if not exists public.ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id text not null,
  title text not null,
  content text not null,
  sort_order integer not null default 0,
  model text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

alter table public.ai_suggestions add column if not exists model text;
alter table public.ai_suggestions add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists ai_suggestions_entity_idx
  on public.ai_suggestions using btree (entity_type, entity_id);

-- RLS + ai_suggestions_service_role policy already checked in via
-- 20260715090200_enable_rls_and_policies.sql.
alter table public.ai_suggestions enable row level security;

comment on table public.ai_suggestions is
  'Stores AI-generated suggestions for any entity (items, runs, etc). One row per suggestion.';
comment on column public.ai_suggestions.entity_type is 'e.g. ''item'', ''run''';
comment on column public.ai_suggestions.entity_id is 'The UUID of the entity this suggestion belongs to.';
comment on column public.ai_suggestions.sort_order is '1-based order within a set of suggestions for the same entity.';
comment on column public.ai_suggestions.metadata is
  'Generation metadata for this suggestion set. B0-420 stores {"gradingContext": true|false} for entity_type=''workflow_run'' rows: whether harness pass/fail, expected-should-answer and ideal_response were available to the model when these insights were produced. A row lacking gradingContext=true is regenerated once grading context becomes available. Defaults to an empty object for pre-B0-420 rows and for the ''item'' scope.';
