-- B0-761 — nav-visibility permission for the new /admin/analytics dashboard.
--
-- Same deny-by-default, it-admin-only pattern as B0-560/B0-567: a permission row plus a real
-- group_permission grant, no per-user direct grant required. The link renders in the account
-- menu (~/components/admin/AdminAccountMenu.tsx), directly above "API access".

insert into public.permission (permission_id, selector, description)
values
  (gen_random_uuid()::text, 'navigation.sidebar.user.analytics', 'Account menu: Analytics (application usage dashboard, B0-761).')
on conflict (selector) do nothing;

insert into public.group_permission (group_permission_id, permission_id, permission_group_id)
select
  gen_random_uuid()::text,
  p.permission_id,
  '4ccf2523-ec6a-45fe-b58f-ef9c9114856b' -- it-admin
from public.permission p
where p.selector = 'navigation.sidebar.user.analytics'
on conflict (permission_group_id, permission_id) do nothing;
