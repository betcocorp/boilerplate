-- =============================================================================
-- B0-413: restore the bex.chat.use permission row and its it-admin grant.
--
-- WHY
--   `bex.chat.use` is in the code catalog (PERMISSIONS.BEX_CHAT_USE,
--   src/lib/permissions/constants.ts) and is the selector every Bex chat API
--   route gates on (/api/bex/chat/stream, /api/bex/conversations[/:id],
--   /api/bex/messages/:id/feedback, /api/bex/workflow-runs/:id,
--   /api/bex/cost/metrics). A live check on 2026-09-02 found NO row for it in
--   public.permission — so the /admin/permissions coverage tile reported
--   missingInDb = 1, and every Bex chat request by every user has been logging
--   a shadow would-be denial (reason 'missing-permission') since 2026-08-14.
--
--   Same failure mode as B0-643 (bex.chat.view-all) and B0-560: the B0-403 seed
--   migration 20260811090001_seed_permissions_from_c360.sql IS recorded in the
--   ledger (version 20260811150412) and DID create bex.chat.use plus grants for
--   executive / sales / customer-service / finance-contract-management /
--   operations -- but none of that took effect live. Of its 7 permission_group
--   rows only 'it-admin' exists; the other 6 groups are absent, as are its '*'
--   and 'navigation.*' wildcard rows (B0-560 step 3 also explicitly deletes '*').
--
--   B0-403 gave it-admin NO bex.chat.use group_permission row on purpose,
--   because it-admin was to receive '*' as a direct user_group_permission grant.
--   B0-560 step 1 deleted those direct '*' grants and step 3 deleted the '*'
--   permission row, replacing them with explicit per-selector it-admin grants --
--   but only for nav-visibility selectors. bex.chat.use was declared "out of
--   scope, left untouched", which in practice left it-admin with no path to it
--   at all. This migration closes that gap and nothing else.
--
-- SCOPE / NON-SCOPE
--   Grants it-admin ONLY. The 5 non-admin groups B0-403 intended to hold
--   bex.chat.use do not exist in this database, and 90 of the 96 active app_user
--   rows hold no group membership of any kind. Deciding who else may use Bex
--   chat is a product/IT call, NOT a silent widening here -- it is the open
--   remediation item that keeps BEX_PERMISSIONS_ENFORCED at false. See
--   src/docs/permissions-enforcement-cutover.md.
--
--   This migration does not change any behaviour while BEX_PERMISSIONS_ENFORCED
--   is false (public.settings): shadow mode denies nobody. It only makes the
--   catalog honest and restores it-admin's intended coverage ahead of the flip.
--
-- Idempotent: safe to re-run whether or not the row/grant already exist, and it
-- revives the row if some earlier pass soft-deleted it.
-- =============================================================================

insert into public.permission (permission_id, selector, description)
values (
  gen_random_uuid()::text,
  'bex.chat.use',
  'Bex chat: send messages / use the assistant.'
)
on conflict (selector) do nothing;

-- Revive a soft-deleted row rather than leaving the insert above a silent no-op.
update public.permission
set deleted_at = null,
    updated_at = now()
where selector = 'bex.chat.use'
  and deleted_at is not null;

insert into public.group_permission (group_permission_id, permission_id, permission_group_id)
select
  gen_random_uuid()::text,
  p.permission_id,
  '4ccf2523-ec6a-45fe-b58f-ef9c9114856b' -- it-admin
from public.permission p
where p.selector = 'bex.chat.use'
  and p.deleted_at is null
on conflict (permission_group_id, permission_id) do nothing;

update public.group_permission gp
set deleted_at = null,
    updated_at = now()
from public.permission p
where gp.permission_id = p.permission_id
  and p.selector = 'bex.chat.use'
  and gp.permission_group_id = '4ccf2523-ec6a-45fe-b58f-ef9c9114856b'
  and gp.deleted_at is not null;
