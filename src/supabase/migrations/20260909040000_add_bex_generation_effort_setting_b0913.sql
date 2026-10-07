-- B0-913 — BEX_GENERATION_EFFORT: how hard an Anthropic model thinks while GENERATING an answer.
--
-- Measured driver (two paired eval runs, 2026-09-08, 106 generation steps each, from the
-- cost_by_model_per_day view):
--                  gpt-5.6     claude-opus-5   ratio
--   prompt tok     3,559,899   5,317,677       1.49x
--   completion       68,276      141,693       2.08x
--   cached prompt  1,364,629    1,229,476      38% vs 23%
--   cost              $13.71       $24.60      1.79x
-- Claude Opus 5 is the CHEAPER model per output token ($25.00 vs $30.00 per Mtok in
-- public.model_pricing) and identical on input, so the 1.79x is our own inefficiency. Anthropic
-- bills adaptive thinking tokens as output, and generation had no effort control at all — grading
-- did (REPORT_GRADING_EFFORT, TEST_ITEM_GRADING_EFFORT), the answering path did not, so the only
-- way to trade depth for spend was to change model.
--
-- Read by `loadGenerationEffort` (~/lib/bex/generation-effort.ts) and forwarded by
-- `runAiSdkWithToolLoop` (~/lib/bex/ai-sdk-runtime.ts) as providerOptions.anthropic.effort, which
-- @ai-sdk/anthropic 3.0.116 emits as output_config.effort. Anthropic-only by construction: every
-- claude-* generation runs on the AI SDK loop (B0-908) and the OpenAI branch of that loop is gated
-- on provider, so an OpenAI run never reads this row. It is additionally gated on
-- `supportsAnthropicAdaptiveThinking` (~/lib/llm/structured-completion.ts) — Haiku-class and older
-- Claude ids reject both adaptive thinking and output_config.effort with a 400.
--
-- Seeded 'provider_default', a sentinel meaning "send no effort field at all". That is the exact
-- pre-B0-913 wire behaviour, so applying this migration changes nothing until an admin picks a
-- level. Anthropic documents 'high' as equivalent to omitting effort, but the sentinel makes the
-- default a provable no-op (byte-identical request body) rather than a claim about the server.
--
-- allowed_values is advisory metadata POST /api/admin/settings validates writes against and
-- /admin/settings renders as a select, NOT a DB constraint (only value_type has a CHECK): the
-- reader re-validates against MODEL_EFFORTS and falls back to the sentinel on anything else.
insert into public.settings (key, value, value_type, description, allowed_values) values
  (
    'BEX_GENERATION_EFFORT',
    'provider_default',
    'string',
    'Anthropic output_config.effort for ANSWER GENERATION when the chat model is a claude-* tag (B0-913): how much the model thinks before it answers. Sent as providerOptions.anthropic.effort on the AI SDK generation loop, which every claude-* run uses (B0-908). OpenAI models never see it. provider_default (the seeded value) sends no effort field at all — Anthropic''s own default applies, which is the pre-B0-913 behaviour, so this row is a no-op until changed. low/medium cut completion tokens (Anthropic bills adaptive thinking as output; a 106-case eval on 2026-09-08 measured claude-opus-5 at 2.08x gpt-5.6''s completion volume); xhigh/max buy depth for cost and wall clock. Ignored for Haiku-class and older Claude ids, which reject output_config.effort with a 400 (supportsAnthropicAdaptiveThinking, ~/lib/llm/structured-completion.ts). An unrecognised value is treated as provider_default. Lowering this trades answer quality for cost on the REGULATED product-support path — re-run the golden set before treating a change as free.',
    array['provider_default', 'low', 'medium', 'high', 'xhigh', 'max']
  )
on conflict (key) do nothing;
