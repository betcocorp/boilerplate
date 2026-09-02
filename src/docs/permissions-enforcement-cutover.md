# Permissions enforcement — go/no-go, rollout and rollback (B0-413, epic B0-401)

Operator runbook for flipping `BEX_PERMISSIONS_ENFORCED` from shadow mode to enforced, and for
backing it out again.

> The B0-413 description cites "plan §6, §7". **That plan document does not exist in this repo**
> (checked 2026-09-02) — it lives in the ticket/Confluence, not in `src/docs/`. The verification
> evidence, verdict and runbook the AC asks for live here instead, following the same convention as
> `src/docs/semantic-router-cutover.md`.

---

## 0. Verdict — **NO-GO** as of 2026-09-02

Do **not** set `BEX_PERMISSIONS_ENFORCED = true` yet.

The shadow-log review, seed diff and catalog audit all completed. Two of the three came back clean.
The blocker is not a bug in the gating code — the code is correct and does exactly what it says.
The blocker is that **the grant data was never populated**: 6 of 96 active users hold any permission
at all, and the 5 permission groups that were designed to carry `bex.chat.use` for everyone else do
not exist in this database. Flipping today locks 90 active users out of Bex chat and the whole admin
nav.

Finding a blocker here is this ticket working as intended. See §5 for the remediation list.

---

## 1. What "flip the flag" actually means

`BEX_PERMISSIONS_ENFORCED` is **a `public.settings` row, not an environment variable.** It was moved
off `process.env` by B0-638. Setting an env var of that name has no effect on anything.

| | |
|---|---|
| Storage | `public.settings` where `key = 'BEX_PERMISSIONS_ENFORCED'`, `value_type = 'boolean'` |
| Current value | `false` (seeded by `20260820170000_create_settings_table.sql`) |
| Read by | `isPermissionsEnforced()` — `~/lib/permissions/enforcement.ts`, via `getBooleanSetting` |
| Flip surface | `/admin/settings` (registered in `BOOLEAN_SETTINGS`, `~/components/admin/settings/SettingsPanel.tsx`) — or a direct `update public.settings` |
| Propagation | `settings-service` caches for **30s**; allow up to 30 seconds on a warm server |
| Scope | One row in one database. There is **no separate staging value** unless staging points at a different Supabase project — confirm that before treating "staging first" as real isolation |

Every other mention of `BEX_PERMISSIONS_ENFORCED` in the codebase is a comment or a test, including
`src/proxy.ts:19` (deliberately flag-free — the flag is read inside the rebuild route, which runs on
the Node runtime).

### What flips on

| Surface | Shadow (today) | Enforced |
|---|---|---|
| API routes (`gateRoute` → `requirePermission`) | verdict recorded, request proceeds | `403` |
| Admin sidebar / account menu / dashboard cards | everything visible | ungranted items hidden |
| NextAuth `signIn` callback (`~/lib/auth.ts`) | warn + sign in anyway | redirect to `/?error=UserNotFound` \| `AccountInactive` \| `NoIdentity` \| `AccessDenied` |
| `GET /api/auth/rebuild-user` on failure | forwards with loop-breaker cookie | signs the user out |

Authentication is **not** flag-gated: no NextAuth session is a `401` in both modes.

---

## 2. Step 1 — shadow-log review (complete)

Source: `public.audit_logs`, event types `permission.shadow_verdict` (would-be denial) and
`permission.denied` (denial actually served). Note the de-duplication window in
`~/lib/permissions/enforcement.ts`: at most one audit row per
`(mode, surface, user, selector, reason)` per 24h per server instance. These are **distinct
would-be denials, not request counts** — the true request volume is higher.

Shadow period: **2026-08-11 17:16 → 2026-09-01 19:57 UTC**.

| Metric | Value |
|---|---|
| Total denial rows | **630** |
| `permission.shadow_verdict` (would-be denials) | **628** |
| `permission.denied` (served denials) | **2** |
| Distinct users affected | **9** |
| Distinct (route, selector) pairs | **36** |
| `auth`-surface denials (sign-in gate) | **0** |

By reason:

| Reason | Rows | api | nav | auth |
|---|---|---|---|---|
| `missing-permission` | 427 | 188 | 239 | 0 |
| `permissions-unavailable` | 198 | 42 | 156 | 0 |
| `user-not-found` | 5 | 5 | 0 | 0 |

### The 2 real denials

Both on **2026-08-11 17:54**, `mquay@betco.com`, `mode: enforced`. Someone briefly enabled
enforcement during phase-1 development (pre-B0-638, when the flag was still an env var) and backed
it out within minutes. Useful evidence: **the rollback path works and is fast.**

### Classification of every distinct would-be denial

