-- =============================================================================
-- B0-448: conversation source column, bex.chat.view-all selector, test-run backfill.
--
-- 1. agent_conversations.source distinguishes real user chats ('chat', default)
--    from rows created by the test runner ('test_run'), so B0-449/450/451 can
--    filter test-runner noise out of per-user conversation views.
-- 2. agent_conversations.user_id converts uuid -> text: app_user.user_id is a
--    text Salesforce-style id, and this column is currently 0/9556 populated
--    (verified live), so the type change is lossless. Indexed for the
--    per-user, most-recent-first lookups B0-449 will add.
-- 3. bex.chat.view-all is a new permission, granted to it-admin via an explicit
--    group_permission row (it-admin already matches everything via its direct
--    '*' user_group_permission grant, but this row keeps the B0-412 audit
--    dashboard, which diffs group_permission against constants.ts, honest).
-- 4. Backfill: any agent_conversations row already referenced by a
--    test_result_items.response_payload->>'conversationId' is retroactively
--    marked source = 'test_run' (spot-checked live: 8,769 distinct conversation
--    ids in test_result_items, all 8,769 match existing agent_conversations rows).
--
-- Explicitly out of scope: no RLS policies (per-user RLS is deferred until
-- user_id is actually populated, see 20260715090200_enable_rls_and_policies.sql).
-- =============================================================================

alter table public.agent_conversations
  add column source text not null default 'chat' check (source in ('chat', 'test_run'));

alter table public.agent_conversations
  alter column user_id type text using user_id::text;

create index agent_conversations_user_id_updated_at_idx
  on public.agent_conversations (user_id, updated_at desc);

insert into public.permission (permission_id, selector, description)
values (gen_random_uuid()::text, 'bex.chat.view-all', 'Bex chat: view every user''s conversations (it-admin only).')
on conflict (selector) do nothing;

insert into public.group_permission (group_permission_id, permission_id, permission_group_id)
select gen_random_uuid()::text, p.permission_id, '4ccf2523-ec6a-45fe-b58f-ef9c9114856b'
from public.permission p
where p.selector = 'bex.chat.view-all'
on conflict (permission_group_id, permission_id) do nothing;

update public.agent_conversations set source = 'test_run'
where id in (
  select distinct (response_payload->>'conversationId')::uuid
  from public.test_result_items
  where response_payload->>'conversationId' is not null
);
