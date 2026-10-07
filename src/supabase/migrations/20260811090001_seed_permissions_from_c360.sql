-- =============================================================================
-- B0-403 (epic B0-401): seed permissions, groups and users into the B0-402 tables.
--
-- SOURCES
--   * permission_group, app_user, user_group_permission: a FRESH run of the c360
--     export (snowflake-api/node-api scripts/exportPermissionsMigrationSeed.ts),
--     generated 2026-08-11 — NOT the stale 2026-03-25 snapshot in c360's
--     2026-03-17_permissions_tables___NO.sql. Mechanical Snowflake -> Postgres
--     conversion: SELECT * FROM VALUES -> insert ... values, ::TIMESTAMP_TZ ->
--     ::timestamptz, UPPERCASE identifiers -> lowercase snake_case.
--   * permission + group_permission: bex-native selectors (see below), NOT c360's
--     22 permissions — those name c360 surfaces (leads, opportunities, orders,
--     pipeline, activities) that do not exist in bex.
--
-- SOURCE ENVIRONMENT CAVEAT: the export ran against DEV_CRM_DB, not prod (the
-- export script hardcodes NODE_ENV=development and prod Snowflake credentials were
-- not available). USER_IDs and group membership therefore reflect c360 DEV.
-- Re-running the export against prod and reconciling is a prerequisite of B0-413
-- (the enforcement gate), not of this ticket.
--
-- All inserts are ON CONFLICT DO NOTHING so this migration is safe to re-apply and
-- will not clobber rows edited later through the B0-411 admin UI.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- permission_group: the 7 c360 groups, verbatim (same ids, selectors,
-- descriptions and timestamps as CRM_APP.PERMISSION_GROUP).
--
-- DELIBERATE EXCLUSION — c360 actually has 8 groups. 'sales-lead-pilot'
-- (ed7391f6-7951-4647-a548-9a91537e4e00, created 2026-07-06) is NOT seeded:
--   1. it was created after this ticket was written, so it is outside the
--      "7 c360 groups verbatim" scope B0-403 specifies; and
--   2. it is a c360 *leads* pilot group whose only three permissions are
--      leads.view.executive, leads.view.rep and navigation.sidebar.leads —
--      all leads-visibility concerns, which B0-405 explicitly drops from this
--      port as having no bex equivalent.
-- Its 7 members are all also members of 'sales', so excluding it
-- costs nobody their bex access. Recorded here rather than dropped silently.
-- ---------------------------------------------------------------------------
insert into public.permission_group
  (permission_group_id, selector, description, start_at, end_at, created_at, updated_at, deleted_at)
values
  ('3c491112-7476-4918-8e38-304400a49f8b', 'crm-admin', 'Administrative group', null, null, '2026-03-25 17:39:54.200 +0000'::timestamptz, '2026-03-25 17:39:54.200 +0000'::timestamptz, null),
  ('af7b1197-8126-4dc8-9a8a-1b77349f78f7', 'customer-service', 'Staff dedicated to customer service', null, null, '2026-03-17 20:46:33.955 +0000'::timestamptz, '2026-03-17 20:46:33.955 +0000'::timestamptz, null),
  ('8678a33f-3669-4e39-96e3-59a7761b9340', 'executive', 'A group for leadership users focused on high level detail', null, null, '2026-03-17 20:43:18.331 +0000'::timestamptz, '2026-03-17 20:43:18.331 +0000'::timestamptz, null),
  ('128d3ee4-687e-4669-b8d4-198b4e50a8be', 'finance-contract-management', 'Finance & Contract management users', null, null, '2026-03-17 20:47:01.132 +0000'::timestamptz, '2026-03-17 20:47:01.132 +0000'::timestamptz, null),
  ('4ccf2523-ec6a-45fe-b58f-ef9c9114856b', 'it-admin', 'A super admin that gets access to all functionality', null, null, '2026-03-17 20:42:32.459 +0000'::timestamptz, '2026-03-17 20:42:32.459 +0000'::timestamptz, null),
  ('df1fd390-42a7-49bb-9a21-5bbfaf5957ea', 'operations', 'Operations individuals focused on the day to day operations of the warehouse', null, null, '2026-03-17 20:47:23.924 +0000'::timestamptz, '2026-03-17 20:47:23.924 +0000'::timestamptz, null),
  ('80029966-615b-42af-b3a3-1f530a29156d', 'sales', 'Sales representatives group', null, null, '2026-03-17 20:46:06.527 +0000'::timestamptz, '2026-03-17 20:46:06.527 +0000'::timestamptz, null)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- permission: the bex catalog. The first 13 selectors must stay byte-identical
-- to PERMISSIONS in src/lib/permissions/constants.ts (B0-405) — the B0-412 audit
-- dashboard diffs the two, and a drift here is what it is built to catch.
--
-- The last two rows are wildcard GRANT selectors. They are intentionally absent
-- from constants.ts because nothing ever *checks* them: hasPermission()
-- (src/lib/permissions/permissions-server.ts) resolves '*' via its bare-* branch
-- and 'navigation.*' via its dot-wildcard branch, so they only ever appear on the
-- granting side (group_permission / user_group_permission).
-- ---------------------------------------------------------------------------
insert into public.permission (permission_id, selector, description)
values
  ('621fea6a-4f97-5826-b36b-cc6c72d26602', 'navigation.sidebar.bex', 'Admin sidebar: Bex chat.'),
  ('24ea5263-8f34-5896-b6df-c7cdeb648698', 'navigation.sidebar.products', 'Admin sidebar: Products (RAG generate, corpus quality, legacy, orphans).'),
  ('deef4f21-391c-5acf-85f5-3a8b2c96cd67', 'navigation.sidebar.sds', 'Admin sidebar: SDS ingestion.'),
  ('de96b0d3-a1d6-5ce7-a1b6-86c01c226571', 'navigation.sidebar.efficacy', 'Admin sidebar: Efficacy ingestion.'),
  ('14581a54-e39c-5811-85a2-8bf3d24b3a58', 'navigation.sidebar.labels', 'Admin sidebar: Product label ingestion.'),
  ('e89987bf-4758-54e0-8278-10f1e9a357a4', 'navigation.sidebar.knowledge', 'Admin sidebar: Markdown / knowledge ingestion.'),
  ('ce7647f9-8b8f-5449-9e6b-8dd88356c89a', 'navigation.sidebar.tests', 'Admin sidebar: test runner + failure queue.'),
  ('b972fd98-b46a-5b24-8ae8-56971765fd00', 'navigation.sidebar.observability', 'Admin sidebar: prompt observability.'),
  ('acf4a4d3-f0f1-5da8-a0fe-7787de7f890b', 'navigation.sidebar.tools', 'Admin sidebar: tools (cross-reference, web search, semantic search).'),
  ('4e4b1d87-7f47-5050-8bfa-490e284a7b49', 'navigation.sidebar.projects', 'Admin sidebar: API access projects + analytics.'),
  ('f458942e-2e79-5b6e-a70d-1c1427716c23', 'admin.card.permissions', 'Admin dashboard: show the permissions administration card.'),
  ('edac35ed-14a6-5a94-9b30-970038b04f14', 'bex.chat.use', 'Bex chat: send messages / use the assistant.'),
  ('c61b074c-c237-5ad2-a164-503bf229f786', 'bex.agent_mode.select', 'Bex chat: choose the agent mode.'),
  ('c6381696-6a8a-570c-957f-9070e1e314d7', '*', 'Wildcard grant: every permission (matched by hasPermission bare-* branch). Grant-side only — never checked as a surface.'),
  ('0f8e41be-2d3e-5c0b-a1c8-82eee6e3d72c', 'navigation.*', 'Wildcard grant: every navigation.* selector (matched by hasPermission dot-wildcard branch). Grant-side only — never checked as a surface.')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- group_permission: bex group -> selector mapping.
