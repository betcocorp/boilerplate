-- B0-1084: conversations created while an admin is "Acting as" another user are owned by the
-- acted-as user (user_id). acted_by_user_id records the true session user who actually created it;
-- null when not acting-as.
alter table public.agent_conversations add column if not exists acted_by_user_id text null;

comment on column public.agent_conversations.acted_by_user_id is
  'B0-1084: true session user id when the conversation was created while acting-as user_id; null otherwise.';
