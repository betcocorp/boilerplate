-- =============================================================================
-- B0-560: rebuild admin nav-visibility permissions as deny-by-default, it-admin only.
--
-- Scope: nav/account-menu visibility selectors only. bex.chat.use,
-- bex.agent_mode.select and every group's grant of either are left untouched —
-- those gate real Bex chat API access, not nav visibility, and are out of
-- scope for this pass.
--
-- Before: it-admin held no group_permission rows at all and instead relied on
-- a direct '*' grant per member (user_group_permission, entity_type =
-- 'PERMISSION') — a member added to it-admin later via the admin UI inherited
-- nothing until someone remembered to grant them '*' by hand. crm-admin held a
-- blanket 'navigation.*' wildcard that (via hasPermission's dot-wildcard
-- resolution) covered every nav selector including ones added after the fact.
-- Five other groups (executive, sales, customer-service,
-- finance-contract-management, operations) held a mix of
-- navigation.sidebar.bex/.observability/.tools.
--
-- After: every nav-visibility selector is a real group_permission row owned
-- by it-admin only, so membership alone is sufficient — no per-user grant
-- required. All other groups lose nav-visibility access entirely (they retain
-- only their existing bex.chat.use / bex.agent_mode.select rows, untouched).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Drop the it-admin per-member direct '*' grants — no longer needed once
--    it-admin has real group_permission rows (below).
-- ---------------------------------------------------------------------------
delete from public.user_group_permission
where entity_type = 'PERMISSION'
  and entity_id in (select permission_id from public.permission where selector = '*');

-- ---------------------------------------------------------------------------
-- 2. Drop every group_permission row for a nav-visibility selector, for every
--    group (including it-admin, which has none today, and crm-admin's
--    blanket wildcards). bex.chat.use / bex.agent_mode.select rows are not
--    touched — they are not in this selector list.
-- ---------------------------------------------------------------------------
delete from public.group_permission
where permission_id in (
  select permission_id from public.permission
  where selector in (
    '*',
    'navigation.*',
    'navigation.sidebar.bex',
    'navigation.sidebar.products',
    'navigation.sidebar.sds',
    'navigation.sidebar.efficacy',
    'navigation.sidebar.labels',
    'navigation.sidebar.knowledge',
    'navigation.sidebar.tests',
    'navigation.sidebar.observability',
    'navigation.sidebar.tools',
    'navigation.sidebar.projects',
    'admin.card.permissions'
  )
);

-- ---------------------------------------------------------------------------
-- 3. Drop the now-unused permission rows: the two grant-only wildcards
--    (superseded by explicit it-admin grants below) and two selectors with no
--    surviving nav item (navigation.sidebar.bex was never wired to any nav
--    link's `permission` field; navigation.sidebar.projects's only surface,
--    the "API access" account-menu item, is re-gated below under a new
--    selector).
-- ---------------------------------------------------------------------------
delete from public.permission
where selector in ('*', 'navigation.*', 'navigation.sidebar.bex', 'navigation.sidebar.projects');

-- ---------------------------------------------------------------------------
-- 4. Add the 3 new selectors this pass introduces:
--      - navigation.sidebar.ingestion.products: splits the "Ingestion >
--        Products" nav item (/admin/products/rag/generate) off of
--        navigation.sidebar.products, which otherwise conflated it with the
--        unrelated "Products" section (RAG corpus quality / Orphan monitor /
--        Legacy products).
--      - navigation.sidebar.user.api_access: replaces the old
--        'sidebar.navigation.api_permissions' (dead naming convention, and
--        checked via Array.includes so it never honored wildcards).
--      - navigation.sidebar.user.changelog: the Changelog account-menu item
--        was unconditionally visible before this ticket; it is now gated.
-- ---------------------------------------------------------------------------
insert into public.permission (permission_id, selector, description)
values
  (gen_random_uuid()::text, 'navigation.sidebar.ingestion.products', 'Admin sidebar: Ingestion > Products (RAG generate).'),
  (gen_random_uuid()::text, 'navigation.sidebar.user.api_access', 'Account menu: API access (Projects, Analytics).'),
  (gen_random_uuid()::text, 'navigation.sidebar.user.changelog', 'Account menu: Changelog.')
on conflict (selector) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Grant it-admin every nav-visibility selector via real group_permission
--    rows, so membership alone grants access going forward.
-- ---------------------------------------------------------------------------
insert into public.group_permission (group_permission_id, permission_id, permission_group_id)
select
  gen_random_uuid()::text,
  p.permission_id,
  '4ccf2523-ec6a-45fe-b58f-ef9c9114856b' -- it-admin
from public.permission p
where p.selector in (
  'navigation.sidebar.tests',
  'navigation.sidebar.observability',
  'navigation.sidebar.tools',
  'navigation.sidebar.products',
  'navigation.sidebar.ingestion.products',
  'navigation.sidebar.sds',
  'navigation.sidebar.efficacy',
  'navigation.sidebar.knowledge',
  'navigation.sidebar.labels',
  'navigation.sidebar.user.api_access',
  'navigation.sidebar.user.changelog',
  'admin.card.permissions'
)
on conflict (permission_group_id, permission_id) do nothing;
