-- B0-1077 (epic B0-1073): soft-404-aware verification state for derived betco.com product-page
-- URLs (`rag.product_line_web_url`, B0-1074).
--
-- betco.com never returns a non-200 for a bad product page -- a missing/stale line redirects to
-- `/404/500.htm?aspxerrorpath=/ProductsDetail` and serves a ~3.9 KB body titled
-- "Betco.com 500 Error" with HTTP 200. This table is the verification-state derived from
-- `scripts/verify-product-line-web-urls.mjs` actually fetching each URL and body-sniffing the
-- result; it is NOT hand-maintained. Retrieval wiring joins this table and withholds `web_url`
-- for any row whose latest check is `soft_404`/`error` (see `fetchProductLineWebUrls` in
-- `~/lib/retrieval/document-assembly.ts`).

CREATE TABLE rag.product_line_web_url_check (
  product_line_key text PRIMARY KEY,
  web_url text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'soft_404', 'error')),
  http_status int,
  redirect_count int,
  body_bytes int,
  page_title text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE rag.product_line_web_url_check IS
  'B0-1077: soft-404-aware verification state for rag.product_line_web_url, refreshed by '
  'scripts/verify-product-line-web-urls.mjs (weekly cron: /api/v1/observability/'
  'verify-product-line-web-urls). Derived/upserted only -- never hand-edited.';

GRANT SELECT ON rag.product_line_web_url_check TO authenticated, service_role;
GRANT INSERT, UPDATE ON rag.product_line_web_url_check TO service_role;
