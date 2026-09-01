import { describe, expect, it, vi } from 'vitest';

import {
  extractCompetitorProduct,
  isCompetitorIdentityUnresolved,
} from '~/lib/recommendations/extract-competitor-product';

const USAGE = { promptTokens: 120, completionTokens: 18, totalTokens: 138, cachedPromptTokens: 0 };
const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 };

describe('extractCompetitorProduct', () => {
  it('returns the extracted brand and product, stripping trademark marks and extra whitespace', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      parsed: {
        brand: 'Spartan',
        product: 'Xtreme®  Blue Triple Foam Polish',
        otherCompetitorProduct: null,
      },
      usage: USAGE,
    });

    const out = await extractCompetitorProduct(
      'find a comparable betco product for spartan chemicals “Xtreme® Blue Triple Foam Polish”',
      { runLlm },
    );

    expect(out).toEqual({
      brand: 'Spartan',
      product: 'Xtreme Blue Triple Foam Polish',
      otherCompetitorProduct: null,
      usage: USAGE,
      resolved: true,
    });
    expect(runLlm).toHaveBeenCalledOnce();
  });

  it('degrades to the raw message when the LLM extraction throws', async () => {
    const runLlm = vi.fn().mockRejectedValue(new Error('llm down'));

    const out = await extractCompetitorProduct('  Diversey Glance NG glass cleaner  ', { runLlm });

    expect(out).toEqual({
      brand: null,
      product: 'Diversey Glance NG glass cleaner',
      otherCompetitorProduct: null,
      usage: ZERO_USAGE,
      resolved: false,
    });
  });

  it('falls back to the raw message as product when no product is extracted, and reports unresolved (B0-779)', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      parsed: { brand: null, product: null, otherCompetitorProduct: null },
      usage: USAGE,
    });

    const out = await extractCompetitorProduct('what do you recommend', { runLlm });

    expect(out).toEqual({
      brand: null,
      product: 'what do you recommend',
      otherCompetitorProduct: null,
      usage: USAGE,
      resolved: false,
    });
    expect(isCompetitorIdentityUnresolved(out)).toBe(true);
  });

  it('normalizes a blank brand to null', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      parsed: { brand: '   ', product: 'Foam Polish', otherCompetitorProduct: null },
      usage: USAGE,
    });

    const out = await extractCompetitorProduct('foam polish equivalent', { runLlm });

    expect(out).toEqual({
      brand: null,
      product: 'Foam Polish',
      otherCompetitorProduct: null,
      usage: USAGE,
      resolved: true,
    });
    // A confidently-extracted product with no brand is still resolved (AC: no change to the
    // confident-match path) — only "no brand AND no resolved product" counts as unresolved.
    expect(isCompetitorIdentityUnresolved(out)).toBe(false);
  });

  it('tolerates a mock response that omits otherCompetitorProduct (back-compat shape)', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      parsed: { brand: 'Spartan', product: 'Foam Polish' },
      usage: USAGE,
    });

    const out = await extractCompetitorProduct('spartan foam polish equivalent', { runLlm });

    expect(out).toEqual({
      brand: 'Spartan',
      product: 'Foam Polish',
      otherCompetitorProduct: null,
      usage: USAGE,
      resolved: true,
    });
  });

  it('B0-357: records the second competitor product when two are named, deterministically picking one', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      parsed: {
        brand: 'Spartan',
        product: 'BNC-15',
        otherCompetitorProduct: 'Diversey Virex II 256',
      },
      usage: USAGE,
    });

    const out = await extractCompetitorProduct(
      'What is the Betco equivalent to Spartan BNC-15? We also use Diversey Virex II 256.',
      { runLlm },
    );

    expect(out).toEqual({
      brand: 'Spartan',
      product: 'BNC-15',
      otherCompetitorProduct: 'Diversey Virex II 256',
      usage: USAGE,
      resolved: true,
    });
  });

  it('normalizes a blank otherCompetitorProduct to null', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      parsed: { brand: 'Spartan', product: 'BNC-15', otherCompetitorProduct: '   ' },
      usage: USAGE,
    });

    const out = await extractCompetitorProduct('spartan bnc-15', { runLlm });

    expect(out).toEqual({
      brand: 'Spartan',
      product: 'BNC-15',
      otherCompetitorProduct: null,
      usage: USAGE,
      resolved: true,
    });
  });
});

describe('isCompetitorIdentityUnresolved (B0-779)', () => {
  it('is true with no brand and no resolved product (PRO-045/PRO-036 shape)', () => {
    expect(isCompetitorIdentityUnresolved({ brand: null, resolved: false })).toBe(true);
  });

  it('is false when a brand was identified even without a confident product', () => {
    expect(isCompetitorIdentityUnresolved({ brand: 'Spartan', resolved: false })).toBe(false);
  });

  it('is false when a product was confidently resolved even without a brand', () => {
    expect(isCompetitorIdentityUnresolved({ brand: null, resolved: true })).toBe(false);
  });

  it('is false when both a brand and a resolved product are present', () => {
    expect(isCompetitorIdentityUnresolved({ brand: 'Spartan', resolved: true })).toBe(false);
  });
});
