import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveToolTimeoutMs,
  ToolTimeoutError,
  withToolTimeout,
} from '~/lib/tools/tool-timeouts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveToolTimeoutMs', () => {
  it('honours a named tool override ahead of the global timeout', () => {
    vi.stubEnv('BEX_TOOL_TIMEOUT_MS', '40');
    vi.stubEnv('BEX_TOOL_TIMEOUT_MS_SEARCH_PRODUCT_DOCS', '25');

    expect(resolveToolTimeoutMs('search_product_docs')).toBe(25);
  });

  it('keeps the known-slow cross-reference pipeline above the global setting', () => {
    vi.stubEnv('BEX_TOOL_TIMEOUT_MS', '40');

    expect(resolveToolTimeoutMs('recommend_cross_reference')).toBe(120_000);
  });
});

describe('withToolTimeout', () => {
  it('returns a completed tool result unchanged', async () => {
    await expect(withToolTimeout(Promise.resolve({ ok: true }), 'search_product_docs', 10)).resolves.toEqual({
      ok: true,
    });
  });

  it('rejects with a typed timeout error when a tool does not settle in time', async () => {
    const never = new Promise<never>(() => {});

    await expect(withToolTimeout(never, 'search_product_docs', 1)).rejects.toEqual(
      expect.objectContaining({ name: 'ToolTimeoutError', timeoutMs: 1 }),
    );

    await expect(withToolTimeout(never, 'search_product_docs', 1)).rejects.toBeInstanceOf(
      ToolTimeoutError,
    );
  });
});
