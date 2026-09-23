/**
 * B0-1077 (epic B0-1073) — orchestration shared by the cron route
 * (`/api/v1/observability/verify-product-line-web-urls`) and the standalone script
 * (`scripts/verify-product-line-web-urls.mjs`), so the two never drift: reads every row of
 * `rag.product_line_web_url` (B0-1074), checks each with `checkProductLineWebUrl`
 * (`~/lib/observability/product-line-web-url-checker.ts`) at a polite rate, and upserts the
 * verdict into `rag.product_line_web_url_check`.
 */

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import {
  checkProductLineWebUrl,
  type ProductLineWebUrlCheckResult,
} from '~/lib/observability/product-line-web-url-checker';

export type ProductLineWebUrlVerificationRow = {
  productLineKey: string;
  webUrl: string;
  result: ProductLineWebUrlCheckResult;
};

export type ProductLineWebUrlVerificationSummary = {
  checked: number;
  ok: number;
  soft404: number;
  error: number;
  /** `prod_line_id`/`product_line_key` of every row that did not classify `ok`, for the printed report. */
  failing: Array<{ productLineKey: string; webUrl: string; status: 'soft_404' | 'error' }>;
};

const RATE_LIMIT_DELAY_MS = 550; // ~1.8 req/s, comfortably under the ≤2 req/s ceiling.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Typed escape hatch: neither `rag.product_line_web_url` nor `..._check` are in the generated
 * Supabase types yet (see `~/lib/retrieval/document-assembly.ts`'s `fetchProductLineWebUrls` for
 * the same situation and why). */
type LooseRagClient = {
  from(table: string): {
    select(cols: string): Promise<{
      data: Array<{ product_line_key: string; web_url: string }> | null;
      error: { message: string } | null;
    }>;
    upsert(
      row: Record<string, unknown>,
      options: { onConflict: string },
    ): Promise<{ error: { message: string } | null }>;
  };
};

export async function runProductLineWebUrlVerification(options?: {
  onProgress?: (row: ProductLineWebUrlVerificationRow) => void;
  fetchImpl?: typeof fetch;
}): Promise<ProductLineWebUrlVerificationSummary> {
  const rag = getSupabaseServiceRoleClient().schema('rag') as unknown as LooseRagClient;

  const { data, error } = await rag.from('product_line_web_url').select('product_line_key, web_url');
  if (error) {
    throw new Error(`Failed to read rag.product_line_web_url: ${error.message}`);
  }

  const rows = data ?? [];
  const summary: ProductLineWebUrlVerificationSummary = {
    checked: 0,
    ok: 0,
    soft404: 0,
    error: 0,
    failing: [],
  };

  for (const [index, row] of rows.entries()) {
    if (index > 0) {
      // Polite rate limit: sequential, not fired concurrently.
      await sleep(RATE_LIMIT_DELAY_MS);
    }

    const result = await checkProductLineWebUrl(row.web_url, { fetchImpl: options?.fetchImpl });
    summary.checked += 1;
    if (result.status === 'ok') {
      summary.ok += 1;
    } else {
      summary[result.status === 'soft_404' ? 'soft404' : 'error'] += 1;
      summary.failing.push({
        productLineKey: row.product_line_key,
        webUrl: row.web_url,
        status: result.status,
      });
    }

    const { error: upsertError } = await rag.from('product_line_web_url_check').upsert(
      {
        product_line_key: row.product_line_key,
        web_url: row.web_url,
        status: result.status,
        http_status: result.httpStatus,
        redirect_count: result.redirectCount,
        body_bytes: result.bodyBytes,
        page_title: result.pageTitle,
        checked_at: new Date().toISOString(),
      },
      { onConflict: 'product_line_key' },
    );
    if (upsertError) {
      throw new Error(
        `Failed to upsert rag.product_line_web_url_check for ${row.product_line_key}: ${upsertError.message}`,
      );
    }

    options?.onProgress?.({ productLineKey: row.product_line_key, webUrl: row.web_url, result });
  }

  return summary;
}
