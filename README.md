# Bex 2.0

Next.js admin app for Betco RAG tooling and the **Bex** product-support assistant. Chat uses the **OpenAI Responses API** (not Assistants), **server-side function tools**, and **Supabase** for RAG plus durable conversation/workflow storage.

## Quick start

```bash
npm install
npm run dev
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
| `V1_ORCHESTRATOR_API_KEY` | Bearer secret for `/api/v1/*` and stricter read auth in production. |
| `BEX_RELAX_CONVERSATION_READ` | If `true`, allows unauthenticated GETs for conversation APIs (trusted admin only). |

## Database migrations

Apply SQL under `src/supabase/migrations` in your Supabase project (including `20260408120000_agent_platform_tables.sql` for `agent_conversations`, `agent_messages`, `workflow_runs`, `workflow_steps`, `review_tasks`, `audit_logs`).

Regenerate types when possible:

- `npm run types:supabase:legacy`
- `npm run types:supabase:rag`

`src/types/supabase.public.ts` includes the new **public** agent tables; `rag` / `legacy` are described loosely so `.schema('rag')` and RPCs type-check until you regenerate.

## Architecture (Bex)

1. **UI** (`BexChatApp`) calls **`POST /api/bex/chat`** with optional `conversationId`, `message`, and `model`.
2. **`runBexChatTurn`** persists the user message, then **`runProductSupportWorkflow`**:
   - Keyword **orchestrator hint** from `routeUserMessageToSme` (planner context only).
   - **Responses API** loop with **function tools** (`src/lib/tools/definitions.ts`) executed only on the server (`execute-tool-call.ts` → `product-tools.ts`).
   - Tools wrap **`searchProductChunks`** and related retrieval (`src/lib/retrieval/*`) — transitional **RAG corpus** adapter, not a single mega-tool.
   - **Validator** pass (`validator.ts`) with structured JSON output; failed answers get a safe fallback + optional **review task**.
3. **Persistence**: `latest_openai_response_id` on `agent_conversations` chains turns via `previous_response_id`; developer instructions are resent each turn.
4. **Observability**: structured logs (`src/lib/observability/logger.ts`) and **`audit_logs`** rows for lifecycle and tool events.

Legacy **`POST /api/v1/orchestrator`** still accepts `bex-chat` and now runs the same pipeline, returning **`productSupport`** in the JSON (plus `routing` / `steps`).

## API routes

| Method | Path | Notes |
|--------|------|--------|
| POST | `/api/bex/chat` | Main chat; same auth pattern as v1 orchestrator for POST (bearer or non-empty message in dev). |
| GET/POST | `/api/bex/conversations` | List / create conversations. |
| GET/DELETE | `/api/bex/conversations/[id]` | Load or delete thread + messages. |
| GET | `/api/bex/workflow-runs/[id]` | Run, steps, audit rows. |

## Tests

`src/lib/openai/response-item-parsing.test.ts` targets pure parsers. Install **Vitest** (`npm i -D vitest`) and run `npx vitest` (see `vitest.config.ts`). Test files are excluded from `next build` typecheck via `tsconfig.json`.

## Follow-ups

- Replace RAG transitional adapters with structured product/surface tables where available.
- Tighten **RLS** on agent tables if exposing Supabase to clients; today routes use the **service role** on the server.
- Add real auth for admin and pass `user_id` / `workspace_id` into conversations.
- Regenerate **`supabase.legacy.ts`** so legacy admin pages regain strict typings.
