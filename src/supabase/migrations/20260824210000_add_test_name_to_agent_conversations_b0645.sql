-- B0-645: store the source test's name on test_run conversations so the admin sidebar can show
-- which test produced the conversation, instead of a generic "Admin" badge.
alter table public.agent_conversations add column if not exists test_name text;

-- One-time backfill for existing test_run rows without test_name set, resolved via the
-- test_result_items.response_payload->>'conversationId' link (unindexed jsonb expression — fine
-- for this one-time backfill, but never repeat this join at read time).
update public.agent_conversations ac
set test_name = t.name
from public.test_result_items tri
join public.test_items ti on ti.id = tri.test_item_id
join public.tests t on t.id = ti.test_id
where ac.source = 'test_run'
  and ac.test_name is null
  and (tri.response_payload->>'conversationId')::uuid = ac.id;