| Group | Rows | Classification |
|---|---:|---|
| `bex.chat.use` on `/api/bex/*` (tbird, jnowicki, dpetrie, mquay, bbetz) | ~140 | **Missing seed row** — the `bex.chat.use` permission row did not exist at all. Fixed by `20260902130000_restore_bex_chat_use_permission_b0413.sql`, grant-side still open (§5.1) |
| `navigation.sidebar.*` / `admin.card.permissions` nav bundles, users with no group | ~390 | **Missing seed row (grants)** — 90 of 96 active users hold zero `user_group_permission` rows. Not a bug |
| `navigation.sidebar.bex`, `navigation.sidebar.projects`, `dashboard.permissions.card` (all ≤ 2026-08-19) | ~95 | **Correctly denied / obsolete** — retired selectors deleted by B0-560. No longer emitted; nothing to fix |
| `navigation.sidebar.tests`, `.observability` on admin API routes (tbird, jnowicki as it-admins) | ~55 | **Correctly denied at the time**, now granted — it-admin holds all 14 nav selectors since B0-560 |
| `navigation.sidebar.user.settings` (2026-08-21), `.cost` (2026-08-20), `.user.analytics` (2026-08-31) | 14 | **Missing selector, since fixed** — each was the gap between shipping the feature and applying its permission migration. All three rows now exist |
| `user-not-found`, 5 rows, tbird + jnowicki, 2026-08-11/12 only | 5 | **Not a seed gap** — the auth-user *cookie* was absent so `USER_ID` was null. This is what `GET /api/auth/rebuild-user` (B0-406) was built to repair; no recurrence since 2026-08-12 |

**Genuine code bugs found: 0.** Every would-be denial maps to a missing seed row, a missing selector
that has since been added, or a correctly-denied obsolete selector.

### One logging defect worth knowing before the flip

`permissions-unavailable` is emitted for two different situations that the log cannot tell apart
(`~/lib/permissions/require-permission.ts:162`): a genuine Redis/Postgres lookup failure, **and** a
user who simply resolves to zero permissions. Given only 6 users hold any grant, the 198 rows are
dominated by the second case. Its 403 body — `"Permissions not available; try signing in again"` —
is actively misleading for a user with no grants, who will sign in again, get the same 403, and file
a ticket. Worth splitting the reason before the flip; not a blocker on its own.

---

## 3. Step 2 — seed-vs-active-users diff (complete, clean)

Compared every identity observed in `audit_logs` permission verdicts and in `public.event_logging`
against `public.app_user`.

| Metric | Value |
|---|---|
| `app_user` rows | 132 |
| Active (`is_active`, not deleted) | 96 |
| Distinct users observed in shadow verdicts | 9 |
| Distinct users observed in event analytics | 5 |
| **Observed users missing from `app_user`** | **0** |

**No `app_user` rows need to be added.** Every real signer-in already has a row, which is consistent
with the 0 `auth`-surface denials in §2 — the sign-in gate has never rejected anybody, not even in
shadow.

One item to confirm with IT rather than fix in code:

| Email | `user_id` | State | Effect on flip |
|---|---|---|---|
| `aziskovsky@betco.com` | `005Rn000000Hd6bIAC` | `is_active = false`, department Finance | Sign-in returns `/?error=AccountInactive`. Seen once, 2026-08-21. If this account is genuinely deactivated, that is correct behaviour — if not, `is_active` needs correcting **before** the flip |

---

## 4. Step 3 — selector catalog coverage (complete, now 0)

The `/admin/permissions` coverage tiles come from `summarizePermissionCatalog`
(`~/components/permissions/catalog-audit.ts`), diffing `Object.values(PERMISSIONS)` against
`public.permission.selector`.

| Metric | Before B0-413 | After |
|---|---:|---:|
| Catalog selectors (code) | 17 | 17 |
| Deployed selectors (DB) | 16 | 17 |
| **`missingInDb`** | **1** (`bex.chat.use`) | **0** |
| `unusedInCode` | 0 | 0 |
| Coverage | 94% | 100% |

Every `gateRoute` / `requirePermission` / nav call site references a `PERMISSIONS.*` constant — no
string-literal selectors escape the catalog, so catalog coverage really is surface coverage.

`bex.chat.use` was the third instance of the same failure mode (after B0-560 and B0-643): the B0-403
seed migration is recorded in the ledger as applied, but its rows are not in the database. Root
cause of *this* instance is narrower and worth stating exactly — B0-403 deliberately gave it-admin
no `bex.chat.use` row because it-admin was to hold a direct `'*'` grant; B0-560 then deleted both the
`'*'` grant and the `'*'` permission row, replacing them with explicit per-selector grants **for
nav-visibility selectors only**, declaring `bex.chat.use` out of scope. The net effect was that
it-admin lost its only path to `bex.chat.use`.

---

## 5. Remediation list — what must be true before GO

### 5.1 Decide and populate who may use Bex chat — **BLOCKER**

`bex.chat.use` now exists and is granted to `it-admin` (6 members). Nobody else can reach it.

B0-403 intended these grants:

