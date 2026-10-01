import { describe, expect, it, vi } from 'vitest';

import {
  checkProductLineWebUrl,
  classifyProductPageResponse,
} from '~/lib/observability/product-line-web-url-checker';

/**
 * B0-1077 — betco.com never returns a non-200 for a bad product page: a missing/stale line
 * redirects to `/404/500.htm` and serves a ~3.9 KB body titled "Betco.com 500 Error" with HTTP
 * 200. These tests cover the AC's five classifier scenarios: ok, soft-404-by-redirect,
 * soft-404-by-title, small-body, and a network-level error -- entirely via mocked `fetch`, no
 * live network call.
 */

const GOOD_URL = 'https://www.betco.com/ProductsDetail?productID=CA352FDA-543F-4D28-BB61-371247F351D4';
const GOOD_BODY = `<html><head><title>Fight Bac RTU</title></head><body>${'x'.repeat(110_000)}</body></html>`;
const SOFT_404_BODY =
  '<html><head><title>Betco.com 500 Error</title></head><body><h1>Something Went Wrong</h1></body></html>';

function fakeResponse(input: {
  url: string;
  redirected: boolean;
  status?: number;
  body: string;
}): Response {
  return {
    url: input.url,
    redirected: input.redirected,
    status: input.status ?? 200,
    text: async () => input.body,
  } as unknown as Response;
}

describe('classifyProductPageResponse (B0-1077)', () => {
  it('ok: /ProductsDetail path, large body, no "Error" in title', () => {
    expect(
      classifyProductPageResponse({
        finalUrl: GOOD_URL,
        bodyBytes: 110_000,
        pageTitle: 'Fight Bac RTU',
      }),
    ).toBe('ok');
  });

  it('soft_404 by redirect: final path is /404/500.htm, not /ProductsDetail', () => {
    expect(
      classifyProductPageResponse({
        finalUrl: 'https://www.betco.com/404/500.htm?aspxerrorpath=/ProductsDetail',
        bodyBytes: 3_957,
        pageTitle: 'Betco.com 500 Error',
      }),
    ).toBe('soft_404');
  });

  it('soft_404 by title: same path, but the title says "Error"', () => {
    expect(
      classifyProductPageResponse({
        finalUrl: GOOD_URL,
        bodyBytes: 110_000,
        pageTitle: 'Betco.com 500 Error',
      }),
    ).toBe('soft_404');
  });

  it('soft_404 by small body: right path and title, but body is too small', () => {
    expect(
      classifyProductPageResponse({
        finalUrl: GOOD_URL,
        bodyBytes: 3_957,
        pageTitle: 'Fight Bac RTU',
      }),
    ).toBe('soft_404');
  });

  it('never classifies as "error" -- that status is reserved for a thrown fetch', () => {
    // A completely malformed final URL still degrades to soft_404, not error.
    expect(
      classifyProductPageResponse({ finalUrl: 'not a url', bodyBytes: 110_000, pageTitle: 'x' }),
    ).toBe('soft_404');
  });
});

describe('checkProductLineWebUrl (B0-1077)', () => {
  it('classifies a good page as ok and reports its metadata', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ url: GOOD_URL, redirected: false, body: GOOD_BODY }));

    const result = await checkProductLineWebUrl(GOOD_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.status).toBe('ok');
    expect(result.httpStatus).toBe(200);
    expect(result.redirectCount).toBe(0);
    expect(result.pageTitle).toBe('Fight Bac RTU');
    expect(fetchImpl).toHaveBeenCalledWith(
      GOOD_URL,
      expect.objectContaining({ redirect: 'follow' }),
    );
  });

  it('classifies a redirected soft-404 page as soft_404', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        url: 'https://www.betco.com/404/500.htm?aspxerrorpath=/ProductsDetail',
        redirected: true,
        body: SOFT_404_BODY,
      }),
    );

    const result = await checkProductLineWebUrl('https://www.betco.com/ProductsDetail?productID=H619', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe('soft_404');
    expect(result.redirectCount).toBe(1);
    expect(result.pageTitle).toBe('Betco.com 500 Error');
  });

  it('classifies a thrown fetch (network failure) as error, never throwing itself', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });

    const result = await checkProductLineWebUrl('https://www.betco.com/ProductsDetail?productID=X', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe('error');
    expect(result.httpStatus).toBeNull();
    expect(result.bodyBytes).toBeNull();
  });

  it('sends a recognisable User-Agent', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ url: GOOD_URL, redirected: false, body: GOOD_BODY }));

    await checkProductLineWebUrl(GOOD_URL, { fetchImpl: fetchImpl as unknown as typeof fetch });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/BexProductLinkChecker/);
  });
});