--
--   crm-admin                    navigation.* , admin.card.permissions
--   executive                    bex.chat.use, bex.agent_mode.select,
--                                navigation.sidebar.bex, navigation.sidebar.observability
--   sales                        bex.chat.use, navigation.sidebar.bex, navigation.sidebar.tools
--   customer-service             bex.chat.use, navigation.sidebar.bex, navigation.sidebar.tools
--   finance-contract-management  bex.chat.use, navigation.sidebar.bex
--   operations                   bex.chat.use, navigation.sidebar.bex
--
-- it-admin has NO rows here on purpose: per B0-403 it receives '*' as a DIRECT
-- permission assignment (user_group_permission.entity_type = 'PERMISSION'), see
-- the last block of this migration.
--
-- "Relevant nav" judgement: the ingestion / data-ops surfaces (products, sds,
-- efficacy, labels, knowledge, tests, projects) and admin.card.permissions stay
-- with it-admin and crm-admin only. navigation.sidebar.tools goes to the
-- customer-facing groups because cross-reference / product lookup is their job;
-- navigation.sidebar.observability goes to executive for usage + quality
-- reporting; bex.agent_mode.select stays with executive (and the two admin
-- groups) rather than every chat user.
--
-- KNOWN GAP, deliberately left as the ticket specifies: crm-admin gets
-- navigation.* (which covers navigation.sidebar.bex) but NOT bex.chat.use, so a
-- crm-admin who is not also it-admin can see the Bex link without being able to
-- chat. Widening that is a call for B0-411/B0-413, not a silent change here.
-- ---------------------------------------------------------------------------
insert into public.group_permission (group_permission_id, permission_id, permission_group_id)
values
  ('30021b1b-a4d9-5149-9fea-a58db045c94c', '0f8e41be-2d3e-5c0b-a1c8-82eee6e3d72c', '3c491112-7476-4918-8e38-304400a49f8b'), -- crm-admin -> navigation.*
  ('7bfc0813-a82f-5273-805b-ec7f71709e01', 'f458942e-2e79-5b6e-a70d-1c1427716c23', '3c491112-7476-4918-8e38-304400a49f8b'), -- crm-admin -> admin.card.permissions
  ('36248172-8d94-5c7d-abf2-e408acda3cb8', 'edac35ed-14a6-5a94-9b30-970038b04f14', '8678a33f-3669-4e39-96e3-59a7761b9340'), -- executive -> bex.chat.use
  ('7b903fdc-31ec-5b30-b39a-779e3dd0c2dd', 'c61b074c-c237-5ad2-a164-503bf229f786', '8678a33f-3669-4e39-96e3-59a7761b9340'), -- executive -> bex.agent_mode.select
  ('b1a5bd26-7973-564b-b09b-15ec0e377c82', '621fea6a-4f97-5826-b36b-cc6c72d26602', '8678a33f-3669-4e39-96e3-59a7761b9340'), -- executive -> navigation.sidebar.bex
  ('5e822ba7-6f0e-561e-b7cf-50553ace5bf4', 'b972fd98-b46a-5b24-8ae8-56971765fd00', '8678a33f-3669-4e39-96e3-59a7761b9340'), -- executive -> navigation.sidebar.observability
  ('a7ce9b2d-149a-52d6-a410-b8428df81a07', 'edac35ed-14a6-5a94-9b30-970038b04f14', '80029966-615b-42af-b3a3-1f530a29156d'), -- sales -> bex.chat.use
  ('76c0b4bc-4292-53d0-8149-a20c4d5e6395', '621fea6a-4f97-5826-b36b-cc6c72d26602', '80029966-615b-42af-b3a3-1f530a29156d'), -- sales -> navigation.sidebar.bex
  ('3377a9f6-9dfa-5ffe-8c7a-3234d91a3bbf', 'acf4a4d3-f0f1-5da8-a0fe-7787de7f890b', '80029966-615b-42af-b3a3-1f530a29156d'), -- sales -> navigation.sidebar.tools
  ('fd386ea8-410f-5562-9db5-6f7be8fc4bac', 'edac35ed-14a6-5a94-9b30-970038b04f14', 'af7b1197-8126-4dc8-9a8a-1b77349f78f7'), -- customer-service -> bex.chat.use
  ('bce97e2d-0971-5649-9243-85809abab233', '621fea6a-4f97-5826-b36b-cc6c72d26602', 'af7b1197-8126-4dc8-9a8a-1b77349f78f7'), -- customer-service -> navigation.sidebar.bex
  ('ab0b6189-0ff8-55b8-a793-642848f75c47', 'acf4a4d3-f0f1-5da8-a0fe-7787de7f890b', 'af7b1197-8126-4dc8-9a8a-1b77349f78f7'), -- customer-service -> navigation.sidebar.tools
  ('7422c031-bdb0-5de0-8baa-c49114b27b24', 'edac35ed-14a6-5a94-9b30-970038b04f14', '128d3ee4-687e-4669-b8d4-198b4e50a8be'), -- finance-contract-management -> bex.chat.use
  ('c30a2f1d-0322-593c-976d-e1ad8366ee26', '621fea6a-4f97-5826-b36b-cc6c72d26602', '128d3ee4-687e-4669-b8d4-198b4e50a8be'), -- finance-contract-management -> navigation.sidebar.bex
  ('82abcf76-d8a4-5fb5-9966-b6f2e2e6f302', 'edac35ed-14a6-5a94-9b30-970038b04f14', 'df1fd390-42a7-49bb-9a21-5bbfaf5957ea'), -- operations -> bex.chat.use
  ('8110695d-b8a1-5fad-b916-5d3b205d5052', '621fea6a-4f97-5826-b36b-cc6c72d26602', 'df1fd390-42a7-49bb-9a21-5bbfaf5957ea') -- operations -> navigation.sidebar.bex
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- app_user: all 130 rows of CRM_APP."USER" (DEV), keyed on the same USER_IDs
-- that user_group_permission.user_id uses.
--
-- Column mapping (CRM_APP."USER" has 17 columns; app_user has 19):
--   user_id/user_name/first_name/last_name/title/user_security_role/department/
--   betco_company_id/division/is_active/edit_all/has_user_switcher  <- same-named source
--   created_at <- CREATED_DATE, updated_at <- LAST_MODIFIED_DATE
--   email      <- EMAIL, with ''/whitespace normalised to NULL. Required: the
--                 app_user_email_lower_key unique index permits many NULLs but
--                 rejects a second ''. 7 DEV users have no email; the other
--                 123 are already distinct under lower(email) (pre-checked
--                 against Snowflake: 130 rows / 123 distinct lower(email) / 0
--                 duplicate groups), so the index stays UNIQUE — no fallback to a
--                 non-unique index was needed.
--   edit_all   <- EDIT_ALL, NULL coalesced to false (107 of 130 rows are NULL in
--                 Snowflake; the bex column is not null default false).
--   name       <- composed as FIRST_NAME || ' ' || LAST_NAME. CRM_APP."USER" has
--                 no NAME column, so this is derived, not transcribed.
--   phone      <- NO SOURCE COLUMN. Left NULL rather than guessed.
--   is_salesperson <- NO SOURCE COLUMN. Left at the table default (false); do not
--                 read it as authoritative until a source is identified.
--   deleted_at <- NO SOURCE COLUMN (c360 uses IS_ACTIVE, not a soft-delete stamp).
--                 Left NULL; is_active carries the real state (101 active,
--                 29 inactive).
-- Values are transcribed verbatim, including betco_company_id entries that carry
-- trailing spaces in Snowflake — this is a 1:1 port, not a cleanup.
-- Not mapped: CREATED_BY_USER_ID, LAST_MODIFIED_BY_USER_ID (no bex columns).
-- ---------------------------------------------------------------------------
insert into public.app_user
  (user_id, user_name, first_name, last_name, name, email, title,
   user_security_role, department, division, betco_company_id, is_active,
   edit_all, has_user_switcher, created_at, updated_at)