| Group | Intended `bex.chat.use` | Exists in DB? |
|---|---|---|
| `it-admin` | via `'*'` | **yes** — now granted explicitly by B0-413 |
| `executive` | yes | **no — group absent** |
| `sales` | yes | **no — group absent** |
| `customer-service` | yes | **no — group absent** |
| `finance-contract-management` | yes | **no — group absent** |
| `operations` | yes | **no — group absent** |
| `crm-admin` | deliberately **not** granted (known gap, B0-403) | **no — group absent** |

Only `it-admin` of the 7 groups exists. Two options, both a decision for IT/product — **not** a
silent data fix:

1. Re-run the c360 export against **prod** Snowflake (`snowflake-api` /
   `scripts/exportPermissionsMigrationSeed.ts`) and load the missing 6 groups plus real membership.
   B0-403's own header flags this as a prerequisite of B0-413: its export ran against `DEV_CRM_DB`,
   so both membership and `user_id`s reflect c360 **dev**.
2. Decide Bex chat is open to every active `app_user` and express that as one broad group, or drop
   the `bex.chat.use` gate entirely.

Until one of these lands, enforcement = 90 locked-out users.

### 5.2 Confirm `aziskovsky@betco.com`'s `is_active = false` is intentional (§3).

### 5.3 Confirm whether staging and prod share a Supabase project (§1).
If they do, "staging → prod" is not a real sequence and the flip is single-shot — which raises the
bar on §5.1 rather than lowering it.

### 5.4 Optional, recommended: split the `permissions-unavailable` reason (§2) so a
zero-grant user gets an accurate 403 instead of "try signing in again".

---

## 6. Flip runbook (once §5.1 is closed)

Pre-flight, all four:

```sql
-- 1. catalog coverage must be 0 missing
select count(*) from public.permission where deleted_at is null;   -- expect 17

-- 2. every active user must resolve to >= 1 permission
select count(*) from public.app_user u
where u.is_active and u.deleted_at is null
  and not exists (select 1 from public.user_group_permission g
                  where g.user_id = u.user_id and g.deleted_at is null);
-- MUST be 0. It is 90 today.

-- 3. no would-be denial in the last 72h for a user who should have access
select payload->>'email', payload->>'selector', payload->>'route', count(*)
from public.audit_logs
where event_type = 'permission.shadow_verdict'
  and created_at > now() - interval '72 hours'
group by 1,2,3 order by 4 desc;

-- 4. the flag is where you think it is
select key, value, updated_at from public.settings where key = 'BEX_PERMISSIONS_ENFORCED';
```

Flip:

1. **Staging first** (only meaningful if it is a separate Supabase project — see §5.3). Toggle
   `BEX_PERMISSIONS_ENFORCED` on `/admin/settings`. Wait 30s for the settings cache.
2. Smoke test as **three** identities, not one: an `it-admin`, a normal Bex chat user, and a user
   with no grants. Confirm sign-in, the Bex chat page, sending a message, and the admin sidebar.
3. Soak **24h**. Then prod, same toggle, same 30s wait, same three-identity smoke test.
4. Watch for a week, then remove the flag and its three shadow-mode branches
   (`~/lib/permissions/enforcement.ts`, `~/lib/permissions/require-permission.ts`, `~/lib/auth.ts`).

Monitor, for 1h intensively then daily:

```sql
-- served denials (this replaces permission.shadow_verdict once enforced)
select payload->>'email' as email, payload->>'selector' as selector,
       payload->>'route' as route, payload->>'reason' as reason, count(*) n
from public.audit_logs
where event_type = 'permission.denied' and created_at > now() - interval '1 hour'
group by 1,2,3,4 order by n desc;

-- sign-in failures
select meta->>'reason' as reason, count(*) n
from public.event_logging
where event = 'analytics.user.login.failure' and created_at > now() - interval '1 hour'
group by 1 order by n desc;
```

Also watch Sentry for `bex sign-in rejected: *` (level rises from `info` to `warning` once
enforced) and `auth.login.failure`.

**Abort and roll back immediately if any of these is true:**

- any `permission.denied` for a user who should have access — one is enough
- any `analytics.user.login.failure` with reason `user-not-found` or `account-inactive`
- `permission.denied` with reason `permissions-unavailable` rising across *multiple* users (that is
  a Redis/Postgres lookup failure, not a permission decision, and it fails closed)
- Bex chat 403 rate above zero for non-test traffic

**Rollback:** set `BEX_PERMISSIONS_ENFORCED` back to `false` on `/admin/settings` (or
`update public.settings set value = 'false' where key = 'BEX_PERMISSIONS_ENFORCED'`). Effective
within 30s; no deploy, no restart, no data change. Users already signed out by the enforced sign-in
gate must sign in again — that is the one part of the flip that is not instantly reversible, which
is why §6 step 2 tests a zero-grant identity before the soak.
