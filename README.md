# Betco App Boilerplate

Next.js 16 starting point for Betco apps. It ships authentication, permissions, analytics, an admin shell, shadcn components and Storybook, and nothing app-specific.

## What's included

- **Auth**: NextAuth with Azure AD, route protection in `src/proxy.ts`, and an auth-user cookie that carries the user and their permission groups.
- **Permissions**: selector catalog, user/group/permission admin UI at `/admin/permissions`, per-user Redis cache, and a shadow-mode switch for safe rollout.
- **Analytics**: page-view and event logging to `public.event_logging`, with a dashboard at `/admin/analytics`.
- **Admin shell**: collapsible sidebar, account menu, access-denied toast, loading skeletons.
- **UI**: shadcn components in `src/components/ui`, with stories under `src/stories`.

## Quick start

```bash
pnpm install
cp .env.example .env.local   # fill in the values
pnpm dev                     # http://localhost:3000
pnpm storybook               # http://localhost:6006
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `NEXTAUTH_URL`, `NEXTAUTH_SECRET` | NextAuth base URL and signing secret. |
| `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_TENANT_ID` | Azure AD app registration. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role, server-only. All data access goes through it. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Permission cache. |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | Sentry (server/edge and browser). Unset disables reporting. |
| `AUTH_SESSION_MAX_AGE_SECONDS` | Optional. Session and cookie lifetime, default 7 days. |

## Database

Apply `src/supabase/migrations/*.sql` in order to a fresh Supabase project. They create `app_user`, the permission tables and functions, `audit_logs`, `settings`, `event_logging`, and seed the `it-admin` group with the wildcard grant. The seed contains no users: the header of `20260101000600_seed_permissions.sql` shows how to make yourself the first admin.

Regenerate types after schema changes:

```bash
SUPABASE_PROJECT_ID=<project-id> pnpm types:supabase
```

## Scripts

`pnpm dev`, `build`, `start`, `lint`, `test`, `storybook`, `build-storybook`.

## Starting a new app from this

Set the Sentry `project` in `next.config.ts`, rename the package in `package.json`, replace the placeholder title in `src/app/layout.tsx` and the sign-in heading in `src/components/auth/FormLogin.tsx`, then add pages as described in `AGENTS.md`.
