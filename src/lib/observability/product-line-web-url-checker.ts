/**
 * B0-1077 (epic B0-1073) — soft-404-aware classifier for derived betco.com product-page URLs
 * (`rag.product_line_web_url`, B0-1074).
 *
 * betco.com never returns a non-200 for a bad product page: a missing/stale product line
 * redirects to `/404/500.htm?aspxerrorpath=/ProductsDetail` and serves a ~3.9 KB body titled
 * "Betco.com 500 Error" with HTTP 200. A plain status-code check would call every one of those
 * "ok". `classifyProductPageResponse` is the pure decision function (no network, fully unit
 * testable); `checkProductLineWebUrl` does the actual fetch and feeds it.
 */

export type ProductLineWebUrlCheckStatus = 'ok' | 'soft_404' | 'error';

export type ProductLineWebUrlCheckResult = {
  status: ProductLineWebUrlCheckStatus;
  httpStatus: number | null;
  redirectCount: number | null;
  bodyBytes: number | null;
  pageTitle: string | null;
};

/** Live-verified 2026-09-23: good page ~106-118 KB; bad page ~3,957 bytes. Comfortably below both. */
const MIN_OK_BODY_BYTES = 20_000;

const PRODUCTS_DETAIL_PATH = '/productsdetail';

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return match ? match[1].trim() : null;
}

/**
 * Pure classification: given what a fetch actually returned, decide `ok` vs `soft_404`. Never
 * returns `error` -- that status is reserved for a fetch that threw (see `checkProductLineWebUrl`),
 * never for a response that merely looks wrong.
 *
 * `ok` requires ALL THREE:
 * - the final URL path (after following redirects) is still `/ProductsDetail` (case-insensitive)
 * - the body is bigger than the soft-404 page's ~3.9 KB (`MIN_OK_BODY_BYTES`)
 * - the page title does not contain "Error" (the soft-404 page titles itself
 *   "Betco.com 500 Error")
 */
export function classifyProductPageResponse(input: {
  finalUrl: string;
  bodyBytes: number;
  pageTitle: string | null;
}): 'ok' | 'soft_404' {
  let finalPath: string;
  try {
    finalPath = new URL(input.finalUrl).pathname.toLowerCase();
  } catch {
    return 'soft_404';
  }

  const pathOk = finalPath === PRODUCTS_DETAIL_PATH;
  const bodyOk = input.bodyBytes > MIN_OK_BODY_BYTES;
  const titleOk = !input.pageTitle || !/error/i.test(input.pageTitle);

  return pathOk && bodyOk && titleOk ? 'ok' : 'soft_404';
}

/**
 * Fetches one derived product-page URL and classifies it. Never throws: a network failure (DNS,
 * timeout, TLS, etc.) is caught and reported as `status: 'error'` so one bad URL can't take down
 * a batch run.
 */
export async function checkProductLineWebUrl(
  url: string,
  options?: { fetchImpl?: typeof fetch; userAgent?: string },
): Promise<ProductLineWebUrlCheckResult> {
  const doFetch = options?.fetchImpl ?? fetch;
  const userAgent = options?.userAgent ?? 'BexProductLinkChecker/1.0 (+https://www.betco.com)';

  try {
    const response = await doFetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': userAgent },
    });
    const body = await response.text();
    const pageTitle = extractTitle(body);
    // The Fetch API does not expose the number of hops it followed, only whether it followed
    // any (`response.redirected`) -- every observed betco.com soft-404 is exactly one hop, so 0/1
    // is the honest precision available here without re-implementing redirect-following manually.
    const redirectCount = response.redirected ? 1 : 0;
    const bodyBytes = Buffer.byteLength(body, 'utf8');

    const status = classifyProductPageResponse({
      finalUrl: response.url || url,
      bodyBytes,
      pageTitle,
    });

    return {
      status,
      httpStatus: response.status,
      redirectCount,
      bodyBytes,
      pageTitle,
    };
  } catch {
    return {
      status: 'error',
      httpStatus: null,
      redirectCount: null,
      bodyBytes: null,
      pageTitle: null,
    };
  }
}
