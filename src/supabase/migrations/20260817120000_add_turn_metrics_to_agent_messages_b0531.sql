-- B0-531 — turn-level latency metrics on `agent_messages`, splitting the time a user spent
-- *thinking* (user pause) from the time the agent spent *working* (processing).
--
-- Why columns on `agent_messages` and not a separate turn-metrics table: both metrics are
-- properties of exactly one message row (a user message carries the pause that preceded it; an
-- assistant message carries the processing that produced it), and the single write path is
-- `insertMessage` in `~/lib/conversations/message-repository.ts`, so additive columns need no new
-- join, no second write path, and no FK bookkeeping.
--
-- Definitions (B0-532 populates these at message-write time, new turns only — no backfill):
--   user_pause_ms   on role='user' rows: this message's created_at minus the created_at of the
--                   previous *assistant* message in the same conversation. NULL on the first turn
--                   of a conversation and on non-user rows. Attribution is by conversation_id only
--                   (act-as-aware: never joined across owners).
--   processing_ms   on role='assistant' rows: this message's created_at minus the created_at of
--                   the most recent *user* message in the same conversation (user message received
--                   -> assistant message completed). NULL on non-assistant rows.
-- Both are computed from two Postgres-stamped `created_at` values and clamped at >= 0 in the
-- writer (cross-clock skew precedent: workflow_steps.started_at vs completed_at).
--
-- `pause_tier` is a stored generated column (B0-495 precedent), so the tier can never drift from
-- the duration it was derived from. The boundaries MUST stay in sync with
-- `PAUSE_TIER_BOUNDARIES` in `~/lib/conversations/turn-metrics.ts` (the code-side source of
-- truth, unit-tested there):
--   instant   <  5s        (5000 ms)
--   short     <  30s       (30000 ms)
--   medium    <  5m        (300000 ms)
--   long      <  1h        (3600000 ms)
--   abandoned >= 1h
alter table public.agent_messages
  add column if not exists user_pause_ms bigint,
  add column if not exists processing_ms bigint;

alter table public.agent_messages
  add column if not exists pause_tier text generated always as (
    case
      when user_pause_ms is null then null
      when user_pause_ms < 5000 then 'instant'
      when user_pause_ms < 30000 then 'short'
      when user_pause_ms < 300000 then 'medium'
      when user_pause_ms < 3600000 then 'long'
      else 'abandoned'
    end
  ) stored;

-- The writer clamps at 0; the constraints make the invariant durable against any future writer.
alter table public.agent_messages
  drop constraint if exists agent_messages_user_pause_ms_nonnegative;
alter table public.agent_messages
  add constraint agent_messages_user_pause_ms_nonnegative
    check (user_pause_ms is null or user_pause_ms >= 0);

alter table public.agent_messages
  drop constraint if exists agent_messages_processing_ms_nonnegative;
alter table public.agent_messages
  add constraint agent_messages_processing_ms_nonnegative
    check (processing_ms is null or processing_ms >= 0);

comment on column public.agent_messages.user_pause_ms is
  'B0-531/B0-532. On role=''user'' rows: ms between the previous assistant message''s created_at and this message''s created_at, within the same conversation. NULL for the first user turn, non-user rows, and every row written before the instrumentation (no backfill — treat NULL as unknown, never as 0). Clamped >= 0 by the writer.';

comment on column public.agent_messages.processing_ms is
  'B0-531/B0-532. On role=''assistant'' rows: ms between the triggering user message''s created_at and this message''s created_at (user message received -> assistant message completed). NULL for non-assistant rows and rows predating the instrumentation. Clamped >= 0 by the writer.';

comment on column public.agent_messages.pause_tier is
  'B0-531. Generated from user_pause_ms: instant <5s, short <30s, medium <5m, long <1h, abandoned >=1h. Boundaries mirror PAUSE_TIER_BOUNDARIES in ~/lib/conversations/turn-metrics.ts — change both together. NULL whenever user_pause_ms is NULL.';

-- Partial indexes (B0-495 precedent): every historical row is NULL here permanently, so index
-- only instrumented rows. The distribution query filters a created_at window and groups by tier,
-- so lead with created_at.
create index if not exists agent_messages_pause_tier_created_at_idx
  on public.agent_messages (created_at, pause_tier)
  where pause_tier is not null;

create index if not exists agent_messages_processing_ms_idx
  on public.agent_messages (processing_ms)
  where processing_ms is not null;
