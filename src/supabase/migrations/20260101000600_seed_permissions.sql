-- Baseline permission catalog. The selectors below must stay in step with `PERMISSIONS` in
-- src/lib/permissions/constants.ts. Add a row here (and a grant) for every selector you add there.
--
-- The seed is intentionally data-free: no users. To make yourself an administrator after the first
-- sign-in, insert your own row and assign the wildcard permission directly:
--
--   insert into public.app_user (user_id, name, email) values ('<id>', '<name>', '<email>');
--   insert into public.user_group_permission (user_group_permission_id, user_id, entity_type, entity_id)
--   select gen_random_uuid()::text, '<id>', 'PERMISSION_GROUP', permission_group_id
--   from public.permission_group where selector = 'it-admin';

insert into public.permission_group (permission_group_id, selector, description)
values ('4ccf2523-ec6a-45fe-b58f-ef9c9114856b', 'it-admin', 'Super admin: access to all functionality.')
on conflict do nothing;

insert into public.permission (permission_id, selector, description)
values
  (gen_random_uuid()::text, 'admin.card.permissions', 'Access control: manage users, groups and permissions.'),
  (gen_random_uuid()::text, 'navigation.sidebar.user.analytics', 'Account menu: Analytics (application usage dashboard).'),
  -- Grant-side wildcards. Nothing checks these directly; hasPermission() resolves them.
  (gen_random_uuid()::text, '*', 'Wildcard grant: every permission.'),
  (gen_random_uuid()::text, 'navigation.*', 'Wildcard grant: every navigation.* selector.')
on conflict (selector) do nothing;

-- it-admin holds the bare wildcard, which covers every current and future selector.
insert into public.group_permission (group_permission_id, permission_id, permission_group_id)
select gen_random_uuid()::text, p.permission_id, g.permission_group_id
from public.permission p
cross join public.permission_group g
where p.selector = '*' and g.selector = 'it-admin'
on conflict (permission_group_id, permission_id) do nothing;
