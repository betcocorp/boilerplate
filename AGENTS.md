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
- **One bathroom prompt — keep the guarded text (B0-352, consolidated 2026-10-05).** `BATHROOM_SPECIALIST_SYSTEM_PROMPT` lives only in `~/lib/agents/bathroom-specialist/bathroom-specialist-system-prompt.ts`; `product-support-prompts.ts` imports and re-exports it for prompt hashing. It is the text the regulated product-support path has always run: a `# Tool use (mandatory)` section ("You MUST call at least one retrieval tool… Never answer from training knowledge alone") and a 5-rule decline block. The former SME-route copy (escalation via a non-existent `escalation_specialist`, no mandatory-retrieval section) was never sent to a model — `/api/v1/agents/bathroom` runs the workflow via `runRealSmeAgentAnswer` and only echoed that copy as `systemPrompt` metadata — so it was deleted, not merged in. Never edit this prompt in a way that drops the mandatory-retrieval section, and verify any change to it by dumping the string before and after and running `diff`, never by trusting a claim of equivalence (two earlier dedupe attempts, B0-530 and B0-352, inverted the direction and were reverted). `confidence-thresholds.test.ts` asserts both import sites resolve to the same guarded string. Thresholds come from `confidenceGateClause` (`~/lib/agents/sme/confidence-thresholds.ts`), never a hardcoded number.
- **`/api/v1/agents/*` — kept, and all of it is live (B0-352).** These are token-authenticated, server-to-server single-turn endpoints: one POST route per SME id, plus `GET /api/v1/agents` which lists `V1_AGENT_REGISTRY`. As of 2026-08-26 **no entry is a stub** — `product`, `dilution`, `floor`, `bathroom` and `recommendations` run the real product-support workflow forced to that specialist (`runRealSmeAgentAnswer`), and `cross_reference` runs the cross-reference engine (`runCrossReferenceSmeAgentAnswer`). The `pending`-steps payload still in `runSmeAgent` is a defensive default only: `smeAgentHttpInvokeSchema` 400s a blank `query`, so no HTTP caller can reach it. The registry is not only an API listing — its ids and labels are what the eval harness renders for `tests.intended_agent`, and its ids are `SmeAgentId`, so deleting an entry breaks `/admin/tests` as well as the endpoint.
- **Auth (`/api/v1/*` — machine callers)**: every `/api/v1/*` route (orchestrator + all SME agents + agents registry) requires a per-client token via `authenticateApiToken` / `unauthorizedResponse` (`~/lib/api/client-auth`), verified against the `api_project` → `api_app` → `api_key` registry with a chain check (token not revoked/expired → app active → project active) and a uniform 401. Tokens are `Authorization: Bearer bex_<env>_…` (see `~/lib/api/api-tokens`). There is **no** shared key, no `NODE_ENV` allow-all, and no anonymous "non-empty message" bypass — all deleted. Local dev uses the seeded "Local Dev" token. Bex UI routes (`/api/bex/*`) instead use the NextAuth session (`hasBexSession`, `~/lib/api/bex-api-auth`).

When changing API shapes, update **Zod schemas first**, then types/implementations, then clients.

- **Generation runtime**: `runProductSupportWorkflow` selects between the OpenAI **Responses** loop (`~/lib/openai/responses-runtime.ts`, default) and the **AI SDK** `streamText` loop (`~/lib/bex/ai-sdk-runtime.ts`) via `BEX_AI_SDK_GENERATION_ENABLED`. Both share the extracted `executeTool` closure and produce `{ assistantText, finalResponseId, toolTrace, responseIds }`. The AI SDK path replays `priorMessages` (stateless) and sets a synthetic `ai_sdk:<runId>` in place of `latest_openai_response_id`.

- **B0-378 — both runtimes stay; Responses is canonical.** The decision record is `src/docs/generation-runtimes.md` — read it before changing either loop. `BEX_AI_SDK_GENERATION_ENABLED` is a **settings-table** flag (B0-638), not an env var; it defaults to `false`, so the Responses loop is the production default. Prior-turn tool context is no longer dropped on the AI SDK path: `buildPriorTurnHistory` (`~/lib/bex/run-chat-turn.ts`) attaches a `toolContext` **summary** (tool names + retrieved document titles, rendered by `formatPriorTurnToolContext`) to each assistant history message, and both runtimes replay it as its own message item. It is a summary, not real tool-call/tool-result parts, because the persisted message only stores `toolSummary` + `sources` — never fabricate call ids or pass a truncated `toolTrace` preview off as a tool payload, and never replay source snippets. Any loop change still has to be made in both files; keep the two history-replay paths byte-identical.

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
  recommendations regression suite and the threshold curve before merging (see
  `src/docs/cross-reference-recommendations.md` → "Pre-handoff checklist"). The `/admin/tests`
  "Cross-Reference Gate Calibration (B0-97)" harness set no longer exists — B0-826 purged every test
  item without concept columns on 2026-09-03 and that set was one of them (its seed migration and
  CSV fixture remain if it is ever re-seeded with concept columns):

  ```bash
  pnpm exec vitest run src/lib/recommendations
  npx tsx --env-file=.env.local scripts/calibrate-xref-threshold.ts
  ```

  Add `--harvest --limit 60` to that second command when `scoreRecommendation` itself changed —
  stored confidences are stale the moment its weights or inputs move. **Do not retune
  `XREF_RECOMMENDATION_MIN_CONFIDENCE` from the curve alone:** B0-97 measured the score as having no
  usable ability to rank correct answers above wrong ones (AUC 0.319 on 48 labeled cases), and at the
  0.80 default the gate answers 0.3% of web-path questions. Fix the scorer before the threshold.
