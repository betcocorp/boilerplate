-- B0-567 — nav-visibility permission for the new /admin/cost dashboard.
--
-- Same deny-by-default, it-admin-only pattern as B0-560
-- (20260819120000_rebuild_nav_visibility_permissions_b0560.sql): a permission row plus a real
-- group_permission grant, no per-user direct grant required.

insert into public.permission (permission_id, selector, description)
values
  (gen_random_uuid()::text, 'navigation.sidebar.cost', 'Admin sidebar: Cost monitoring dashboard (B0-562).')
on conflict (selector) do nothing;

insert into public.group_permission (group_permission_id, permission_id, permission_group_id)
select
  gen_random_uuid()::text,
  p.permission_id,
  '4ccf2523-ec6a-45fe-b58f-ef9c9114856b' -- it-admin
from public.permission p
where p.selector = 'navigation.sidebar.cost'
on conflict (permission_group_id, permission_id) do nothing;
