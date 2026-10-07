# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

# Betco app boilerplate — agent instructions

Starting point for new Betco apps: authentication, permissions, analytics, the admin shell, shadcn components and Storybook, and nothing else. Prefer **running** `pnpm exec tsc --noEmit` and `pnpm lint` after non-trivial edits.

## Stack

- **Next.js** 16 (App Router), **React** 19, **TypeScript** (strict), **pnpm**.
- **Tailwind CSS** v4 (`@import "tailwindcss"`, `@theme inline` in `src/app/globals.css`), **shadcn**-style UI under `~/components/ui`.
- **Zod** v4 for request/response contracts, **react-hook-form** for forms, **Zustand** for the client permissions store.
- **NextAuth 4** (Azure AD) for sign-in, **Supabase** (service-role client, server-only) for data, **Upstash Redis** for the permission cache, **Sentry** for errors.
- **Vitest** for unit tests, **Storybook 10** for components, **ESLint 9** flat config.

## Path alias

Import from **`~/...`** only (maps to `./src/*`). Avoid long `../../` paths.

## Layout

| Area | Location | Notes |
| --- | --- | --- |
| Routes | `src/app/**` | Keep route files thin. `/` is sign-in; everything signed-in lives under `(authenticated)/admin`. |
| Admin shell | `src/app/(authenticated)/admin/layout.tsx`, `src/components/admin/*` | Sidebar, account menu, page-view logger. Add nav entries in `AdminSidebarNavClient.tsx`. |
| Auth | `src/lib/auth.ts`, `src/proxy.ts`, `src/app/api/auth/*`, `src/components/auth/*` | NextAuth options, route protection, auth-user cookie rebuild. |
| Permissions | `src/lib/permissions/*`, `src/components/permissions/*`, `src/app/api/admin/permissions/*`, `src/app/(authenticated)/admin/permissions/*` | Selector catalog in `constants.ts`; admin UI for users, groups, permissions. |
| Analytics | `src/lib/event-logging/*`, `src/components/analytics/*`, `src/components/admin/analytics/*`, `src/app/api/events/log` | Event ingest, page-view inference, `/admin/analytics` dashboard. |
| Settings | `src/lib/settings/settings-service.ts` | Cached runtime toggles from `public.settings`. |
| UI | `src/components/ui/*`, `src/stories/**` | shadcn components and their Storybook stories. |
| Database | `src/supabase/migrations/*.sql`, `src/supabase/clients/*`, `src/types/supabase.public.ts` | Baseline schema for the above. |

## Permissions model

- Selectors are dotted strings checked in code (`~/lib/permissions/constants`) and stored in `public.permission`. Adding one means a constant, a migration row, and a `group_permission` grant, together.
- Deny by default: a surface with no selector is visible to everyone signed in; a selector is visible only to holders of it, or of a wildcard (`*`, `navigation.*`).
- `PERMISSIONS_ENFORCED` (a `public.settings` row, default `false`) is the single switch. Off is **shadow mode**: verdicts are logged and audited but never deny. Turn it on only after confirming nobody is locked out.
- Gate pages with `requirePagePermission`, API routes with `gateRoute` / `requirePermission`. Every API route also checks the session with `hasSession` (`~/lib/api/session-auth`).

## Adding a feature

1. Page under `src/app/(authenticated)/admin/<feature>`, thin, with `requirePagePermission` if it needs a selector.
2. Feature UI under `src/components/<feature>/`, domain logic under `src/lib/<feature>/`.
3. Nav entry in `AdminSidebarNavClient.tsx`, and a case in `~/lib/event-logging/infer-page-view.ts` so page views map to a named event.
4. Zod schemas first for any new API shape, then types and implementation, then clients.
5. A story for any new shared UI component under `src/stories/`.

## Implementation norms

- **Scope**: change only what the task requires; avoid drive-by refactors.
- **Validation**: Zod `safeParse` at HTTP boundaries over ad-hoc `typeof` chains.
- **Errors**: API routes return structured JSON (`error`, optional `issues` for Zod).
- **Comments**: short, only where non-obvious; do not delete unrelated comments.
- **Markdown docs**: do not add or expand repo markdown unless asked.
- **Grounding**: use the code to ground answers and decisions, not Jira alone.
- **Jira**: update the tickets you work on through the Atlassian connector.
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) with the Jira key as the scope, and `!` after the scope for breaking changes, e.g. `feat(B0-123): add export` or `refactor(B0-123)!: rename permission selectors`. Versioning is semantic.
- **Handoff**: always end with steps to test what changed.

## Quick checks before handoff

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm test
```

Fix any new diagnostics in files you touched. Known pre-existing failures: `react-hooks/set-state-in-effect` lint errors in a few permissions dialogs and `ui/*` files, and four timezone-sensitive tests in `src/components/admin/analytics/format.test.ts`.
