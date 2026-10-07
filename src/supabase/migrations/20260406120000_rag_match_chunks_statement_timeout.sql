-- Allow similarity search to finish when the planner scans/joins a large corpus.
-- Tune down if you tighten the query or add a more selective ANN strategy.
alter function rag.match_product_chunks(
  extensions.vector(1536),
  integer,
  text,
  text
)
set statement_timeout = '120s';
