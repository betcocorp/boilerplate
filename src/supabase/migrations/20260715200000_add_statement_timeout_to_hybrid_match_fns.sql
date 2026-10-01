-- Add statement_timeout + search_path to the hybrid corpus/product match RPCs.
--
-- The non-hybrid rag.match_corpus_chunks already sets `statement_timeout=60s` and
-- `search_path`, but the *_hybrid variants had no per-function config (pg_proc.proconfig
-- was null), so they inherited the caller role's 8s statement_timeout (authenticated /
-- authenticator = 8s). A broad scope='all' hybrid query (BM25 over the full corpus +
-- ANN with a large candidate pull + rerank) measured ~8.7s at match_count=20, so it
-- intermittently failed with "canceling statement due to statement timeout" — the
-- broad/unanchored retrieval path in lib/retrieval/product-knowledge.ts uses
-- match_corpus_chunks_hybrid, so this surfaced as intermittent retrieval failures.
--
-- This only changes execution limits + name-resolution scope; the function bodies are
-- untouched. (Latency itself — the ~8.7s runtime — is tracked separately as tuning work.)

alter function rag.match_corpus_chunks_hybrid(halfvec, text, integer, text, text, text)
  set statement_timeout = '60s'
  set search_path to 'rag', 'extensions', 'public';

alter function rag.match_product_chunks_hybrid(halfvec, text, integer, text, text)
  set statement_timeout = '60s'
  set search_path to 'rag', 'extensions', 'public';

alter function rag.match_product_chunks_hybrid(halfvec, text, integer, text, text, text)
  set statement_timeout = '60s'
  set search_path to 'rag', 'extensions', 'public';
