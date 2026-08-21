-- Add nav-visibility permission for the new /admin/settings page.
-- Same deny-by-default, it-admin-only pattern as B0-560.

insert into public.permission (permission_id, selector, description)
values
  (gen_random_uuid()::text, 'navigation.sidebar.user.settings', 'Admin sidebar: Settings page for toggling environment variables.')
on conflict (selector) do nothing;

insert into public.group_permission (group_permission_id, permission_id, permission_group_id)
select
  gen_random_uuid()::text,
  p.permission_id,
  '4ccf2523-ec6a-45fe-b58f-ef9c9114856b' -- it-admin
from public.permission p
where p.selector = 'navigation.sidebar.user.settings'
on conflict (permission_group_id, permission_id) do nothing;
