-- B0-914 — one generation loop. Retire the `BEX_AI_SDK_GENERATION_ENABLED` selector.
--
-- The OpenAI Responses loop is gone: every turn, on every provider, now runs on the AI SDK
-- `streamText` loop (`src/lib/bex/ai-sdk-runtime.ts`). Nothing reads this row any more, and a
-- settings row nothing reads is stale config that reads as a live lever (the trap B0-638 was meant
-- to close; same reasoning as `20260902090000_retire_ai_sdk_rollout_flags.sql`).
--
-- The decision record is `src/docs/generation-runtimes.md`.
--
-- Safe to apply before or after the code deploy: the deployed pre-B0-914 build reads the row with a
-- default of `false`, so a missing row simply means "Responses loop", which is what that build
-- already does when the row is `false`. Apply AFTER the new build is live so the old build never
-- sees the row disappear mid-flight.

delete from public.settings
where key = 'BEX_AI_SDK_GENERATION_ENABLED';
