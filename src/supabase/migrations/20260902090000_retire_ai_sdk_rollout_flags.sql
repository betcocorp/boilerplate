-- B0-68 (AISDK-6) — retire the transitional Vercel AI SDK rollout gates.
--
-- Streaming and the AI Elements transcript are now unconditional in code: the stream route no
-- longer reads an enable flag, a rollout mode, or the `x-bex-streaming-cohort` header, and
-- `BexChatMessages` has only one renderer. `BEX_AI_SDK_ROUNDTRIPS_ENABLED` and
-- `NEXT_PUBLIC_BEX_STREAMING_UI_ENABLED` were already orphaned — no code has ever read them
-- (see the ORPHANED_KEYS guard in `src/lib/settings/settings-service.test.ts`).
--
-- The rows are DELETED rather than left behind: a settings row nothing reads is stale config that
-- reads as a live lever, which is exactly the trap B0-638 was meant to close.
--
-- DELIBERATELY KEPT: `BEX_AI_SDK_GENERATION_ENABLED`. Per decision record B0-378
-- (`src/docs/generation-runtimes.md`) both generation runtimes stay and the OpenAI Responses loop
-- is the canonical production default; that row is a permanent runtime selector, not a gate.

delete from public.settings
where key in (
  'BEX_AI_SDK_STREAMING_ENABLED',
  'BEX_AI_SDK_STREAMING_ROLLOUT_MODE',
  'NEXT_PUBLIC_BEX_STREAMING_UI_ENABLED',
  'NEXT_PUBLIC_BEX_STREAMING_ROLLOUT_COHORT',
  'NEXT_PUBLIC_BEX_AI_ELEMENTS_UI',
  'BEX_AI_SDK_ROUNDTRIPS_ENABLED'
);
