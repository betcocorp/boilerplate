<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# boilerplate — agent instructions

Use this file together with the user's rules. Prefer **running** `pnpm exec tsc --noEmit` and `pnpm lint` after non-trivial edits.

## Stack

- **Next.js** 16 (App Router), **React** 19, **TypeScript** (strict).
- **Tailwind CSS** v4 (`@import "tailwindcss"`, `@theme inline` in `src/app/globals.css`), **shadcn**-style UI under `~/components/ui`.
- **Supabase** (`@supabase/supabase-js`) — clients in `~/supabase/clients`.
- **Vercel AI SDK v6** (`ai`, `@ai-sdk/react`, `@ai-sdk/openai`, `@ai-sdk/anthropic`) for LLM calls.
- **NextAuth** (Azure AD provider, `~/lib/auth.ts`).
- **Client UX**: `lucide-react`, `sonner`.

## Path alias

- Import from **`~/...`** only (maps to `./src/*` per `tsconfig.json`). Avoid long `../../` paths from `components/` or `lib/`.

## Directory layout (intended patterns)

| Area | Location | Notes |
| --- | --- | --- |
| Routes | `src/app/**` | Keep **route files thin** (`page.tsx`, `layout.tsx`, `loading.tsx`). No large feature UI inlined here. |
| Feature UI | `src/components/<feature>/` | |
| Domain logic | `src/lib/<domain>/` | |
| Shared types | `src/types/` | `types/supabase.public.ts` is a placeholder `Database` type — regenerate with `pnpm run types:supabase` once you have a real schema. |
| API handlers | `src/app/api/**/route.ts` | |
| Server Actions | Prefer **`src/lib/**`** with `'use server'` | Do **not** put actions only under `app/` if components need to import them — avoids `~/app/(authenticated)/...` from `components/`. |

## AI SDK example

`src/app/api/chat/route.ts` + `src/components/ChatExample.tsx` (rendered at `/dashboard`) are a
minimal streaming chat example wired end to end. `~/lib/constants/models.ts` +
`~/lib/llm/resolve-model.ts` show a vendor-neutral model-tag pattern (`"gpt-4.1"`,
`"claude-sonnet-5"`, or omitted for the settings-table default) with `modelProviderFor()` deciding
which provider SDK wraps the resolved id. This is illustrative scaffolding, not a finished
abstraction — extend or replace it as your app's needs grow (retrieval, tool-calling, a different
provider).

## Settings table pattern

`~/lib/settings/settings-service.ts` shows a `public.settings`-table pattern for feature
flags/config that would otherwise live in `process.env`: `getBooleanSetting`/`getStringSetting`/
`getNumberSetting` read a cached row, falling back to the caller's default on any failure, plus two
typed-enum examples (`getRouterType`, `getLlmProvider`) showing how to validate a stored value
against an allowed set rather than trusting it. The table itself is created by
`src/supabase/migrations/20260930000000_create_settings_table.sql`; no rows are seeded — add your
own via `insert into public.settings (...)`.

## Styling and UI

- Use **design tokens** from `globals.css` / `@theme` (`primary`, `card`, `muted`, `radius-*`, etc.).
- Prefer **Tailwind v4** utilities (e.g. `bg-linear-to-br` where the linter suggests over older gradient names).
- For gradients with a **fixed angle**, use explicit `linear-gradient(45deg, …)` (or similar) when corner-to-corner utilities are not the right geometry.

## Implementation norms

- **Scope**: Change only what the task requires; avoid drive-by refactors and unrelated files.
- **Validation**: Prefer a schema library (Zod, etc.) at HTTP boundaries over ad-hoc `typeof` chains for shared contracts, if you add one as a dependency.
- **Errors**: API routes return structured JSON (`error`, optional `issues` for validation failures).
- **Comments**: Short and only where non-obvious; do not delete unrelated comments.
- **Markdown docs**: Do not add or expand repo markdown unless the user asks.
- **Making commits**: Always use Conventional Commits (https://www.conventionalcommits.org/en/v1.0.0/).

## Quick checks before handoff

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm exec vitest run
```

Fix any new diagnostics in files you touched.
