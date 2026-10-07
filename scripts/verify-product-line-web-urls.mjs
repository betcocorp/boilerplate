#!/usr/bin/env -S npx tsx
/**
 * B0-1077 (epic B0-1073) — soft-404-aware verification of derived betco.com product-page URLs.
 *
 * betco.com never returns a non-200 for a bad product page: a missing/stale line redirects to
 * `/404/500.htm?aspxerrorpath=/ProductsDetail` and serves a ~3.9 KB body titled
 * "Betco.com 500 Error" with HTTP 200. This script fetches every URL in
 * `rag.product_line_web_url` (B0-1074) with `redirect: 'follow'`, classifies each with the shared
 * `checkProductLineWebUrl` / `classifyProductPageResponse` (`~/lib/observability/
 * product-line-web-url-checker.ts`), and upserts the verdict into
 * `rag.product_line_web_url_check` (B0-1077) so retrieval can withhold dead links.
 *
 * This imports `~/lib/...ts` modules via the app's path alias, so — like
 * `scripts/ingest-fastdraw-dilution.mjs` — it must run under `tsx`, not plain `node`.
 *
 * Usage (repo root, requires NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in
 * `.env.local`):
 *   npx tsx --env-file=.env.local scripts/verify-product-line-web-urls.mjs
 *
 * Exit codes: 0 every checked URL is `ok`; 1 one or more URLs are `soft_404`/`error`, or the run
 * itself failed (e.g. could not read the view) -- either way a scheduled run should be noticed.
 */

import { runProductLineWebUrlVerification } from '~/lib/observability/verify-product-line-web-urls.ts';

async function main() {
  console.log('Verifying rag.product_line_web_url ...');

  const summary = await runProductLineWebUrlVerification({
    onProgress: ({ productLineKey, result }) => {
      if (result.status !== 'ok') {
        console.log(`  [${result.status}] ${productLineKey} (http=${result.httpStatus ?? 'n/a'})`);
      }
    },
  });

  console.log('');
  console.log(
    `Checked ${summary.checked}: ${summary.ok} ok, ${summary.soft404} soft_404, ${summary.error} error`,
  );
  if (summary.failing.length > 0) {
    console.log('');
    console.log('Failing lines:');
    for (const failure of summary.failing) {
      console.log(`  ${failure.status.padEnd(9)} ${failure.productLineKey}  ${failure.webUrl}`);
    }
  }

  if (summary.soft404 > 0 || summary.error > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('verify-product-line-web-urls failed:', err);
  process.exitCode = 1;
});
