import { describe, expect, it, vi } from 'vitest';

import { extractCompetitorProduct } from '~/lib/recommendations/extract-competitor-product';

describe('extractCompetitorProduct', () => {
  it('returns the extracted brand and product, stripping trademark marks and extra whitespace', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      brand: 'Spartan',
      product: 'Xtreme®  Blue Triple Foam Polish',
      otherCompetitorProduct: null,
    });

    const out = await extractCompetitorProduct(
      'find a comparable betco product for spartan chemicals “Xtreme® Blue Triple Foam Polish”',
      { runLlm },
    );

    expect(out).toEqual({
      brand: 'Spartan',
      product: 'Xtreme Blue Triple Foam Polish',
      otherCompetitorProduct: null,
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
    });
  });

  it('falls back to the raw message as product when no product is extracted', async () => {
    const runLlm = vi.fn().mockResolvedValue({ brand: null, product: null, otherCompetitorProduct: null });

    const out = await extractCompetitorProduct('what do you recommend', { runLlm });

    expect(out).toEqual({ brand: null, product: 'what do you recommend', otherCompetitorProduct: null });
  });

  it('normalizes a blank brand to null', async () => {
    const runLlm = vi.fn().mockResolvedValue({ brand: '   ', product: 'Foam Polish', otherCompetitorProduct: null });

    const out = await extractCompetitorProduct('foam polish equivalent', { runLlm });

    expect(out).toEqual({ brand: null, product: 'Foam Polish', otherCompetitorProduct: null });
  });

  it('tolerates a mock response that omits otherCompetitorProduct (back-compat shape)', async () => {
    const runLlm = vi.fn().mockResolvedValue({ brand: 'Spartan', product: 'Foam Polish' });

    const out = await extractCompetitorProduct('spartan foam polish equivalent', { runLlm });

    expect(out).toEqual({ brand: 'Spartan', product: 'Foam Polish', otherCompetitorProduct: null });
  });

  it('B0-357: records the second competitor product when two are named, deterministically picking one', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      brand: 'Spartan',
      product: 'BNC-15',
      otherCompetitorProduct: 'Diversey Virex II 256',
    });

    const out = await extractCompetitorProduct(
      'What is the Betco equivalent to Spartan BNC-15? We also use Diversey Virex II 256.',
      { runLlm },
    );

    expect(out).toEqual({
      brand: 'Spartan',
      product: 'BNC-15',
      otherCompetitorProduct: 'Diversey Virex II 256',
    });
  });

  it('normalizes a blank otherCompetitorProduct to null', async () => {
    const runLlm = vi.fn().mockResolvedValue({ brand: 'Spartan', product: 'BNC-15', otherCompetitorProduct: '   ' });

    const out = await extractCompetitorProduct('spartan bnc-15', { runLlm });

    expect(out).toEqual({ brand: 'Spartan', product: 'BNC-15', otherCompetitorProduct: null });
  });
});
