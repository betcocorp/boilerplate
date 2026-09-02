# Bex 2.0

Next.js admin app for Betco RAG tooling and the **Bex** product-support assistant. Chat uses the **OpenAI Responses API** (not Assistants), **server-side function tools**, and **Supabase** for RAG plus durable conversation/workflow storage.

## Quick start

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000/admin/bex](http://localhost:3000/admin/bex).

## Environment variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI API (Responses + embeddings for RAG search). |
| `BEX_RESPONSES_MODEL` | Default model when the UI sends `preview` (fallback: `gpt-4.1-mini`). |
| `BEX_MODEL_GPT4O` / `BEX_MODEL_GPT41` | Overrides for UI tags `gpt-4o` / `gpt-4.1`. |
| `BEX_VALIDATOR_MODEL` | Optional separate model for the validator pass. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role (server-only) for RAG + agent tables. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key for server client where used. |
| `API_TOKEN` (per client) | `/api/v1/*` uses per-client tokens from the project/app/token registry (`Authorization: Bearer bex_<env>_…`); no shared key. Local dev uses the seeded "Local Dev" token in `.env.local`. |
| `BEX_PERMISSIONS_ENFORCED` | The single switch for the permission system (epic B0-401). **No longer an env var** — B0-638 moved it to a `public.settings` row, toggled at `/admin/settings` and read by `isPermissionsEnforced()`; setting an env var of this name does nothing. Anything but `true` = **shadow mode**: verdicts are logged (`permission.verdict`) and would-be denials recorded in `audit_logs` as `permission.shadow_verdict`, but nothing is denied — no nav is hidden, no route returns 403, no sign-in is rejected, no session is cleared. `true` enforces. Currently `false`, and **NO-GO** to flip: see `src/docs/permissions-enforcement-cutover.md` for the evidence, blockers and runbook. |
| `AUTH_SESSION_MAX_AGE_SECONDS` | Session lifetime shared by the NextAuth JWT/session and the auth-user cookie. Defaults to `604800` (7 days); non-numeric or `<= 0` keeps the default. |

## Database migrations

Apply SQL under `src/supabase/migrations` in your Supabase project (including `20260408120000_agent_platform_tables.sql` for `agent_conversations`, `agent_messages`, `workflow_runs`, `workflow_steps`, `review_tasks`, `audit_logs`).

Regenerate types when possible:

- `pnpm run types:supabase:legacy`
- `pnpm run types:supabase:rag`

`src/types/supabase.public.ts` includes the new **public** agent tables; `rag` / `legacy` are described loosely so `.schema('rag')` and RPCs type-check until you regenerate.

## Architecture (Bex)

1. **UI** (`BexChatApp`) calls **`POST /api/bex/chat/stream`** (via `apiPostBexChatStream()`) with optional `conversationId`, `message`, and `model`. The streaming route uses the **Vercel AI SDK** (`createUIMessageStream`) and is gated by the `BEX_AI_SDK_STREAMING_*` flags. The old `POST /api/bex/chat` is **deprecated and returns HTTP 410**.
2. **`runBexChatTurn`** persists the user message, then **`runProductSupportWorkflow`**:
   - Keyword **orchestrator hint** from `routeUserMessageToSme` (planner context only).
   - **Generation runtime**: by default the **OpenAI Responses API** loop (`src/lib/openai/responses-runtime.ts`); when `BEX_AI_SDK_GENERATION_ENABLED=true`, the **Vercel AI SDK** `streamText` loop (`src/lib/bex/ai-sdk-runtime.ts`) runs instead — same result shape, tools, and streaming, but replays conversation history (`priorMessages`) rather than `previous_response_id` chaining. Both use the same **function tools** (`src/lib/tools/definitions.ts`) executed on the server (`execute-tool-call.ts` → `product-tools.ts`).
   - Tools wrap **`searchProductChunks`** and related retrieval (`src/lib/retrieval/*`) — transitional **RAG corpus** adapter, not a single mega-tool.
   - **Validator** pass (`validator.ts`) with structured JSON output; failed answers get a safe fallback + optional **review task**.
3. **Persistence**: `latest_openai_response_id` on `agent_conversations` chains turns via `previous_response_id`; developer instructions are resent each turn.
4. **Observability**: structured logs (`src/lib/observability/logger.ts`) and **`audit_logs`** rows for lifecycle and tool events.

Legacy **`POST /api/v1/orchestrator`** still accepts `bex-chat` and now runs the same pipeline, returning **`productSupport`** in the JSON (plus `routing` / `steps`).

## API routes

| Method | Path | Notes |
|--------|------|--------|
| POST | `/api/bex/chat/stream` | Main chat (AI SDK streaming); same auth pattern as v1 orchestrator for POST (bearer or non-empty message in dev). Gated by `BEX_AI_SDK_STREAMING_ENABLED`. |
| POST | `/api/bex/chat` | **Deprecated** — returns HTTP 410. Use `/api/bex/chat/stream`. |
| GET/POST | `/api/bex/conversations` | List / create conversations. |
| GET/DELETE | `/api/bex/conversations/[id]` | Load or delete thread + messages. |
| GET | `/api/bex/workflow-runs/[id]` | Run, steps, audit rows. |

## Tests

`src/lib/openai/response-item-parsing.test.ts` targets pure parsers; route contracts are covered under `src/app/api/bex/chat/**/route.test.ts`. **Vitest** is already a dev dependency — run `pnpm exec vitest` (see `vitest.config.ts`). Test files are excluded from `next build` typecheck via `tsconfig.json`.

## Follow-ups

- Replace RAG transitional adapters with structured product/surface tables where available.
- Tighten **RLS** on agent tables if exposing Supabase to clients; today routes use the **service role** on the server.
- Add real auth for admin and pass `user_id` / `workspace_id` into conversations.
- Regenerate **`supabase.legacy.ts`** so legacy admin pages regain strict typings.
