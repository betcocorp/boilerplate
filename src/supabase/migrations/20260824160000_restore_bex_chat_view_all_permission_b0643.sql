-- =============================================================================
-- B0-643: restore the bex.chat.view-all permission and its it-admin grant.
--
-- B0-448's migration (20260811170000_add_conversation_source_and_view_all_b0448.sql)
-- is recorded as applied, but a live check found zero bex.chat.* rows in
-- public.permission and no bex.chat.view-all grant on it-admin's
-- group_permission rows -- the same "seed migration recorded as applied but
-- never actually took effect" pattern B0-560 documented for this same
-- permission subsystem. As a result, no it-admin member (all 6 hold
-- membership via a normal PERMISSION_GROUP row, not a direct '*' grant) can
-- exercise the already-built view-all UI/API path in /admin/bex.
--
-- Idempotent: safe to run regardless of whether the row/grant already exist.
-- =============================================================================

insert into public.permission (permission_id, selector, description)
values (gen_random_uuid()::text, 'bex.chat.view-all', 'Bex chat: view every user''s conversations (it-admin only).')
on conflict (selector) do nothing;

insert into public.group_permission (group_permission_id, permission_id, permission_group_id)
select gen_random_uuid()::text, p.permission_id, '4ccf2523-ec6a-45fe-b58f-ef9c9114856b' -- it-admin
from public.permission p
where p.selector = 'bex.chat.view-all'
on conflict (permission_group_id, permission_id) do nothing;
