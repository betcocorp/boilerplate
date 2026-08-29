import { describe, expect, it, vi } from 'vitest';

import {
  classifyCompetitorSelfReference,
  isConversionListAsk,
  type BetcoEntityResolution,
} from '~/lib/recommendations/competitor-self-reference';

const NO_MATCH: BetcoEntityResolution = { productLineKey: null, ambiguousAlias: false };

function resolverReturning(result: BetcoEntityResolution) {
  return vi.fn(async (): Promise<BetcoEntityResolution> => result);
}

async function classify(
  overrides: Partial<Parameters<typeof classifyCompetitorSelfReference>[0]> = {},
) {
  return classifyCompetitorSelfReference({
    userMessage: 'What is the Betco equivalent to Diversey Virex II 256?',
    competitorBrand: null,
    competitorProduct: null,
    resolveBetcoEntity: resolverReturning(NO_MATCH),
    ...overrides,
  });
}

describe('classifyCompetitorSelfReference (B0-751)', () => {
  it('suppresses a whole-catalog conversion-list ask before anything else', async () => {
    const resolver = resolverReturning({ productLineKey: 'line-1', ambiguousAlias: false });
    const verdict = await classify({
      userMessage:
        'Our distributor asked for a full cross-reference list for their Spartan conversion',
      competitorBrand: 'Spartan',
      competitorProduct: 'Spartan',
      resolveBetcoEntity: resolver,
    });
    expect(verdict).toMatchObject({ suppressed: true, reason: 'conversion_list_ask' });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('recognises the other conversion-list phrasings, and none of the single-product asks', () => {
    expect(isConversionListAsk('Can you send a complete conversion list for Diversey?')).toBe(true);
    expect(isConversionListAsk('We need to cross-reference their whole catalog to Betco.')).toBe(
      true,
    );
    expect(isConversionListAsk('What is the Betco equivalent to Diversey Virex II 256?')).toBe(
      false,
    );
    expect(isConversionListAsk('Cross reference Spartan BNC-15 for me')).toBe(false);
    expect(isConversionListAsk('Is Speedex the same thing as Speedex Concentrate?')).toBe(false);
  });

  it('suppresses when the "competitor" brand is Betco or a Betco sub-brand', async () => {
    for (const brand of ['Betco', ' betco ', 'Basic Coatings', 'EnviroZyme', '1950']) {
      const verdict = await classify({
        userMessage: 'Give me a cheaper alternative to Grease Solv.',
        competitorBrand: brand,
        competitorProduct: 'Grease Solv',
      });
      expect(verdict, brand).toMatchObject({ suppressed: true, reason: 'betco_brand' });
    }
  });

  it('suppresses a bare chemistry name, whole-string only', async () => {
    const bleach = await classify({
      userMessage: 'What do you have that replaces bleach?',
      competitorProduct: 'bleach',
    });
    expect(bleach).toMatchObject({ suppressed: true, reason: 'chemistry_term', matched: 'bleach' });

    const quat = await classify({
      userMessage: 'We banned quats, what do we switch to?',
      competitorProduct: 'a quat',
    });
    expect(quat).toMatchObject({ suppressed: true, reason: 'chemistry_term', matched: 'quat' });

    // A real competitor product that merely CONTAINS a chemistry word is not a chemistry ask.
    const spartanQuat = await classify({
      userMessage: 'What is the Betco equivalent to Spartan Quat Disinfectant?',
      competitorBrand: 'Spartan',
      competitorProduct: 'Spartan Quat Disinfectant',
    });
    expect(spartanQuat).toEqual({ suppressed: false });
  });

  it('suppresses when the competitor product resolves unambiguously to a Betco product line', async () => {
    const resolver = resolverReturning({ productLineKey: 'speedex-line', ambiguousAlias: false });
    const verdict = await classify({
      userMessage: 'Is Speedex the same thing as Speedex Concentrate?',
      competitorProduct: 'Speedex®',
      resolveBetcoEntity: resolver,
    });
    expect(verdict).toEqual({
      suppressed: true,
      reason: 'betco_product',
      productLineKey: 'speedex-line',
      matched: 'speedex',
    });
    expect(resolver).toHaveBeenCalledWith('speedex');
  });

  it('does NOT suppress a genuine competitor', async () => {
    const resolver = resolverReturning(NO_MATCH);
    expect(
      await classify({
        competitorBrand: 'Diversey',
        competitorProduct: 'Virex II 256',
        resolveBetcoEntity: resolver,
      }),
    ).toEqual({ suppressed: false });
    expect(
      await classify({
        userMessage: "What's the Betco equivalent to Spartan Xtreme Blue?",
        competitorBrand: 'Spartan',
        competitorProduct: 'Spartan Xtreme Blue',
        resolveBetcoEntity: resolver,
      }),
    ).toEqual({ suppressed: false });
  });

  it('does NOT suppress on an ambiguous alias, a blank product, or a resolver rejection', async () => {
    expect(
      await classify({
        competitorProduct: 'Grease Solv',
        resolveBetcoEntity: resolverReturning({ productLineKey: null, ambiguousAlias: true }),
      }),
    ).toEqual({ suppressed: false });

    const untouched = resolverReturning({ productLineKey: 'x', ambiguousAlias: false });
    expect(await classify({ competitorProduct: '   ', resolveBetcoEntity: untouched })).toEqual({
      suppressed: false,
    });
    expect(untouched).not.toHaveBeenCalled();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      await classify({
        competitorProduct: 'Virex II 256',
        resolveBetcoEntity: vi.fn(async () => {
          throw new Error('alias table unavailable');
        }),
      }),
    ).toEqual({ suppressed: false });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('treats the extraction fallback (product = whole message) as not a Betco product', async () => {
    // `extractCompetitorProduct` degrades to `{ brand: null, product: <whole message> }`; the
    // freeform resolver returns no lock for a sentence, so the verdict must stay open.
    const message = 'Why is my VCT flooring dull after stripping?';
    const resolver = resolverReturning(NO_MATCH);
    expect(
      await classify({ userMessage: message, competitorProduct: message, resolveBetcoEntity: resolver }),
    ).toEqual({ suppressed: false });
    expect(resolver).toHaveBeenCalledWith(message.toLowerCase());
  });
});
