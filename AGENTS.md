<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# bex-2.0 — agent instructions

Use this file together with the user’s rules. Prefer **running** `pnpm exec tsc --noEmit` and `pnpm lint` after non-trivial edits.

## Stack

- **Next.js** 16 (App Router), **React** 19, **TypeScript** (strict).
- **Tailwind CSS** v4 (`@import "tailwindcss"`, `@theme inline` in `src/app/globals.css`), **shadcn**-style UI under `~/components/ui`.
- **Zod** v4 for request/response and orchestration contracts.
- **Supabase** (`@supabase/supabase-js`), **OpenAI** SDK where LLM/embeddings are used.
- **Client UX**: `lucide-react`, `sonner`, `react-markdown` (e.g. Bex message rendering).

## Path alias

- Import from **`~/...`** only (maps to `./src/*` per `tsconfig.json`). Avoid long `../../` paths from `components/` or `lib/`.

## Directory layout (intended patterns)

| Area                   | Location                                    | Notes                                                                                                                                                                   |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes                 | `src/app/**`                                | Keep **route files thin** (`page.tsx`, `layout.tsx`, `loading.tsx`). No large feature UI inlined here.                                                                  |
| Feature UI             | `src/components/<feature>/`                 | e.g. Bex: `components/bex/*`. Admin widgets: `components/admin/*`.                                                                                                      |
| Domain logic           | `src/lib/<domain>/`                         | e.g. `lib/bex/`, `lib/rag/`, `lib/orchestrator/`, `lib/agents/`.                                                                                                        |
| Shared types           | `src/types/`                                | e.g. `types/bex.ts`, generated `types/supabase.*.ts`.                                                                                                                   |
| API handlers           | `src/app/api/**/route.ts`                   | Orchestration, agents, RAG helpers.                                                                                                                                     |
| Server Actions         | Prefer **`src/lib/**`** with `'use server'` | e.g. `lib/rag/generate-actions.ts` — do **not** put actions only under `app/` if components need to import them; avoids `~/app/(authenticated)/...` from `components/`. |
| SME / prompts          | `src/lib/agents/**`                         | Specialists (product, bathroom, dilution, floor), `run-sme-agent`, `sme-schemas`.                                                                                       |
| Eval / training assets | `src/lib/training/**`                       | JSON + expectation helpers; treat as data, not UI.                                                                                                                      |

## Bex (admin chat)

- **UI**: `~/components/bex/*` (`BexChatApp`, messages, sidebar, composer).
- **Page**: `src/app/(authenticated)/admin/bex/page.tsx` imports `~/components/bex/BexChatApp` only.
- **Client → API (Bex UI)**: `~/lib/bex/bex-api-client.ts` posts via `apiPostBexChatStream()` to **`/api/bex/chat/stream`** (AI SDK streaming, gated by `BEX_AI_SDK_STREAMING_*`) and loads history from **`/api/bex/conversations`**. The old **`/api/bex/chat`** is **deprecated (HTTP 410)**. **`/api/v1/orchestrator`** still supports the `bex-chat` workflow and returns **`productSupport`** — now **token-authenticated, server-to-server only** (the browser path is gone; the bex UI uses `/api/bex/*`); validate with **`bexOrchestrateOkResponseSchema`**.
- **Sessions**: `~/lib/bex/sessions.ts` + types in `~/types/bex.ts`.

## Orchestrator and SME agents

- **Core**: `~/lib/orchestrator/run-orchestration.ts`, routing in `sme-routing.ts`.
- **Contracts (Zod + inferred types)**: `~/lib/orchestrator/orchestrator-schemas.ts` — steps, routing, SME payload, run result, `parseOrchestratorPostBody`, `bexChatOrchestrationInputSchema`, `bexOrchestrateOkResponseSchema`.
- **SME HTTP + run schemas**: `~/lib/agents/sme/sme-schemas.ts`; runner `run-sme-agent.ts`; route factory `agent-route.ts`.
- **SME IDs** (registry + schema) include **`product`**, **`bathroom`**, **`dilution`**, **`floor`** — keep enum, registry (`/api/v1/agents`), and routing scores in sync when adding an agent.
- **Auth (`/api/v1/*` — machine callers)**: every `/api/v1/*` route (orchestrator + all SME agents + agents registry) requires a per-client token via `authenticateApiToken` / `unauthorizedResponse` (`~/lib/api/client-auth`), verified against the `api_project` → `api_app` → `api_key` registry with a chain check (token not revoked/expired → app active → project active) and a uniform 401. Tokens are `Authorization: Bearer bex_<env>_…` (see `~/lib/api/api-tokens`). There is **no** shared key, no `NODE_ENV` allow-all, and no anonymous "non-empty message" bypass — all deleted. Local dev uses the seeded "Local Dev" token. Bex UI routes (`/api/bex/*`) instead use the NextAuth session (`hasBexSession`, `~/lib/api/bex-api-auth`).

