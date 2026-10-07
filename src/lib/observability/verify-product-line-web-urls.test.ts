import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import { runProductLineWebUrlVerification } from '~/lib/observability/verify-product-line-web-urls';

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

/**
 * B0-1077 — orchestration wiring: reads `rag.product_line_web_url`, checks each row, and upserts
 * into `rag.product_line_web_url_check`. Uses a fake, instant `setTimeout` isn't needed since the
 * rate-limit delay is short-circuited by `vi.useFakeTimers` in tests that care about call order,
 * and otherwise just asserted directly (no real network — `fetchImpl` is always stubbed).
 */

type ViewRow = { product_line_key: string; web_url: string };

function installStub(viewRows: ViewRow[]) {
  const upserts: Array<{ row: Record<string, unknown>; options: unknown }> = [];
  const upsert = vi.fn((row: Record<string, unknown>, options: unknown) => {
    upserts.push({ row, options });
    return Promise.resolve({ error: null });
  });

  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    schema: () => ({
      from: (table: string) => {
        if (table === 'product_line_web_url') {
          return { select: () => Promise.resolve({ data: viewRows, error: null }) };
        }
        if (table === 'product_line_web_url_check') {
          return { upsert };
        }
        throw new Error(`unexpected table ${table}`);
      },
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);

  return { upserts, upsert };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runProductLineWebUrlVerification (B0-1077)', () => {
  it('checks every row, upserts each verdict, and summarises ok/soft_404/error counts', async () => {
    const { upserts } = installStub([
      { product_line_key: '311', web_url: 'https://www.betco.com/ProductsDetail?productID=A' },
      { product_line_key: 'H619', web_url: 'https://www.betco.com/ProductsDetail?productID=B' },
    ]);

    const responses: Record<string, Response> = {
      'https://www.betco.com/ProductsDetail?productID=A': {
        url: 'https://www.betco.com/ProductsDetail?productID=A',
        redirected: false,
        status: 200,
        text: async () => `<title>Ok</title>${'x'.repeat(30_000)}`,
      } as unknown as Response,
      'https://www.betco.com/ProductsDetail?productID=B': {
        url: 'https://www.betco.com/404/500.htm',
        redirected: true,
        status: 200,
        text: async () => '<title>Betco.com 500 Error</title>',
      } as unknown as Response,
    };
    const fetchImpl = vi.fn(async (url: string) => responses[url]);

    const summary = await runProductLineWebUrlVerification({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(summary.checked).toBe(2);
    expect(summary.ok).toBe(1);
    expect(summary.soft404).toBe(1);
    expect(summary.error).toBe(0);
    expect(summary.failing).toEqual([
      { productLineKey: 'H619', webUrl: 'https://www.betco.com/ProductsDetail?productID=B', status: 'soft_404' },
    ]);

    expect(upserts).toHaveLength(2);
    expect(upserts[0].row).toMatchObject({ product_line_key: '311', status: 'ok' });
    expect(upserts[1].row).toMatchObject({ product_line_key: 'H619', status: 'soft_404' });
    expect(upserts[0].options).toEqual({ onConflict: 'product_line_key' });
  }, 10_000);

  it('throws when the view itself cannot be read (surfaced by the caller as a failed run)', async () => {
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
      schema: () => ({
        from: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
      }),
    } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);

    await expect(runProductLineWebUrlVerification()).rejects.toThrow(/boom/);
  });

  it('returns a clean zero summary when the view has no rows', async () => {
    installStub([]);
    const summary = await runProductLineWebUrlVerification();
    expect(summary).toEqual({ checked: 0, ok: 0, soft404: 0, error: 0, failing: [] });
  });
});
