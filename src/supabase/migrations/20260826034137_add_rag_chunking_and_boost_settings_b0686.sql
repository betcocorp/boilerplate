-- B0-686 — settings rows for RAG corpus-quality controls (chunking strategy + metadata boosting).
--
-- /admin/products/rag/chunking previously only *generated* SQL snippets, so these knobs never
-- existed anywhere. These rows make them real and operator-tunable through the generic
-- /admin/settings page.
--
-- Defaults are deliberately INERT:
--   * RAG_CHUNK_STRATEGY = 'naive'  reproduces today's chunking byte-for-byte.
--   * RAG_BOOST_ENABLED  = 'false'  forces rag.resolve_boost_weights() to return all-zero weights,
--                                   so the match RPC ORDER BY is arithmetically unchanged.
-- Applying this migration therefore changes zero behaviour until an operator opts in.
--
-- `settings.value` is text; `value_type` has a CHECK allowing only 'boolean'|'string'|'number';
-- `allowed_values` is advisory metadata validated by the admin API, not a DB constraint.
-- `on conflict (key) do nothing` keeps re-runs from clobbering an operator's tuned value.

insert into public.settings (key, value, value_type, description, allowed_values) values
  (
    'RAG_CHUNK_STRATEGY',
    'naive',
    'string',
    'How rag.sync_legacy_product_profile_chunks splits product_line_profile documents into chunks. ''naive'' = today''s behaviour (one chunk per blank-line-separated section, no token budget). ''heading-aware'' = pack consecutive sections toward the token budget below, never merging across a heading boundary. Changing this invalidates and re-embeds every product_line_profile chunk on the next sync — a deliberate, paid operator step.',
    array['naive', 'heading-aware']
  ),
  (
    'RAG_CHUNK_MIN_TOKENS',
    '300',
    'number',
    'Target lower bound (estimated tokens, ~4 chars/token) for a heading-aware chunk. Sections are packed until the running estimate reaches this value. Ignored when RAG_CHUNK_STRATEGY = ''naive''.',
    null
  ),
  (
    'RAG_CHUNK_MAX_TOKENS',
    '600',
    'number',
    'Hard upper bound (estimated tokens, ~4 chars/token) for a heading-aware chunk. Packing never crosses it, and a single section larger than this is split into multiple chunks. Ignored when RAG_CHUNK_STRATEGY = ''naive''.',
    null
  ),
  (
    'RAG_CHUNK_OVERLAP_TOKENS',
    '50',
    'number',
    'How many tokens (~4 chars/token) of trailing text from the previous piece are repeated as a prefix when a single oversized section has to be split across several heading-aware chunks. Ignored when RAG_CHUNK_STRATEGY = ''naive''.',
    null
  ),
  (
    'RAG_BOOST_ENABLED',
    'false',
    'boolean',
    'Master switch for chunk-metadata boosting in the rag match RPCs. When false (default) rag.resolve_boost_weights() returns all-zero weights and result ordering is identical to today. The boost only ever affects the final ORDER BY — the returned `similarity` column always stays the true, unmodified cosine value.',
    null
  ),
  (
    'RAG_BOOST_SURFACE_TYPE',
    '0.10',
    'number',
    'Score bonus added to a chunk when its metadata.surface_type exactly matches the caller-supplied filter_surface_type (case-insensitive, trimmed). Requires RAG_BOOST_ENABLED.',
    null
  ),
  (
    'RAG_BOOST_DWELL_TIME',
    '0.05',
    'number',
    'Score bonus added to a chunk whose metadata carries a non-null dwell_time_minutes key (presence, not value). Requires RAG_BOOST_ENABLED.',
    null
  ),
  (
    'RAG_BOOST_DILUTION_RATIO',
    '0.05',
    'number',
    'Score bonus added to a chunk whose metadata carries a non-null dilution_ratio key (presence, not value). Requires RAG_BOOST_ENABLED.',
    null
  )
on conflict (key) do nothing;