When changing API shapes, update **Zod schemas first**, then types/implementations, then clients.

- **Generation runtime**: `runProductSupportWorkflow` selects between the OpenAI **Responses** loop (`~/lib/openai/responses-runtime.ts`, default) and the **AI SDK** `streamText` loop (`~/lib/bex/ai-sdk-runtime.ts`) via `BEX_AI_SDK_GENERATION_ENABLED`. Both share the extracted `executeTool` closure and produce `{ assistantText, finalResponseId, toolTrace, responseIds }`. The AI SDK path replays `priorMessages` (stateless) and sets a synthetic `ai_sdk:<runId>` in place of `latest_openai_response_id`.

## RAG / admin products

- Pipeline and status: `~/lib/rag/pipeline.ts`, search: `~/lib/rag/search.ts`, embeddings: `~/lib/rag/embeddings.ts`.
- **Generate** UI uses `~/lib/rag/generate-actions.ts` (server actions + `revalidatePath` for `/admin/products/rag/*`).
- **Label ingestion** (B0-256/B0-258): `rag.label` and `rag.label_chunk` tables store product labels. `~/lib/label/convert-label-to-markdown.ts` (B0-260) is a reusable, Bex-agnostic converter utility that transforms HTML/PDF labels to structured markdown with active ingredients, dilution, EPA/DIN, and photo metadata.
- **Reranking** (B0-280): After RRF fusion, `~/lib/rag/search.ts` applies Cohere reranking (via `rerankChunks`) to boost relevance; over-fetches (limit × 5) to give reranker a larger candidate pool.
- **Corpus scoping** (B0-283): `rag.document.corpus_scope` column (`betco_us|betco_ca|betco_uaca|other`) filters SDS/label documents by policy (Betco finished-goods, EN+CAN only); `rag.out_of_scope_documents` view identifies documents to purge.
- Admin pages under `app/(authenticated)/admin/products/**` should stay presentation-focused; reuse `~/components/admin/*` when a block grows.

## Styling and UI

- Use **design tokens** from `globals.css` / `@theme` (`primary`, `card`, `muted`, `radius-*`, etc.).
- Prefer **Tailwind v4** utilities (e.g. `bg-linear-to-br` where the linter suggests over older gradient names).
- Match existing **rounded-2xl / rounded-3xl** and border/ring patterns used in admin and Bex.
- For gradients with a **fixed angle**, use explicit `linear-gradient(45deg, …)` (or similar) when corner-to-corner utilities are not the right geometry.

## Supabase types

Regenerate when the remote schema changes (requires CLI auth):

- `pnpm run types:supabase:legacy` → `src/types/supabase.legacy.ts`
- `pnpm run types:supabase:rag` → `src/types/supabase.rag.ts`

## Implementation norms

- **Scope**: Change only what the task requires; avoid drive-by refactors and unrelated files.
- **Validation**: Prefer **Zod** (`safeParse` at HTTP boundaries, `parse` only when failure should throw) over ad-hoc `typeof` chains for shared contracts.
- **Errors**: API routes return structured JSON (`error`, optional `issues` for Zod).
- **Comments**: Short and only where non-obvious; do not delete unrelated comments.
- **Markdown docs**: Do not add or expand repo markdown unless the user asks (this file is an exception as the user requested it).
- **Update jira**: Always use atlassian connector and update any tasks you work on
- **Answer & Grounding**: Always use code to ground your answers and decisions, DO NOT rely solely on JIRA.
- **Upon completion of any work**: Always ensure you include in ending summary a set of steps to test what was changed.
- **Making commits**: Aways ensure to use Conventional commits when creating any new commits, if you're unsure consult documentation https://www.conventionalcommits.org/en/v1.0.0/

## Quick checks before handoff

```bash
pnpm exec tsc --noEmit
pnpm lint
```

Fix any new diagnostics in files you touched.

- **Recommendations / cross-reference changes:** if you touch the recommendations prompt
  (`recommendations-specialist-system-prompt.ts`), `sme-routing.ts` recommendation signals,
  `scoreRecommendation`/`gateRecommendation`, or `XREF_RECOMMENDATION_MIN_CONFIDENCE`, also run the
  recommendations regression suite and the `/admin/tests` "Recommendation Golden Set — Cross-Reference
  1:1 (B0-99)" harness run before merging (see `src/docs/cross-reference-recommendations.md`):

  ```bash
  pnpm exec vitest run src/lib/recommendations
  ```
