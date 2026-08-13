import { describe, expect, it, vi } from 'vitest';

import { extractCompetitorProduct } from '~/lib/recommendations/extract-competitor-product';

describe('extractCompetitorProduct', () => {
  it('returns the extracted brand and product, stripping trademark marks and extra whitespace', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      brand: 'Spartan',
      product: 'Xtreme®  Blue Triple Foam Polish',
    });

    const out = await extractCompetitorProduct(
      'find a comparable betco product for spartan chemicals “Xtreme® Blue Triple Foam Polish”',
      { runLlm },
    );

    expect(out).toEqual({ brand: 'Spartan', product: 'Xtreme Blue Triple Foam Polish' });
    expect(runLlm).toHaveBeenCalledOnce();
  });

  it('degrades to the raw message when the LLM extraction throws', async () => {
    const runLlm = vi.fn().mockRejectedValue(new Error('llm down'));

    const out = await extractCompetitorProduct('  Diversey Glance NG glass cleaner  ', { runLlm });

    expect(out).toEqual({ brand: null, product: 'Diversey Glance NG glass cleaner' });
  });

  it('falls back to the raw message as product when no product is extracted', async () => {
    const runLlm = vi.fn().mockResolvedValue({ brand: null, product: null });

    const out = await extractCompetitorProduct('what do you recommend', { runLlm });

    expect(out).toEqual({ brand: null, product: 'what do you recommend' });
  });

  it('normalizes a blank brand to null', async () => {
    const runLlm = vi.fn().mockResolvedValue({ brand: '   ', product: 'Foam Polish' });

    const out = await extractCompetitorProduct('foam polish equivalent', { runLlm });

    expect(out).toEqual({ brand: null, product: 'Foam Polish' });
  });
});
