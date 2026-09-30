# Betco Boilerplate

A generic starter for Betco engineering projects: Next.js 16 (App Router), Supabase, the
Vercel AI SDK, and shadcn/ui.

## Stack

- **Next.js 16** (App Router), **React 19**, **TypeScript** (strict)
- **Tailwind CSS v4** + **shadcn/ui** components (`src/components/ui`)
- **Supabase** (`@supabase/supabase-js`) — client/server/service-role clients in
  `src/supabase/clients`
- **Vercel AI SDK v6** (`ai`, `@ai-sdk/react`, `@ai-sdk/openai`, `@ai-sdk/anthropic`) — see
  `src/app/api/chat/route.ts` and `src/components/ChatExample.tsx` for a minimal streaming chat
  example, and `src/lib/llm/resolve-model.ts` / `src/lib/constants/models.ts` for a
  vendor-neutral model-tag resolution pattern
- **NextAuth** (Azure AD provider configured in `src/lib/auth.ts`) — swap in your own provider(s)
- **Vitest** for tests, **ESLint 9** (flat config)

## Getting started

```bash
pnpm install
cp .env.example .env.local   # fill in your own values
pnpm dev
```

### Environment variables

| Variable | Used for |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase clients |
| `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_TENANT_ID`, `NEXTAUTH_SECRET` | NextAuth |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | AI SDK providers |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry (leave unset to disable) |

### Database

`src/supabase/migrations/` starts empty — add your own migrations (`supabase migration new <name>`)
and apply them locally with the Supabase CLI, or via an MCP `apply_migration` call if you're working
with Claude Code. Regenerate `src/types/supabase.public.ts` against your schema with:

```bash
pnpm run types:supabase
```

## Directory layout

| Area | Location |
| --- | --- |
| Routes | `src/app/**` — keep route files thin (`page.tsx`, `layout.tsx`); put feature UI under `src/components/` |
| Feature UI | `src/components/<feature>/` |
| Domain logic | `src/lib/<domain>/` |
| Shared types | `src/types/` |
| API handlers | `src/app/api/**/route.ts` |
| Server Actions | `src/lib/**` with `'use server'` |

Import from `~/...` only (maps to `./src/*`, see `tsconfig.json`) — avoid long `../../` paths.

## Quick checks

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm exec vitest run
```
