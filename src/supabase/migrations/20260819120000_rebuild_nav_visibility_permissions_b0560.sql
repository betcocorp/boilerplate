-- =============================================================================
-- B0-560: rebuild admin nav-visibility permissions as deny-by-default, it-admin only.
--
-- Scope: nav/account-menu visibility selectors only. bex.chat.use,
-- bex.agent_mode.select and every group's grant of either are left untouched --
-- those gate real Bex chat API access, not nav visibility, and are out of
-- scope for this pass.
--
-- DISCOVERY WHILE WRITING THIS TICKET: the repo's earlier seed migration
-- (20260811090001_seed_permissions_from_c360.sql) was never actually applied
-- to the live project -- none of its navigation.sidebar.*/bex.*/
-- admin.card.permissions rows, its 7 permission_group rows' grants, or its
-- direct '*' it-admin grants existed there. The only rows that existed were
-- 7 hand-created ones using an older, code-dead naming convention
-- (dashboard.permissions.card, sidebar.navigation.*), added through the admin
-- UI rather than by any migration. Of those 7, only
-- 'sidebar.navigation.api_permissions' had a live grant (it-admin, added
-- 2026-08-13) -- the other 6 had zero group_permission rows anywhere. This
-- migration reconciles the live catalog with what the rebuilt nav-visibility
-- code actually checks, on top of whichever of those two starting states this
-- project happens to be in (every step is written to be a no-op if its target
-- rows don't exist).
--
-- After: every nav-visibility selector the code checks is a real
-- group_permission row owned by it-admin only, so group membership alone is
-- sufficient -- no per-user direct grant required. Every other group
-- (crm-admin, executive, sales, customer-service,
-- finance-contract-management, operations) loses nav-visibility access
-- entirely; they retain only their existing bex.chat.use /
-- bex.agent_mode.select rows, untouched.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Drop the it-admin per-member direct '*' grants (B0-403's design, if
--    present) -- no longer needed once it-admin has real group_permission
--    rows (below).
-- ---------------------------------------------------------------------------
delete from public.user_group_permission
where entity_type = 'PERMISSION'
  and entity_id in (select permission_id from public.permission where selector = '*');

-- ---------------------------------------------------------------------------
-- 2. Drop every group_permission row for a nav-visibility selector, for every
--    group -- both the seed migration's intended navigation.sidebar.*
--    convention and the hand-created dashboard.permissions.card /
--    sidebar.navigation.* convention actually found live. bex.chat.use /
--    bex.agent_mode.select rows are not touched.
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
    'admin.card.permissions',
    'dashboard.permissions.card',
    'sidebar.navigation.api_permissions',
    'sidebar.navigation.ingestion',
    'sidebar.navigation.product.orphan',
    'sidebar.navigation.products.corpus',
    'sidebar.navigation.products.generate',
    'sidebar.navigation.products.legacy'
  )
);

-- ---------------------------------------------------------------------------
-- 3. Drop the now-unused permission rows: the seed migration's grant-only
--    wildcards and dead-nav selectors, plus the hand-created selectors this
--    ticket's code no longer checks (dashboard.permissions.card is replaced
--    by admin.card.permissions; sidebar.navigation.api_permissions is
--    replaced by navigation.sidebar.user.api_access below; the remaining 5
--    sidebar.navigation.products.*/ingestion/product.orphan rows had no
--    grants and no matching code path even before this ticket).
-- ---------------------------------------------------------------------------
delete from public.permission
where selector in (
  '*',
  'navigation.*',
  'navigation.sidebar.bex',
  'navigation.sidebar.projects',
  'dashboard.permissions.card',
  'sidebar.navigation.api_permissions',
  'sidebar.navigation.ingestion',
  'sidebar.navigation.product.orphan',
  'sidebar.navigation.products.corpus',
  'sidebar.navigation.products.generate',
  'sidebar.navigation.products.legacy'
);

-- ---------------------------------------------------------------------------
-- 4. Ensure every nav-visibility selector the rebuilt code checks exists as a
--    permission row -- covers both the "seed migration never ran" case (all
--    9 reused navigation.sidebar.*/admin.card.permissions selectors below are
--    missing) and the "seed migration did run" case (on conflict do nothing
--    leaves the existing rows as-is), plus the 3 selectors this ticket adds:
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
  (gen_random_uuid()::text, 'navigation.sidebar.tests', 'Admin sidebar: test runner + failure queue + routing comparison.'),
  (gen_random_uuid()::text, 'navigation.sidebar.observability', 'Admin sidebar: prompt observability.'),
  (gen_random_uuid()::text, 'navigation.sidebar.tools', 'Admin sidebar: tools (cross-reference, web search, semantic search).'),
  (gen_random_uuid()::text, 'navigation.sidebar.products', 'Admin sidebar: Products (RAG corpus quality, Orphan monitor, Legacy products).'),
  (gen_random_uuid()::text, 'navigation.sidebar.sds', 'Admin sidebar: SDS ingestion.'),
  (gen_random_uuid()::text, 'navigation.sidebar.efficacy', 'Admin sidebar: Efficacy ingestion.'),
  (gen_random_uuid()::text, 'navigation.sidebar.knowledge', 'Admin sidebar: Knowledge ingestion.'),
  (gen_random_uuid()::text, 'navigation.sidebar.labels', 'Admin sidebar: Label ingestion.'),
  (gen_random_uuid()::text, 'admin.card.permissions', 'Admin dashboard: show the permissions administration card; account menu: Access control.'),
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
