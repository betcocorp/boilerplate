-- B0-921 — BEX_QUERY_REWRITE_MODEL: the model behind RAG query rewriting and intent decomposition.
--
-- Two single-shot calls in src/lib/rag/search.ts reshape the user's words before embedding:
--   query rewrite        (rewriteQueryWithLlm) — expand abbreviations, strip conversational filler
--   intent decomposition (expandQueryIntents)  — split a multi-intent ask into sub-queries
-- Both built an OpenAI client directly and called chat completions on a hardcoded `gpt-4.1-mini`,
-- with an OPENAI_QUERY_REWRITE_MODEL env override that was never set in any environment. So the
-- B0-898..908 dual-provider seam never reached the retrieval path (flipping BEX_LLM_PROVIDER to
-- anthropic did not move these calls), and a non-secret model choice lived in code and env, which
-- B0-638 forbids. Both calls now go through ~/lib/llm/structured-completion and read this row.
--
-- Read by `resolveQueryRewriteModel` (~/lib/rag/query-rewrite-model.ts) and resolved to a concrete
-- id via resolveModel (~/lib/llm/resolve-model.ts): `preview` follows the BEX_LLM_PROVIDER row's
-- per-vendor default (openai -> BEX_RESPONSES_MODEL, anthropic -> BEX_ANTHROPIC_MODEL); a gpt-* tag
-- is called on the OpenAI Responses API; a claude-* tag is the exact Claude API id and is called on
-- the Anthropic Messages API, which requires ANTHROPIC_API_KEY in env (a secret, so env not
-- settings). There is no fallback provider.
--
-- Seed value gpt-4.1-mini is behaviour-preserving (it is the id that actually ran) AND a recorded
-- decision, not an invisible hardcode — see the description below.
--
-- allowed_values is advisory metadata POST /api/admin/settings validates writes against and
-- /admin/settings renders as a select, NOT a DB constraint: the reader re-validates against
-- BEX_MODEL_TAGS (~/lib/constants/models.ts) and falls back to gpt-4.1-mini on anything
-- unrecognised, so a hand-edited row can never reach a provider as a non-existent model id.
insert into public.settings (key, value, value_type, description, allowed_values) values
  (
    'BEX_QUERY_REWRITE_MODEL',
    'gpt-4.1-mini',
    'string',
    'Model tag for the two RAG retrieval calls that reshape a query before it is embedded: query rewriting (abbreviation expansion, filler stripping) and multi-intent decomposition into sub-queries, both in src/lib/rag/search.ts (B0-921). Changing this row moves BOTH of those calls to the named model — it does not affect answer generation (BEX_RESPONSES_MODEL / BEX_ANTHROPIC_MODEL), grading (TEST_ITEM_GRADING_MODEL, REPORT_GRADING_MODEL) or embeddings. DELIBERATE MIXED-FLEET PIN: the default stays an OpenAI tag even when BEX_LLM_PROVIDER is anthropic, because query rewriting fires on every single retrieval and gpt-4.1-mini is roughly 3x cheaper and 1.8x faster than the equivalent Claude tier (claude-haiku-4-5) — the high-volume cheap tier stays on OpenAI while the answering fleet can move. That is Betco''s recorded position (Confluence Recommendation page), not a technical limitation: an admin may point this row at any tag, including preview (follow whatever BEX_LLM_PROVIDER selects) or claude-haiku-4-5, and both calls move immediately with no deploy. Must be one of BEX_MODEL_TAGS (~/lib/constants/models.ts); an unrecognised value is treated as gpt-4.1-mini. A claude-* tag is the exact Claude API id, called on the Anthropic Messages API via ~/lib/llm/structured-completion, and requires ANTHROPIC_API_KEY in env plus account credits — there is no fallback provider, though a failed rewrite degrades to the unrewritten query rather than failing the search. Replaces the hardcoded gpt-4.1-mini and the never-set OPENAI_QUERY_REWRITE_MODEL env var per B0-638.',
    array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5']
  )
on conflict (key) do nothing;