values
  ('00531000006PwRcAAK', 'EZ House Account', 'EZ', 'House Account', 'EZ House Account', 'noreply@envirozyme.com', null, null, null, 'EnviroZyme - Wet', '16', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('00531000006kMErAAM', 'Chris Lawless', 'Chris', 'Lawless', 'Chris Lawless', 'clawless@betco.com', 'Remote Deployment Specialist', 'VIEW_ALL', null, null, '01', true, true, true, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('00531000006kMEwAAM', 'Barry Rosenthal', 'Barry', 'Rosenthal', 'Barry Rosenthal', 'brosenthal1@betco.com', 'Technical Service Manager', 'VIEW_ALL', null, null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('00531000006kMExAAM', 'Pete Samuelson', 'Pete', 'Samuelson', 'Pete Samuelson', 'prsamuel@betco.com', 'Equipment Tech Support Rep', 'VIEW_ALL', null, null, '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('00531000006kMFMAA2', 'Amy Huebner', 'Amy', 'Huebner', 'Amy Huebner', 'ahuebner@betco.com', 'Credit Manager', 'VIEW_ALL', null, null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('00531000006kMFPAA2', 'Megan Siebert', 'Megan', 'Siebert', 'Megan Siebert', 'msiebert@betco.com', 'Project Manager', 'VIEW_ALL', null, null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('00531000006kMFWAA2', 'Mac Pilkington', 'Mac', 'Pilkington', 'Mac Pilkington', 'mpilkington@betco.com', null, 'VIEW_ALL', null, null, '01', true, true, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('00531000006kMFdAAM', 'Jeff Iverson', 'Jeff', 'Iverson', 'Jeff Iverson', 'jiverson@betco.com', 'VP Sales Operations', 'VIEW_ALL', null, null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('00531000006kMFxAAM', 'Barrett Betz', 'Barrett', 'Betz', 'Barrett Betz', 'barrettbetz@betco.com', 'VP Marketing', 'VIEW_ALL', null, null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('00531000007JFWJAA4', 'Jim Owen', 'Jim', 'Owen', 'Jim Owen', 'jowen@basiccoatings.com', 'Business Development & Brand Strategist', 'VIEW_ALL', 'Marketing', null, '12', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-12-17 00:00:00.000 -0800'::timestamptz),
  ('00531000008TbYNAA0', 'John Ross', 'John', 'Ross', 'John Ross', 'jross@envirozyme.com', 'VP Sales', null, null, 'EnviroZyme - Ferm', '16', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0055A000008oF4GQAU', 'Elaine Hill', 'Elaine', 'Hill', 'Elaine Hill', 'ehill@betco.com', 'Commercial Process Manager', 'VIEW_ALL', 'Commercial Sales', null, '01', true, true, true, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0055A000008pbpVQAQ', 'Mike Betz', 'Mike', 'Betz', 'Mike Betz', 'mbetz@betco.com', 'Senior Director Field Sales and Training, Division – Field', null, null, 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2026-06-19 12:29:34.555 -0700'::timestamptz),
  ('0055A000008pbqdQAA', 'Jeff Bradish', 'Jeff', 'Bradish', 'Jeff Bradish', 'jbradish@betco.com', 'Sales Support Manager', 'VIEW_ALL', null, 'House', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0055A000008psSdQAI', 'Michael Coates', 'Michael', 'Coates', 'Michael Coates', 'mcoates@basiccoatings.com', 'Regional Manager', null, 'Sales', 'Basic', '12', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0055A000009WBWxQAO', 'Jeff Sloan', 'Jeff', 'Sloan', 'Jeff Sloan', 'jsloan@betco.com', 'EVP, Sales', 'VIEW_ALL', 'Sales', 'National', '01', true, false, true, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0055A000009wBhuQAE', 'Tim Young', 'Tim', 'Young', 'Tim Young', 'tyoung@basiccoatings.com', null, 'VIEW_ALL', 'Sales', 'Basic', '12', false, true, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0055A00000AUeEEQA1', 'Rick Manspeaker', 'Rick', 'Manspeaker', 'Rick Manspeaker', 'rmanspeaker@betco.com', 'Regional Manager', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0055A00000AfVHrQAN', 'Toby Jercovich', 'Toby', 'Jercovich', 'Toby Jercovich', 'tjercovich@betco.com', 'CFO', 'VIEW_ALL', 'Accounting', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0055A00000AovvtQAB', 'David DeBlanc', 'David', 'DeBlanc', 'David DeBlanc', 'ddeblanc@betco.com', 'Sales Vice President, Corporate Accounts', null, 'Sales', 'Corporate', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-12-17 00:00:00.000 -0800'::timestamptz),
  ('0055A00000BBKIiQAP', 'Jonathan Petro', 'Jonathan', 'Petro', 'Jonathan Petro', 'jpetro@envirozyme.com', 'National Account Manager', null, 'Sales', 'EnviroZyme - Ferm', '16', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0055A00000BC8LdQAL', 'Brian Schuster', 'Brian', 'Schuster', 'Brian Schuster', 'bschuster@betco.com', 'Director of Sales', 'VIEW_ALL', 'Sales', null, '01', true, false, true, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0055A00000BCeMuQAL', 'Angela Katafiasz', 'Angela', 'Katafiasz', 'Angela Katafiasz', 'akatafiasz@betco.com', 'CS Rep', 'VIEW_ALL', 'Customer Service', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0055A00000BDMeTQAX', 'Steven Ramirez', 'Steven', 'Ramirez', 'Steven Ramirez', 'sramirez@betco.com', 'Business Development Specialist', 'VIEW_ALL', 'BD Team', null, '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0055A00000BEiDpQAL', 'Greg Filice', 'Greg', 'Filice', 'Greg Filice', 'gfilice@basiccoatings.com', 'MFG Rep', null, 'Sales', 'Basic', '12', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2026-01-29 00:00:00.000 -0800'::timestamptz),
  ('0055A00000BEzUFQA1', 'Mike Cavanagh', 'Mike', 'Cavanagh', 'Mike Cavanagh', 'mcavanagh@betco.com', 'Finance Manager, Commercial', 'VIEW_ALL', 'Accounting', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0055A00000BbXN3QAN', 'Jeffrey Koepke', 'Jeffrey', 'Koepke', 'Jeffrey Koepke', 'jkoepke@betco.com', 'Regional Manager', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0055A00000BbnI9QAJ', 'Joe Slone', 'Joe', 'Slone', 'Joe Slone', 'jslone@envirozyme.com', 'VP of Water & Environmental Technologies', null, 'Sales', 'EnviroZyme - Wet', '16', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0055A00000CThkiQAD', 'Jasmine Feldkamp', 'Jasmine', 'Feldkamp', 'Jasmine Feldkamp', 'jfeldkamp@betco.com', null, 'VIEW_ALL', null, null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0056e00000Ce7vXAAR', 'Stephen Swift', 'Stephen', 'Swift', 'Stephen Swift', 'sswift@betco.com', 'Regional Sales Director', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000Ce8MOAAZ', 'Evolène de Gentil', 'Evolène', 'de Gentil', 'Evolène de Gentil', 'edegentil@envirozyme.com', 'Commercial Manager – EMEA', null, 'Sales', 'EnviroZyme - Wet', '16', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000CeANOAA3', 'Matt Quay', 'Matt', 'Quay', 'Matt Quay', 'mquay@betco.com', 'RSD', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-12-17 00:00:00.000 -0800'::timestamptz),
  ('0056e00000CeEVHAA3', 'Jeffrey Barth', 'Jeffrey', 'Barth', 'Jeffrey Barth', 'jbarth@betco.com', 'Regional Sales Director', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000CeHYJAA3', 'Candy Raymor', 'Candy', 'Raymor', 'Candy Raymor', 'craymor@betco.com', 'Customer Service Representative', 'VIEW_ALL', 'Customer Service', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0056e00000CeKkXAAV', 'Bill Long', 'Bill', 'Long', 'Bill Long', 'blong@basiccoatings.com', 'Regional Manager', null, 'Sales', 'Basic', '12', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-12-01 00:00:00.000 -0800'::timestamptz),
  ('0056e00000CeX1hAAF', 'Werner Ramirez', 'Werner', 'Ramirez', 'Werner Ramirez', 'wramirez@betco.com', 'Facilities Solution Specialist', null, 'Sales', 'Field', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000CeX1rAAF', 'Jack Collins', 'Jack', 'Collins', 'Jack Collins', 'jcollins@betco.com', 'Regional Sales Director', null, 'Sales', 'Field', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-12-17 00:00:00.000 -0800'::timestamptz),
  ('0056e00000CeX2BAAV', 'Rogelio Alvarez', 'Rogelio', 'Alvarez', 'Rogelio Alvarez', 'ralvarez@betco.com', 'Regional Sales Director', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000CeZwfAAF', 'Michael McWilliam', 'Michael', 'McWilliam', 'Michael McWilliam', 'mmcwilliam@envirozyme.com', 'Director of Sales Asia Pacific', null, 'Sales', 'EnviroZyme - Wet', '16', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000CeZz0AAF', 'Dezarai Thompson', 'Dezarai', 'Thompson', 'Dezarai Thompson', 'dthompson@envirozyme.com', 'Account Manager - NA', null, 'Sales', 'EnviroZyme - Wet', '16', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000CfI9YAAV', 'Luis Urdiales', 'Luis', 'Urdiales', 'Luis Urdiales', 'lurdiales@betco.com', 'Facilities Solution Specialist', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000CoYKnAAN', 'Chandra Amer', 'Chandra', 'Amer', 'Chandra Amer', 'camer@betco.com', 'Customer Service Rep', 'VIEW_ALL', 'Customer Service', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0056e00000CoqDfAAJ', 'Jazzmin Nowicki', 'Jazzmin', 'Nowicki', 'Jazzmin Nowicki', 'jnowicki@betco.com', 'Business Analyst', 'VIEW_ALL', 'IT', null, '01', true, true, true, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0056e00000CqFRFAA3', 'John Guzik', 'John', 'Guzik', 'John Guzik', 'jguzik@betco.com', 'Corporate Account Director', null, 'Sales', 'Corporate', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2026-02-04 00:00:00.000 -0800'::timestamptz),
  ('0056e00000CqTQVAA3', 'Michael Dotson', 'Michael', 'Dotson', 'Michael Dotson', 'mdotson@betco.com', 'Regional Sales Director', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000CqTZ8AAN', 'Jason Walton', 'Jason', 'Walton', 'Jason Walton', 'jwalton@betco.com', 'Sales Director', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2026-06-19 12:30:36.728 -0700'::timestamptz),
  ('0056e00000Cr8n6AAB', 'Josh Enfield', 'Josh', 'Enfield', 'Josh Enfield', 'jenfield@betco.com', 'RSD', null, 'Sales', 'Field', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-12-17 00:00:00.000 -0800'::timestamptz),
  ('0056e00000CrAhAAAV', 'Justin Tiell', 'Justin', 'Tiell', 'Justin Tiell', 'jtiell@betco.com', 'Web Dev', 'VIEW_ALL', 'IT', null, '01', false, false, true, '2025-08-14 06:45:08.791 -0700'::timestamptz, '2025-08-14 06:45:08.791 -0700'::timestamptz),
  ('0056e00000CrNdVAAV', 'Kelsey Hartford', 'Kelsey', 'Hartford', 'Kelsey Hartford', 'khartford@betco.com', 'Customer Service Rep', 'VIEW_ALL', 'Customer Service', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0056e00000CrPqRAAV', 'Tiffany Edens', 'Tiffany', 'Edens', 'Tiffany Edens', 'tedens@betco.com', null, 'VIEW_ALL', null, null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0056e00000CrbaBAAR', 'Rob Howard', 'Rob', 'Howard', 'Rob Howard', 'rhoward@betco.com', 'Director of National Accounts', null, 'Sales', 'National', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000CtWuGAAV', 'Kris Chandler', 'Kris', 'Chandler', 'Kris Chandler', 'kchandler@betco.com', 'Regional Sales Director', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000CtcLWAAZ', 'Troy Tartaglio', 'Troy', 'Tartaglio', 'Troy Tartaglio', 'ttartaglio@betco.com', 'Regional Sales Director', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000CtpxxAAB', 'Tony Cronk', 'Tony', 'Cronk', 'Tony Cronk', 'tcronk@betco.com', 'Senior Vice President of Consumer and Contract Packaging', null, 'Sales', 'Contract Pack', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000CwKhqAAF', 'Dan Petrie', 'Dan', 'Petrie', 'Dan Petrie', 'dpetrie@betco.com', 'CIO', 'VIEW_ALL', 'IT', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('0056e00000DTuffAAD', 'Philip Hobaugh', 'Philip', 'Hobaugh', 'Philip Hobaugh', 'phobaugh@betco.com', 'National Account Manager', null, 'Sales', 'National', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('0056e00000EJ6HpAAL', 'Ana Lombardo', 'Ana', 'Lombardo', 'Ana Lombardo', 'alombardo@betco.com', 'Business Development Manager', 'VIEW_ALL', 'Customer Service', 'House', '01', true, false, true, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2026-05-22 11:49:14.116 -0700'::timestamptz),
  ('0056e00000EJM7GAAX', 'Andrew Ponder', 'Andrew', 'Ponder', 'Andrew Ponder', 'aponder@betco.com', 'Pricing and Contract Analyst', 'VIEW_ALL', 'Accounting', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('005Rn0000002nnpIAA', 'Vera Tsikoliya', 'Vera', 'Tsikoliya', 'Vera Tsikoliya', 'vtsikoliya@envirozyme.com', 'Sales Manager EMEA', null, 'International', 'EnviroZyme - Wet', '16', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-12-17 00:00:00.000 -0800'::timestamptz),
  ('005Rn00000046V3IAI', 'Kellen Lenihan', 'Kellen', 'Lenihan', 'Kellen Lenihan', 'klenihan@betco.com', 'Regional Sales Director', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn0000005uJJIAY', 'Brian Nichols', 'Brian', 'Nichols', 'Brian Nichols', 'bnichols@betco.com', 'Customer Service Rep', 'VIEW_ALL', 'Customer Service', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('005Rn0000005uSzIAI', 'Mollie Ford', 'Mollie', 'Ford', 'Mollie Ford', 'mford@betco.com', 'Customer Service Rep', 'VIEW_ALL', 'Customer Service', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('005Rn000000D8ivIAC', 'Ryan Hinkle', 'Ryan', 'Hinkle', 'Ryan Hinkle', 'rhinkle@betco.com', 'Regional Sales Director', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000000HbG5IAK', 'Chris Rabara', 'Chris', 'Rabara', 'Chris Rabara', 'crabara@betco.com', 'Managerial Accounting Analyst', 'VIEW_ALL', 'Finance', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('005Rn000000Hd6bIAC', 'Alicia Ziskovsky', 'Alicia', 'Ziskovsky', 'Alicia Ziskovsky', 'aziskovsky@betco.com', 'Credit Analyst', null, 'Finance', null, '01', false, false, false, '2025-08-13 08:41:16.082 -0700'::timestamptz, '2025-08-13 08:41:16.082 -0700'::timestamptz),
  ('005Rn000000LfUnIAK', 'Jack Hanus', 'Jack', 'Hanus', 'Jack Hanus', 'jhanus@betco.com', 'Pricing and Contract Analyst', 'VIEW_ALL', 'Accounting', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('005Rn000000eRhXIAU', 'Meghan Burmeister', 'Meghan', 'Burmeister', 'Meghan Burmeister', 'mburmeister@betco.com', 'Data Architect', 'VIEW_ALL', 'IT', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('005Rn000000jw6HIAQ', 'Ryan Thomas', 'Ryan', 'Thomas', 'Ryan Thomas', 'rthomas@betco.com', 'RSD', null, 'Sales', 'Field', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000000y5w5IAA', 'Alex Rivera', 'Alex', 'Rivera', 'Alex Rivera', 'arivera@betco.com', 'RSD', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn0000010j7pIAA', 'Laura Saine', 'Laura', 'Saine', 'Laura Saine', 'lsaine@betco.com', 'Customer Service Rep', 'VIEW_ALL', 'Customer Service', null, '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('005Rn000001a7K9IAI', 'Becky Adair', 'Becky', 'Adair', 'Becky Adair', 'badair@betco.com', 'BDM - Corporate Accounts', 'VIEW_ALL', 'Business Development', 'National', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-12-17 00:00:00.000 -0800'::timestamptz),
  ('005Rn000001sFsjIAE', 'Russ Pjetrovic', 'Russ', 'Pjetrovic', 'Russ Pjetrovic', 'rpjetrovic@betco.com', 'Regional Sales Director', null, 'Sales', 'Field', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn0000025ksHIAQ', 'Blake Stephenson', 'Blake', 'Stephenson', 'Blake Stephenson', 'bstephenson@betco.com', 'FSS', null, 'Sales', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000002cIM9IAM', 'Greg Bryant', 'Greg', 'Bryant', 'Greg Bryant', 'gbryant@envirozyme.com', 'Commercial Manager Americas EZ', null, 'Sales', 'EnviroZyme - Wet', '16', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000003Eps9IAC', 'Mark Grzeskowiak', 'Mark', 'Grzeskowiak', 'Mark Grzeskowiak', 'mgrzeskowiak@betco.com', 'Regional Sales Director - Canada', null, '2060001 - 2060001 Sales Enablement', 'Field', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000003HFwzIAG', 'Bibekananda Mallick', 'Bibekananda', 'Mallick', 'Bibekananda Mallick', 'bmallick@envirozyme.com', 'Sales Manager - India', null, null, 'EnviroZyme - Wet', '16', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000003JPnNIAW', 'Derek Drew', 'Derek', 'Drew', 'Derek Drew', 'ddrew@betco.com', 'RSD - Chicago', null, null, 'Field', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-12-18 00:00:00.000 -0800'::timestamptz),
  ('005Rn000003dO2LIAU', 'Jason Lyle', 'Jason', 'Lyle', 'Jason Lyle', 'jlyle@betco.com', 'Regional Sales Director', 'VIEW_ALL', 'Sales', 'Field', '01', true, true, true, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000003l2vtIAA', 'Dave Pence', 'Dave', 'Pence', 'Dave Pence', 'dpence@betco.com', 'Director of Sales - South', null, 'Sales', 'Field', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn0000046621IAA', 'Mike Comstock', 'Mike', 'Comstock', 'Mike Comstock', 'mcomstock@betco.com', 'Regional Sales Director', null, null, 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000004AnWbIAK', 'Jenifer Maxwell', 'Jenifer', 'Maxwell', 'Jenifer Maxwell', 'jmaxwell@betco.com', 'Sales VP, Corporate Accounts', null, 'Sales', 'Corporate', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000004BhSLIA0', 'Eric Leslie', 'Eric', 'Leslie', 'Eric Leslie', 'eleslie@betco.com', 'Customer Service Rep', 'VIEW_ALL', 'Customer Service', null, '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('005Rn000004K5pFIAS', 'Brian Coleman', 'Brian', 'Coleman', 'Brian Coleman', 'bcoleman@basiccoatings.com', 'Regional Sales Director-South East', null, null, 'Basic', '12', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000004K8OvIAK', 'Michael Tighe', 'Michael', 'Tighe', 'Michael Tighe', 'mtighe@betco.com', 'RSD Boston', null, 'Sales', 'Field', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-12-17 00:00:00.000 -0800'::timestamptz),
  ('005Rn000004d0yjIAA', 'Thomas Hamlin', 'Thomas', 'Hamlin', 'Thomas Hamlin', 'thamlin@betco.com', 'Associate Product Manager', 'VIEW_ALL', 'Marketing', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('005Rn000004eD7WIAU', 'James Johnston', 'James', 'Johnston', 'James Johnston', 'jjohnston@betco.com', 'Regional Sales Director-North Texas', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn0000054rHOIAY', 'Greg Andia', 'Greg', 'Andia', 'Greg Andia', 'gandia@betco.com', 'Regional Sales Director', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn0000054sLVIAY', 'Erick Turcios', 'Erick', 'Turcios', 'Erick Turcios', 'eturcios@betco.com', 'Reginal Sales Director - West Texas', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000005BnybIAC', 'Juan Verardo', 'Juan', 'Verardo', 'Juan Verardo', 'jverardo@envirozyme.com', 'Director of Sales-LATAM', null, 'Sales', 'EnviroZyme - Wet', '16', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000005BoTFIA0', 'Michael Guerrero', 'Michael', 'Guerrero', 'Michael Guerrero', 'mguerrero@betco.com', 'National Account Director-West', null, 'Sales', 'National', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005Rn000005MuVJIA0', 'Zach Townsend', 'Zach', 'Townsend', 'Zach Townsend', 'ztownsend@betco.com', 'Senior Product Manager, Laundry Warewash', 'VIEW_ALL', 'Marketing', null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('005i000000663DdAAI', 'Greg Maxwell', 'Greg', 'Maxwell', 'Greg Maxwell', 'gmaxwell@betco.com', 'RSD', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005i0000006jUAuAAM', 'Mike Jacobs', 'Mike', 'Jacobs', 'Mike Jacobs', 'mjacobs@betco.com', 'Regional Manager', null, 'Sales', 'Field', '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005i0000006jUBJAA2', 'Steve Hanneke', 'Steve', 'Hanneke', 'Steve Hanneke', 'shanneke@betco.com', 'Regional Manager', null, 'Sales', 'Field', '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005i0000006jUFzAAM', 'Greg Gangelhoff', 'Greg', 'Gangelhoff', 'Greg Gangelhoff', 'ggangelhoff@betco.com', 'Senior Regional Manager', null, null, null, '01', false, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:31.050 -0700'::timestamptz),
  ('005i0000006jc2FAAQ', 'Brad Betz', 'Brad', 'Betz', 'Brad Betz', 'bbetz@betco.com', 'President', 'VIEW_ALL', null, null, '01', true, false, false, '2025-08-05 09:11:31.050 -0700'::timestamptz, '2025-08-05 09:11:35.389 -0700'::timestamptz),
  ('020a44a8-2780-416a-86d0-e66376ddc5ef', 'BDR - Corporate Accounts', 'BDR', 'Corporate Accounts', 'BDR Corporate Accounts', null, null, null, 'Sales', 'Corporate', '01', true, false, false, '2025-08-14 06:45:08.791 -0700'::timestamptz, '2025-08-14 06:45:08.791 -0700'::timestamptz),
  ('041c8552-6c70-4fd0-8758-2a939fe33326', 'Basic Corp', 'Basic', 'Corp', 'Basic Corp', null, null, null, 'Sales', 'Basic', '12', true, false, false, '2025-08-14 06:45:08.791 -0700'::timestamptz, '2025-08-14 06:45:08.791 -0700'::timestamptz),
  ('0fe53e54-8395-407b-bfb9-941af0f55691', 'House - JR', 'House', 'JR', 'House JR', null, null, null, null, 'EnviroZyme - Ferm', '16', true, false, false, '2025-08-19 08:59:41.814 -0700'::timestamptz, '2025-08-19 08:59:41.814 -0700'::timestamptz),
  ('120dff2e-bcea-4fd7-9d3a-983350493038', 'House Account - JS', 'House Account', 'JS', 'House Account JS', null, null, null, null, 'EnviroZyme - Wet', '16', true, false, false, '2025-08-19 08:59:41.814 -0700'::timestamptz, '2025-08-19 08:59:41.814 -0700'::timestamptz),
  ('13bd6f4f-7947-438b-9583-5cee6c93a64e', 'Matt Livingston                                             ', 'Matt', 'Livingston', 'Matt Livingston', 'MLIVINGSTON@ENVIROZYME.COM', null, null, null, null, '16        ', true, false, false, '2025-12-29 00:00:00.000 -0800'::timestamptz, '2025-12-29 00:00:00.000 -0800'::timestamptz),
  ('22927080-b483-4343-917a-f6b4d1886dd4', 'Brian Pupkiewicz', 'Brian', 'Pupkiewicz', 'Brian Pupkiewicz', 'bpupkiewicz@betco.com', null, null, 'Sales', 'Field', '01', true, false, false, '2025-08-14 06:45:08.791 -0700'::timestamptz, '2025-08-14 06:45:08.791 -0700'::timestamptz),
  ('25413b59-260b-47cd-b9e6-83ecaebe573e', 'John DiNapoli', 'John', 'DiNapoli', 'John DiNapoli', 'jdinapoli@betco.com', 'Regional Sales Director - Northeast', null, 'Sales', 'Field', '01', true, false, false, '2026-03-18 07:28:20.985 -0700'::timestamptz, '2026-03-18 07:28:20.985 -0700'::timestamptz),
  ('281a09df-efb1-4947-945c-591786573991', 'Clarissa Breece', 'Clarissa', 'Breece', 'Clarissa Breece', 'cbreece@betco.com', 'Customer Service Rep', 'VIEW_ALL', 'Customer Service', null, '1', true, false, false, '2026-04-30 05:57:39.142 -0700'::timestamptz, '2026-04-30 05:57:39.142 -0700'::timestamptz),
  ('293bf99a-8779-485c-8a82-93fc1f7d7e75', 'Chris Alex                                                  ', 'Chris', 'Alex', 'Chris Alex', 'CALEX@BETCO.COM', null, null, null, null, '01        ', true, false, false, '2026-08-06 00:00:00.000 -0700'::timestamptz, '2026-08-06 00:00:00.000 -0700'::timestamptz),
  ('3adfa866-e408-4de1-8b2d-430d59e18dfd', 'Bill Long', 'Bill', 'Long', 'Bill Long', 'blong@betco.com', 'Regional Manager', 'VIEW_ALL', 'Sales', 'Field', '01', true, false, false, '2025-11-03 00:00:00.000 -0800'::timestamptz, '2025-11-03 00:00:00.000 -0800'::timestamptz),
  ('5f997d5e-94f1-4807-bab5-1f3f7bb603a0', 'Jasmine Wiley', 'Jasmine', 'Wiley', 'Jasmine Wiley', 'jwiley@betco.com', 'Customer Service Rep', 'VIEW_ALL', 'Customer Service', null, '01', true, false, false, '2026-04-30 05:58:47.538 -0700'::timestamptz, '2026-05-06 08:34:55.134 -0700'::timestamptz),
  ('65447f3c-c95e-446d-9548-47fc7aa9b698', 'Adam Malloy                                                 ', 'Adam', 'Malloy', 'Adam Malloy', 'admalloy@betco.com', 'Senior Business Development Manager, Corporate and National Accounts • Business Development', 'VIEW_ALL', 'Business Development', 'House', '01        ', true, false, false, '2026-01-19 00:00:00.000 -0800'::timestamptz, '2026-01-19 00:00:00.000 -0800'::timestamptz),
  ('67a01e8a-9464-4929-9e35-0c8a839d1973', 'Taylor Thomas', 'Taylor', 'Thomas', 'Taylor Thomas', 'tthomas@betco.com', 'Sr. Director, Brand and Digital Marketing', 'VIEW_ALL', 'Marketing', null, '01', false, true, false, '2025-09-18 00:00:00.000 -0700'::timestamptz, '2025-09-18 00:00:00.000 -0700'::timestamptz),
  ('6b312261-0616-404a-a8f3-3f2c72b37044', 'Rob Johnson                                                 ', 'Rob', 'Johnson', 'Rob Johnson', 'RJOHNSON@BETCO.COM', null, null, null, null, '01        ', true, false, false, '2026-08-04 00:00:00.000 -0700'::timestamptz, '2026-08-04 00:00:00.000 -0700'::timestamptz),
  ('6cbd420c-2d50-48ac-8a66-17fa0381db84', 'Flooring Strategies, Inc                                    ', 'Flooring', 'Strategies,', 'Flooring Strategies,', 'JCOATES@BASICCOATINGS.COM', null, null, null, null, '01        ', true, false, false, '2026-05-04 00:00:00.000 -0700'::timestamptz, '2026-05-04 00:00:00.000 -0700'::timestamptz),
  ('7ffc4020-7aa6-460a-bea4-a55cace46b65', 'RSD Midwest - Basic', 'RSD Midwest', 'Basic', 'RSD Midwest Basic', null, null, null, 'Sales', 'Basic', '12', true, false, false, '2025-08-14 06:45:08.791 -0700'::timestamptz, '2025-08-14 06:45:08.791 -0700'::timestamptz),
  ('8576aeb2-e59a-4be2-adba-e475ee0a579c', 'Tiffany Little', 'Tiffany', 'Little', 'Tiffany Little', 'tlittle@betco.com', 'Lead Credit Analyst', null, 'Accounting', null, '01', true, false, false, '2025-02-04 00:00:00.000 -0800'::timestamptz, '2025-02-04 00:00:00.000 -0800'::timestamptz),
  ('875230f7-b705-4f8e-84ec-b0ca2b9f2b89', 'Rick Byington', 'Rick', 'Byington', 'Rick Byington', 'rbyington@betco.com', 'Senior Digital Engineering Lead', 'VIEW_ALL', 'IT', null, '1', true, false, true, '2026-06-03 11:37:58.158 -0700'::timestamptz, '2026-06-03 11:37:58.158 -0700'::timestamptz),
  ('90c50498-e502-41ae-b8ef-82c52be5346e', 'Kevin Doddy', 'Kevin', 'Doddy', 'Kevin Doddy', 'kdoddy@betco.com', 'C360 Consultant', 'VIEW_ALL', 'IT', null, '1', true, true, true, '2026-05-11 06:36:38.093 -0700'::timestamptz, '2026-05-11 06:36:38.093 -0700'::timestamptz),
  ('98e3db4c-ddf8-4868-af92-7d05e02b78b1', 'Inactive User', 'Inactive', 'User', 'Inactive User', null, 'Inactive User', null, 'Inactive User', null, '01', false, false, false, '2025-08-14 06:45:08.791 -0700'::timestamptz, '2025-08-14 06:45:08.791 -0700'::timestamptz),
  ('99817c72-e129-46f7-a485-db9d49e75bfb', 'Rhiannon True', 'Rhiannon', 'True', 'Rhiannon True', 'rtrue@betco.com', 'Customer Service Representative', 'VIEW_ALL', 'Customer Service', null, '1', true, false, false, '2026-06-08 05:38:36.481 -0700'::timestamptz, '2026-06-08 05:38:36.481 -0700'::timestamptz),
  ('aaaf2fc2-6023-4ce8-9f25-55814df67ed5', 'Patricia Moscarello', 'Patricia', 'Moscarello', 'Patricia Moscarello', 'pmoscarello@betco.com', 'Customer Service Rep', 'VIEW_ALL', 'Customer Service', null, '1', true, false, false, '2026-04-30 05:52:37.246 -0700'::timestamptz, '2026-04-30 05:52:37.246 -0700'::timestamptz),
  ('b80154db-8221-479a-8cf3-ffecea8a8675', 'Tim Young', 'Tim', 'Young', 'Tim Young', 'tyoung@betco.com', 'Sales Operations', 'VIEW_ALL', null, null, '01', true, false, false, '2025-02-04 00:00:00.000 -0800'::timestamptz, '2025-02-04 00:00:00.000 -0800'::timestamptz),
  ('ba7d95b6-6c40-4c26-833b-e862f2d9d1db', 'Rebecca Jones', 'Rebecca', 'Jones', 'Rebecca Jones', 'rjones@betco.com', 'Customer Service Representative', 'VIEW_ALL', 'Customer Service', null, null, true, false, false, '2026-04-02 13:48:34.559 -0700'::timestamptz, '2026-04-02 13:48:34.559 -0700'::timestamptz),
  ('bfcf624a-c9bd-45ba-810d-f3a9c1bb4559', 'Guillermo Galarza', 'Guillermo', 'Galarza', 'Guillermo Galarza', 'ggalarza@betco.com', 'Vice President of Strategic Accounts', null, 'Sales', 'Corporate', '01', true, false, false, '2026-04-24 11:10:48.463 -0700'::timestamptz, '2026-04-24 11:10:48.463 -0700'::timestamptz),
  ('c00bee7b-4197-4330-adbd-407c7b3c6340', 'Basic House Account', 'Basic', 'House Account', 'Basic House Account', null, null, null, 'Sales', 'Basic', '12', true, false, false, '2025-08-14 06:45:08.791 -0700'::timestamptz, '2025-08-14 06:45:08.791 -0700'::timestamptz),
  ('c388ad99-6867-48bf-a718-c0257f682786', 'Neil Yetman                                                 ', 'Neil', 'Yetman', 'Neil Yetman', 'NYETMAN@BETCO.COM', null, null, null, 'Other', '01        ', true, false, false, '2026-07-29 00:00:00.000 -0700'::timestamptz, '2026-07-29 00:00:00.000 -0700'::timestamptz),
  ('c51e2b1f-6f35-49d7-acd6-af352a355746', 'Katie Pickett', 'Katie', 'Pickett', 'Katie Pickett', 'kpickett@betco.com', 'Manager Sales Optimization', 'VIEW_ALL', 'Business Development', null, '01', true, true, true, '2025-11-11 00:00:00.000 -0800'::timestamptz, '2025-11-11 00:00:00.000 -0800'::timestamptz),
  ('ce3f78fa-ca77-4729-bf22-63d5e63b5ff2', 'Kenneth Evenson', 'Kenneth', 'Evenson', 'Kenneth Evenson', 'kevenson@betco.com', 'Regional Sales Director-TN', null, 'Sales', 'Field', '01', true, false, false, '2026-05-29 10:16:18.710 -0700'::timestamptz, '2026-05-29 10:16:18.710 -0700'::timestamptz),
  ('d69d7160-c434-452a-809b-e75008a211f2', 'Tom Bird', 'Tom', 'Bird', 'Tom Bird', 'tbird@betco.com', null, 'VIEW_ALL', null, null, '01', true, true, true, '2025-01-28 00:00:00.000 -0800'::timestamptz, '2026-07-07 13:22:11.484 -0700'::timestamptz),
  ('de1afa66-600b-4892-ae46-93845c214f24', 'Gene Tullis', 'Gene', 'Tullis', 'Gene Tullis', 'gtullis@betco.com', 'Senior Director, Corporate Accounts', null, 'Sales', 'Corporate', '01', false, false, false, '2025-10-16 00:00:00.000 -0700'::timestamptz, '2025-10-16 00:00:00.000 -0700'::timestamptz),
  ('e8167593-c8ba-4491-84a7-0582700767aa', 'Kathy Snyder', 'Kathy', 'Snyder', 'Kathy Snyder', 'ksnyder@betco.com', 'Customer Service Representative', 'VIEW_ALL', 'Customer Service', null, '01', true, false, false, '2026-05-11 13:57:01.322 -0700'::timestamptz, '2026-05-11 13:57:01.322 -0700'::timestamptz),
  ('eb7df408-8f3d-4b63-928d-29a63e9ac5fc', 'Zuzanna Kramarz                                             ', 'Zuzanna', 'Kramarz', 'Zuzanna Kramarz', 'ZKRAMARZ@BETCO.COM', null, null, null, null, '01        ', true, false, false, '2026-08-04 00:00:00.000 -0700'::timestamptz, '2026-08-04 00:00:00.000 -0700'::timestamptz),
  ('f254a0ae-4a13-4ff7-a220-9a5a9dc96be3', 'Christiaan de Witt', 'Christiaan', 'de Witt', 'Christiaan de Witt', 'cdewitt@betco.com', 'Regional Sales Director-Northern CA', null, 'Sales', 'Field', '01', true, false, false, '2026-05-29 10:14:21.689 -0700'::timestamptz, '2026-05-29 10:14:21.689 -0700'::timestamptz)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- user_group_permission: group membership, transcribed from the c360 export
-- (ids and timestamps preserved so this stays diffable against c360).
--
-- 94 source rows -> 85 seeded here, then + 6 synthetic '*' rows below.
-- Two kinds of source row are dropped:
--   * 7 rows assigning users to 'sales-lead-pilot', which is not seeded
--     (see the permission_group block above).
--   * 2 rows with entity_type = 'PERMISSION' pointing at c360 permission ids
--     (c55fffa9-7bd6-40b7-86a5-d1801afa32ab, bb9d031a-6aef-475b-95d7-8000d32c037b) —
--     i.e. leads.view.rep and settings.calendar_sync. Neither selector exists in
--     the bex catalog, and entity_id has no FK, so seeding them would create rows
--     that resolve to nothing in get_user_permission_bundle.
-- ---------------------------------------------------------------------------
insert into public.user_group_permission
  (user_group_permission_id, user_id, entity_type, entity_id, created_at, updated_at, deleted_at)
values
  ('a8cb69e0-4050-442d-9ad5-e6f5857c3a9f', '00531000006PwRcAAK', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:54.137 +0000'::timestamptz, '2026-07-03 16:16:54.137 +0000'::timestamptz, null),
  ('1d6931a8-6c02-462d-a956-967c479dfefe', '00531000006kMErAAM', 'PERMISSION_GROUP', '4ccf2523-ec6a-45fe-b58f-ef9c9114856b', '2026-07-06 19:41:18.938 +0000'::timestamptz, '2026-07-06 19:41:18.938 +0000'::timestamptz, null),
  ('1a351113-8696-4997-90fd-a1bf72ef8e40', '00531000006kMEwAAM', 'PERMISSION_GROUP', '3c491112-7476-4918-8e38-304400a49f8b', '2026-03-25 17:43:39.568 +0000'::timestamptz, '2026-03-25 17:43:39.568 +0000'::timestamptz, null),
  ('53e70135-ec71-4bb8-bbe8-f9506655bc7a', '00531000006kMExAAM', 'PERMISSION_GROUP', '3c491112-7476-4918-8e38-304400a49f8b', '2026-03-25 17:43:42.645 +0000'::timestamptz, '2026-03-25 17:43:42.645 +0000'::timestamptz, null),
  ('f6d86a84-8035-4360-bac9-0f91c58da3bf', '00531000006kMFMAA2', 'PERMISSION_GROUP', '128d3ee4-687e-4669-b8d4-198b4e50a8be', '2026-03-25 17:53:30.115 +0000'::timestamptz, '2026-03-25 17:53:30.115 +0000'::timestamptz, null),
  ('ebb81e65-bb5a-4e82-859a-76b4fc9bd4d6', '00531000006kMFPAA2', 'PERMISSION_GROUP', '3c491112-7476-4918-8e38-304400a49f8b', '2026-03-25 17:43:41.914 +0000'::timestamptz, '2026-03-25 17:43:41.914 +0000'::timestamptz, null),
  ('2d91060f-18f6-43c5-af10-7eafb5d6e2b6', '00531000006kMFdAAM', 'PERMISSION_GROUP', '3c491112-7476-4918-8e38-304400a49f8b', '2026-03-25 17:43:40.805 +0000'::timestamptz, '2026-03-25 17:43:40.805 +0000'::timestamptz, null),
  ('43e39226-16a6-4b95-92aa-e287b78ab3c1', '00531000006kMFxAAM', 'PERMISSION_GROUP', '8678a33f-3669-4e39-96e3-59a7761b9340', '2026-06-22 00:45:40.725 +0000'::timestamptz, '2026-06-22 00:45:40.725 +0000'::timestamptz, null),
  ('bdf7e7d8-7b5d-4750-a438-45d354ea83a4', '00531000008TbYNAA0', 'PERMISSION_GROUP', '8678a33f-3669-4e39-96e3-59a7761b9340', '2026-06-22 00:45:43.646 +0000'::timestamptz, '2026-06-22 00:45:43.646 +0000'::timestamptz, null),
  ('1bd92702-ac91-4fb0-81bc-035b722bc199', '0055A000008oF4GQAU', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:54.550 +0000'::timestamptz, '2026-07-03 16:16:54.550 +0000'::timestamptz, null),
  ('492b4652-c81a-4ab0-a426-d662dc303360', '0055A000008pbpVQAQ', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:10.165 +0000'::timestamptz, '2026-07-03 16:17:10.165 +0000'::timestamptz, null),
  ('986b9199-3c6f-4a5f-a096-478f1d2e6534', '0055A000008pbqdQAA', 'PERMISSION_GROUP', 'af7b1197-8126-4dc8-9a8a-1b77349f78f7', '2026-03-25 17:48:00.205 +0000'::timestamptz, '2026-03-25 17:48:00.205 +0000'::timestamptz, null),
  ('75ab2897-9360-4ec2-9d9f-e1bf2a81e815', '0055A000008psSdQAI', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:08.371 +0000'::timestamptz, '2026-07-03 16:17:08.371 +0000'::timestamptz, null),
  ('451931b8-51ae-4e5a-b6d7-e31649c00eb2', '0055A000009WBWxQAO', 'PERMISSION_GROUP', '8678a33f-3669-4e39-96e3-59a7761b9340', '2026-06-22 00:45:42.631 +0000'::timestamptz, '2026-06-22 00:45:42.631 +0000'::timestamptz, null),
  ('a5238d86-2e35-4af5-9ad4-910dbc9f4743', '0055A00000AUeEEQA1', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:11.743 +0000'::timestamptz, '2026-07-03 16:17:11.743 +0000'::timestamptz, null),
  ('e7ef205f-4a2e-4df7-b1b2-bb5c8f855e71', '0055A00000AfVHrQAN', 'PERMISSION_GROUP', '8678a33f-3669-4e39-96e3-59a7761b9340', '2026-06-22 00:45:44.189 +0000'::timestamptz, '2026-06-22 00:45:44.189 +0000'::timestamptz, null),
  ('b4d45b07-d367-4aad-8ec9-ba6a1a9421fe', '0055A00000BBKIiQAP', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:03.829 +0000'::timestamptz, '2026-07-03 16:17:03.829 +0000'::timestamptz, null),
  ('d24962ba-d3e4-486a-b874-627831b05207', '0055A00000BC8LdQAL', 'PERMISSION_GROUP', '8678a33f-3669-4e39-96e3-59a7761b9340', '2026-06-22 00:45:41.740 +0000'::timestamptz, '2026-06-22 00:45:41.740 +0000'::timestamptz, null),
  ('00fb2ac5-22c7-413b-98c8-c06fb172de95', '0055A00000BCeMuQAL', 'PERMISSION_GROUP', 'af7b1197-8126-4dc8-9a8a-1b77349f78f7', '2026-03-25 17:47:58.387 +0000'::timestamptz, '2026-03-25 17:47:58.387 +0000'::timestamptz, null),
  ('521906e2-d7fd-4d80-ae02-b550f9dce5e5', '0055A00000BEzUFQA1', 'PERMISSION_GROUP', '128d3ee4-687e-4669-b8d4-198b4e50a8be', '2026-03-25 17:53:33.397 +0000'::timestamptz, '2026-03-25 17:53:33.397 +0000'::timestamptz, null),
  ('dd852289-766d-4bcb-8aba-1db65581ca36', '0055A00000BbXN3QAN', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:02.332 +0000'::timestamptz, '2026-07-03 16:17:02.332 +0000'::timestamptz, null),
  ('a9725147-fece-40c2-9d53-334fe937cc66', '0055A00000BbnI9QAJ', 'PERMISSION_GROUP', '8678a33f-3669-4e39-96e3-59a7761b9340', '2026-06-22 00:45:43.192 +0000'::timestamptz, '2026-06-22 00:45:43.192 +0000'::timestamptz, null),
  ('e4c8568b-a9d1-41db-9b61-54a5f0202dc6', '0055A00000CThkiQAD', 'PERMISSION_GROUP', '128d3ee4-687e-4669-b8d4-198b4e50a8be', '2026-03-25 17:53:32.948 +0000'::timestamptz, '2026-03-25 17:53:32.948 +0000'::timestamptz, null),
  ('813e89ef-c222-47c3-baa7-3fb71e17650f', '0056e00000Ce7vXAAR', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:13.955 +0000'::timestamptz, '2026-07-03 16:17:13.955 +0000'::timestamptz, null),
  ('445ca87a-cdf9-470b-9faf-563598ff21eb', '0056e00000Ce8MOAAZ', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:55.463 +0000'::timestamptz, '2026-07-03 16:16:55.463 +0000'::timestamptz, null),
  ('10d9fd46-b2b6-4aed-89a4-ee5b3a6c33e7', '0056e00000CeEVHAA3', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:01.803 +0000'::timestamptz, '2026-07-03 16:17:01.803 +0000'::timestamptz, null),
  ('4bace53b-25e4-47f9-bd22-680351f712cd', '0056e00000CeHYJAA3', 'PERMISSION_GROUP', '128d3ee4-687e-4669-b8d4-198b4e50a8be', '2026-03-25 17:53:31.467 +0000'::timestamptz, '2026-03-25 17:53:31.467 +0000'::timestamptz, null),
  ('14f500e3-228c-43f6-b495-bace9d54e436', '0056e00000CeX2BAAV', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:12.948 +0000'::timestamptz, '2026-07-03 16:17:12.948 +0000'::timestamptz, null),
  ('673b1c9d-5be5-4382-961e-5509f27065e8', '0056e00000CeZwfAAF', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:09.421 +0000'::timestamptz, '2026-07-03 16:17:09.421 +0000'::timestamptz, null),
  ('0f842378-044f-4a82-9490-7389738b020c', '0056e00000CeZz0AAF', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:53.583 +0000'::timestamptz, '2026-07-03 16:16:53.583 +0000'::timestamptz, null),
  ('dcb4b239-f915-4967-8580-ac2a2d0c6f67', '0056e00000CfI9YAAV', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:07.374 +0000'::timestamptz, '2026-07-03 16:17:07.374 +0000'::timestamptz, null),
  ('f6cd7bde-4d8e-45ee-a3f7-98e0d3a9759a', '0056e00000CoYKnAAN', 'PERMISSION_GROUP', 'af7b1197-8126-4dc8-9a8a-1b77349f78f7', '2026-03-25 17:47:59.354 +0000'::timestamptz, '2026-03-25 17:47:59.354 +0000'::timestamptz, null),
  ('c7fb5c88-0abc-4bc9-89c2-083a8a0fcb43', '0056e00000CoqDfAAJ', 'PERMISSION_GROUP', '4ccf2523-ec6a-45fe-b58f-ef9c9114856b', '2026-07-06 19:41:20.376 +0000'::timestamptz, '2026-07-06 19:41:20.376 +0000'::timestamptz, null),
  ('05cf54e2-fb72-4f90-b047-892cc93a9c98', '0056e00000CqFRFAA3', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:03.379 +0000'::timestamptz, '2026-07-03 16:17:03.379 +0000'::timestamptz, null),
  ('80a8ffb8-8c29-41f9-b0b1-561d0daa2640', '0056e00000CqTQVAA3', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:08.893 +0000'::timestamptz, '2026-07-03 16:17:08.893 +0000'::timestamptz, null),
  ('a4b72b56-ee59-498d-800e-2d4fb269c169', '0056e00000CqTZ8AAN', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:01.279 +0000'::timestamptz, '2026-07-03 16:17:01.279 +0000'::timestamptz, null),
  ('dd648af3-e276-44f5-b0b1-442943b9d4f9', '0056e00000CrNdVAAV', 'PERMISSION_GROUP', 'af7b1197-8126-4dc8-9a8a-1b77349f78f7', '2026-03-25 17:48:00.951 +0000'::timestamptz, '2026-03-25 17:48:00.951 +0000'::timestamptz, null),
  ('26b4461e-6e3f-4ec1-8250-564ed61a0059', '0056e00000CrPqRAAV', 'PERMISSION_GROUP', '128d3ee4-687e-4669-b8d4-198b4e50a8be', '2026-03-25 17:53:33.914 +0000'::timestamptz, '2026-03-25 17:53:33.914 +0000'::timestamptz, null),
  ('0a21c684-38dd-47e8-a54f-8fccc5462ef4', '0056e00000CrbaBAAR', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:12.302 +0000'::timestamptz, '2026-07-03 16:17:12.302 +0000'::timestamptz, null),
  ('0e09429f-91d1-464f-b8ad-e30c49ad6642', '0056e00000CtWuGAAV', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:06.773 +0000'::timestamptz, '2026-07-03 16:17:06.773 +0000'::timestamptz, null),
  ('b1a85d55-9c91-47c0-9da1-7d60fc3b2a77', '0056e00000CtcLWAAZ', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:15.807 +0000'::timestamptz, '2026-07-03 16:17:15.807 +0000'::timestamptz, null),
  ('c486ca58-3202-4967-8775-d2d59e75c619', '0056e00000CtpxxAAB', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:15.191 +0000'::timestamptz, '2026-07-03 16:17:15.191 +0000'::timestamptz, null),
  ('e69f2a02-4086-4d96-acc8-66969441b302', '0056e00000CwKhqAAF', 'PERMISSION_GROUP', '4ccf2523-ec6a-45fe-b58f-ef9c9114856b', '2026-07-06 19:41:19.553 +0000'::timestamptz, '2026-07-06 19:41:19.553 +0000'::timestamptz, null),
  ('155ee0cd-d9fb-4bd0-8540-d09ec821b939', '0056e00000CwKhqAAF', 'PERMISSION_GROUP', '8678a33f-3669-4e39-96e3-59a7761b9340', '2026-06-22 00:45:42.212 +0000'::timestamptz, '2026-06-22 00:45:42.212 +0000'::timestamptz, null),
  ('72a89169-476f-451c-91fb-e8fe700448ef', '0056e00000EJ6HpAAL', 'PERMISSION_GROUP', '3c491112-7476-4918-8e38-304400a49f8b', '2026-03-25 17:43:39.073 +0000'::timestamptz, '2026-03-25 17:43:39.073 +0000'::timestamptz, null),
  ('f07c1622-39d2-4761-9fc1-f6cba570c59d', '0056e00000EJM7GAAX', 'PERMISSION_GROUP', '128d3ee4-687e-4669-b8d4-198b4e50a8be', '2026-03-25 17:53:30.857 +0000'::timestamptz, '2026-03-25 17:53:30.857 +0000'::timestamptz, null),
  ('43ff6156-1cb9-47a7-897d-ce036252fc83', '005Rn00000046V3IAI', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:06.126 +0000'::timestamptz, '2026-07-03 16:17:06.126 +0000'::timestamptz, null),
  ('71c9f6e6-2280-4ea8-8038-3e2da32442b2', '005Rn0000005uJJIAY', 'PERMISSION_GROUP', 'af7b1197-8126-4dc8-9a8a-1b77349f78f7', '2026-03-25 17:47:58.905 +0000'::timestamptz, '2026-03-25 17:47:58.905 +0000'::timestamptz, null),
  ('4b46ccbb-bcf5-45c4-abc5-ab2556a7edee', '005Rn0000005uSzIAI', 'PERMISSION_GROUP', 'af7b1197-8126-4dc8-9a8a-1b77349f78f7', '2026-03-25 17:48:02.082 +0000'::timestamptz, '2026-03-25 17:48:02.082 +0000'::timestamptz, null),
  ('c2f0dc78-617f-4cfd-a1df-09669ddf9707', '005Rn000000D8ivIAC', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:13.476 +0000'::timestamptz, '2026-07-03 16:17:13.476 +0000'::timestamptz, null),
  ('93f0f4df-a403-4e2c-a829-e1b21bb81188', '005Rn000000HbG5IAK', 'PERMISSION_GROUP', '128d3ee4-687e-4669-b8d4-198b4e50a8be', '2026-03-25 17:53:31.961 +0000'::timestamptz, '2026-03-25 17:53:31.961 +0000'::timestamptz, null),
  ('83272495-a9a4-42ee-a0a0-400aa33e7100', '005Rn000000LfUnIAK', 'PERMISSION_GROUP', '128d3ee4-687e-4669-b8d4-198b4e50a8be', '2026-03-25 17:53:32.520 +0000'::timestamptz, '2026-03-25 17:53:32.520 +0000'::timestamptz, null),
  ('26744511-09f2-48a9-9bf1-f2defde339a0', '005Rn000000y5w5IAA', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:47.917 +0000'::timestamptz, '2026-07-03 16:16:47.917 +0000'::timestamptz, null),
  ('59fa8ad0-3c9f-489a-84e5-7af05e13add3', '005Rn0000010j7pIAA', 'PERMISSION_GROUP', 'af7b1197-8126-4dc8-9a8a-1b77349f78f7', '2026-03-25 17:48:01.549 +0000'::timestamptz, '2026-03-25 17:48:01.549 +0000'::timestamptz, null),
  ('e9d55708-19d1-4621-8b9d-93abc8204370', '005Rn0000025ksHIAQ', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:51.790 +0000'::timestamptz, '2026-07-03 16:16:51.790 +0000'::timestamptz, null),
  ('cc3adb76-d405-45bf-bcee-5cb5faa30f79', '005Rn000002cIM9IAM', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:57.266 +0000'::timestamptz, '2026-07-03 16:16:57.266 +0000'::timestamptz, null),
  ('53d8e6d6-692e-4c89-8849-b9c7c4342d35', '005Rn000003HFwzIAG', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:50.604 +0000'::timestamptz, '2026-07-03 16:16:50.604 +0000'::timestamptz, null),
  ('0325d18c-639f-47bc-a086-d3f2f505bde7', '005Rn000003dO2LIAU', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:00.415 +0000'::timestamptz, '2026-07-03 16:17:00.415 +0000'::timestamptz, null),
  ('b5d37415-fb4f-43a1-b745-2d11d44f70f2', '005Rn0000046621IAA', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:10.928 +0000'::timestamptz, '2026-07-03 16:17:10.928 +0000'::timestamptz, null),
  ('2a1c058d-7207-4fcc-b7c7-7f80db24d64b', '005Rn000004AnWbIAK', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:02.859 +0000'::timestamptz, '2026-07-03 16:17:02.859 +0000'::timestamptz, null),
  ('59f3d90e-04bd-481d-bc4d-cb3a66df750e', '005Rn000004K5pFIAS', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:52.271 +0000'::timestamptz, '2026-07-03 16:16:52.271 +0000'::timestamptz, null),
  ('5741eb84-3308-4728-8066-55d2cd41485d', '005Rn000004d0yjIAA', 'PERMISSION_GROUP', '3c491112-7476-4918-8e38-304400a49f8b', '2026-03-25 17:43:43.139 +0000'::timestamptz, '2026-03-25 17:43:43.139 +0000'::timestamptz, null),
  ('f397d89b-10cc-4d12-a602-c9133706d1ed', '005Rn000004eD7WIAU', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:59.872 +0000'::timestamptz, '2026-07-03 16:16:59.872 +0000'::timestamptz, null),
  ('e8eefc4f-2d7c-4202-942c-162426fd8099', '005Rn0000054rHOIAY', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:56.007 +0000'::timestamptz, '2026-07-03 16:16:56.007 +0000'::timestamptz, null),
  ('563a582e-3015-4313-8caf-b47734fb39f6', '005Rn0000054sLVIAY', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:55.025 +0000'::timestamptz, '2026-07-03 16:16:55.025 +0000'::timestamptz, null),
  ('54bdd34c-dd38-46b3-8016-a094b54b7e73', '005Rn000005BnybIAC', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:05.214 +0000'::timestamptz, '2026-07-03 16:17:05.214 +0000'::timestamptz, null),
  ('c04d008f-f440-4660-b3da-8a508cfec626', '005Rn000005MuVJIA0', 'PERMISSION_GROUP', '3c491112-7476-4918-8e38-304400a49f8b', '2026-03-25 17:43:43.893 +0000'::timestamptz, '2026-03-25 17:43:43.893 +0000'::timestamptz, null),
  ('b29d05aa-53ae-4cc5-b9f0-a3b16e68931a', '005i000000663DdAAI', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:57.722 +0000'::timestamptz, '2026-07-03 16:16:57.722 +0000'::timestamptz, null),
  ('e61e6ef2-1f1e-43fd-b607-573550876cc6', '005i0000006jUBJAA2', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:14.497 +0000'::timestamptz, '2026-07-03 16:17:14.497 +0000'::timestamptz, null),
  ('34909db1-55e5-417b-a9f5-c807042041af', '005i0000006jc2FAAQ', 'PERMISSION_GROUP', '8678a33f-3669-4e39-96e3-59a7761b9340', '2026-06-22 00:45:41.174 +0000'::timestamptz, '2026-06-22 00:45:41.174 +0000'::timestamptz, null),
  ('d7c075ff-92e1-4823-86a8-e9975007efe4', '020a44a8-2780-416a-86d0-e66376ddc5ef', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:48.482 +0000'::timestamptz, '2026-07-03 16:16:48.482 +0000'::timestamptz, null),
  ('0e646c27-95a5-44f6-bc94-ff8621f7723a', '041c8552-6c70-4fd0-8758-2a939fe33326', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:48.931 +0000'::timestamptz, '2026-07-03 16:16:48.931 +0000'::timestamptz, null),
  ('330be0a5-d502-40b0-b3d2-83acd399de14', '0fe53e54-8395-407b-bfb9-941af0f55691', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:58.776 +0000'::timestamptz, '2026-07-03 16:16:58.776 +0000'::timestamptz, null),
  ('70208b16-1c2b-4137-9ded-1602efef7c78', '120dff2e-bcea-4fd7-9d3a-983350493038', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:59.295 +0000'::timestamptz, '2026-07-03 16:16:59.295 +0000'::timestamptz, null),
  ('f8348003-7089-4596-8609-79c03116763f', '13bd6f4f-7947-438b-9583-5cee6c93a64e', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:07.941 +0000'::timestamptz, '2026-07-03 16:17:07.941 +0000'::timestamptz, null),
  ('961674b7-8514-45eb-9400-e503500833d8', '22927080-b483-4343-917a-f6b4d1886dd4', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:52.816 +0000'::timestamptz, '2026-07-03 16:16:52.816 +0000'::timestamptz, null),
  ('e605bd92-4179-4690-b55a-e56ffe9811bc', '3adfa866-e408-4de1-8b2d-430d59e18dfd', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:51.264 +0000'::timestamptz, '2026-07-03 16:16:51.264 +0000'::timestamptz, null),
  ('58810ba7-9355-4612-929f-99a6d6a05f1a', '65447f3c-c95e-446d-9548-47fc7aa9b698', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:47.511 +0000'::timestamptz, '2026-07-03 16:16:47.511 +0000'::timestamptz, null),
  ('a90c3bf2-fdc3-4759-830b-968201e3f57f', '7ffc4020-7aa6-460a-bea4-a55cace46b65', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:17:11.309 +0000'::timestamptz, '2026-07-03 16:17:11.309 +0000'::timestamptz, null),
  ('87747a3e-c242-4b32-af48-8dc12d52b68b', '875230f7-b705-4f8e-84ec-b0ca2b9f2b89', 'PERMISSION_GROUP', '4ccf2523-ec6a-45fe-b58f-ef9c9114856b', '2026-07-06 19:41:21.738 +0000'::timestamptz, '2026-07-06 19:41:21.738 +0000'::timestamptz, null),
  ('e3243953-447e-482e-88a0-09480647d609', '90c50498-e502-41ae-b8ef-82c52be5346e', 'PERMISSION_GROUP', '4ccf2523-ec6a-45fe-b58f-ef9c9114856b', '2026-07-06 19:41:20.970 +0000'::timestamptz, '2026-07-06 19:41:20.970 +0000'::timestamptz, null),
  ('f40bf88e-cf78-44e4-84da-17d36eec7c8a', 'bfcf624a-c9bd-45ba-810d-f3a9c1bb4559', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:58.307 +0000'::timestamptz, '2026-07-03 16:16:58.307 +0000'::timestamptz, null),
  ('28b6ff5a-d2fc-4c79-9385-6dbc6539e734', 'c00bee7b-4197-4330-adbd-407c7b3c6340', 'PERMISSION_GROUP', '80029966-615b-42af-b3a3-1f530a29156d', '2026-07-03 16:16:49.613 +0000'::timestamptz, '2026-07-03 16:16:49.613 +0000'::timestamptz, null),
  ('b19611a1-c1e4-4bb0-bde8-5cee18095039', 'c51e2b1f-6f35-49d7-acd6-af352a355746', 'PERMISSION_GROUP', '3c491112-7476-4918-8e38-304400a49f8b', '2026-03-25 17:43:41.353 +0000'::timestamptz, '2026-03-25 17:43:41.353 +0000'::timestamptz, null),
  ('0f3e1c86-f951-45fa-aa36-86f066995b43', 'd69d7160-c434-452a-809b-e75008a211f2', 'PERMISSION_GROUP', '4ccf2523-ec6a-45fe-b58f-ef9c9114856b', '2026-07-06 19:41:22.286 +0000'::timestamptz, '2026-07-06 19:41:22.286 +0000'::timestamptz, null)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- it-admin -> '*', as a DIRECT permission assignment (B0-403).
--
-- One row per current member of the it-admin group (4ccf2523-ec6a-45fe-b58f-ef9c9114856b),
-- pointing at the '*' permission seeded above. entity_type = 'PERMISSION' means
-- entity_id is read as a permission_id, so '*' has to exist as a permission row.
--
-- OPERATIONAL NOTE: because this is per-user and not a group_permission row, a
-- user added to it-admin later (e.g. via the B0-411 group UI) does NOT inherit
-- '*' — they need their own direct row. Worth revisiting in B0-411/B0-413.
-- These ids are bex-generated (deterministic, derived from the user id); they do
-- not exist in c360.
-- ---------------------------------------------------------------------------
insert into public.user_group_permission
  (user_group_permission_id, user_id, entity_type, entity_id)
values
  ('d99352ac-d2c0-5b73-ba21-20db72effbc0', '00531000006kMErAAM', 'PERMISSION', 'c6381696-6a8a-570c-957f-9070e1e314d7'),
  ('4be0a504-0484-5850-9a0f-e46c4390bb21', '0056e00000CoqDfAAJ', 'PERMISSION', 'c6381696-6a8a-570c-957f-9070e1e314d7'),
  ('9727a882-e0cd-5c3e-9d38-283adbbda21b', '0056e00000CwKhqAAF', 'PERMISSION', 'c6381696-6a8a-570c-957f-9070e1e314d7'),
  ('d1aa5999-af03-5e49-8dd8-a4f2d1c3dad3', '875230f7-b705-4f8e-84ec-b0ca2b9f2b89', 'PERMISSION', 'c6381696-6a8a-570c-957f-9070e1e314d7'),
  ('e48c1add-7886-5673-b95d-f80e2bbca8e7', '90c50498-e502-41ae-b8ef-82c52be5346e', 'PERMISSION', 'c6381696-6a8a-570c-957f-9070e1e314d7'),
  ('31058cd0-e0f8-540f-9470-582e8a7c37da', 'd69d7160-c434-452a-809b-e75008a211f2', 'PERMISSION', 'c6381696-6a8a-570c-957f-9070e1e314d7')
on conflict do nothing;
