import { describe, expect, it, vi } from 'vitest';

import {
  classifyCompetitorSelfReference,
  isConversionListAsk,
  type BetcoEntityResolution,
} from '~/lib/recommendations/competitor-self-reference';

const NO_MATCH: BetcoEntityResolution = {
  productLineKey: null,
  ambiguousAlias: false,
  catalogMatch: false,
  catalogProductLineKey: null,
};

function resolverReturning(result: Partial<BetcoEntityResolution>) {
  return vi.fn(async (): Promise<BetcoEntityResolution> => ({ ...NO_MATCH, ...result }));
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

  /**
   * An alias that spans several Betco product lines (pH7Q has three EPA-registered formulations)
   * still identifies the name as OURS — the ambiguity is only about which line, which this check
   * does not need. Suppressing with a null key is the point: the original rule refused to suppress
   * here, which is why every pH7Q comparison on the 234-item set kept being forced to the
   * competitor cross-reference engine.
   */
  it('suppresses on an ambiguous alias, reporting no product line', async () => {
    expect(
      await classify({
        competitorProduct: 'pH7Q',
        resolveBetcoEntity: resolverReturning({ ambiguousAlias: true }),
      }),
    ).toEqual({
      suppressed: true,
      reason: 'betco_product',
      productLineKey: null,
      matched: 'ph7q',
    });
  });

  /** Catalog membership is the weakest tier and catches names with no alias row at all. */
  it('suppresses on catalog membership when no alias resolves', async () => {
    expect(
      await classify({
        competitorProduct: 'Grease Solv',
        resolveBetcoEntity: resolverReturning({
          catalogMatch: true,
          catalogProductLineKey: 'line-9',
        }),
      }),
    ).toEqual({
      suppressed: true,
      reason: 'betco_catalog',
      productLineKey: 'line-9',
      matched: 'grease solv',
    });
  });

  /** A named non-Betco brand settles it — never product-match past a real competitor. */
  it('does NOT suppress, or even look up, when a non-Betco brand is named', async () => {
    const resolver = resolverReturning({ catalogMatch: true });
    expect(
      await classify({
        competitorBrand: '3M',
        competitorProduct: 'Glass Cleaner',
        resolveBetcoEntity: resolver,
      }),
    ).toEqual({ suppressed: false });
    expect(resolver).not.toHaveBeenCalled();
  });

  /** A pure category description would substring-match dozens of Betco titles. */
  it('does NOT suppress on a generic category description', async () => {
    const resolver = resolverReturning({ catalogMatch: true });
    expect(
      await classify({
        competitorProduct: 'low-odor floor stripper',
        resolveBetcoEntity: resolver,
      }),
    ).toEqual({ suppressed: false });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('does NOT suppress on a blank product or a resolver rejection', async () => {
    const untouched = resolverReturning({ productLineKey: 'x' });
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
