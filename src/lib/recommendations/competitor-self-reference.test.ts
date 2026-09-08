import { describe, expect, it, vi } from 'vitest';

import {
  classifyCompetitorSelfReference,
  findBetcoSelfReferenceWebResult,
  isBetcoHost,
  isConversionListAsk,
  isGenericChemistryDescription,
  splitBetcoLinePrefix,
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

/**
 * B0-875 — P#8: "a Diversey quat disinfectant" was cross-referenced to a fuzzy legacy row. A
 * chemistry class plus product-class words is a description, not a product identity, whether or
 * not a brand accompanies it.
 */
describe('generic chemistry description (B0-875)', () => {
  it.each([
    'quat disinfectant',
    'quaternary disinfectant',
    'neutral quat disinfectant',
    'bleach cleaner',
    'peroxide cleaner',
    'hydrogen peroxide disinfectant',
    'enzyme digester',
    'acid bowl cleaner',
    'a quat based disinfectant',
  ])('recognises "%s"', (product) => {
    expect(isGenericChemistryDescription(product)).toBe(true);
  });

  it.each(['bleach', 'quats', 'spartan quat disinfectant', 'virex ii 256', 'bnc-15', 'glass cleaner'])(
    'does NOT recognise "%s" (bare chemistry, a named product, or a non-chemistry category)',
    (product) => {
      expect(isGenericChemistryDescription(product)).toBe(false);
    },
  );

  it('suppresses "Diversey" + "quat disinfectant" with the description as the matched text, no lookup', async () => {
    const resolver = resolverReturning(NO_MATCH);
    const verdict = await classify({
      userMessage: 'I need a Betco replacement for a Diversey quat disinfectant. Which one?',
      competitorBrand: 'Diversey',
      competitorProduct: 'quat disinfectant',
      resolveBetcoEntity: resolver,
    });
    expect(verdict).toEqual({
      suppressed: true,
      reason: 'generic_chemistry_description',
      productLineKey: null,
      matched: 'diversey quat disinfectant',
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('is NOT vetoed by a false B0-786 bare-chemistry signal — a different question than the signal answers', async () => {
    const verdict = await classify({
      competitorBrand: 'Diversey',
      competitorProduct: 'quat disinfectant',
      competitorIsGenericChemistry: false,
    });
    expect(verdict).toMatchObject({ suppressed: true, reason: 'generic_chemistry_description' });
  });

  it('still lets the signal decide the BARE chemistry case', async () => {
    expect(
      await classify({ competitorProduct: 'bleach', competitorIsGenericChemistry: false }),
    ).toEqual({ suppressed: false });
    expect(
      await classify({ competitorProduct: 'sodium hypochlorite solution', competitorIsGenericChemistry: true }),
    ).toMatchObject({ suppressed: true, reason: 'chemistry_term' });
  });

  /**
   * B0-887 — the actual reported bug: `analyzeTurnSignals`'s `competitorIsGenericChemistry` field is
   * documented as "a bare chemistry rather than a product", but was observed coming back `true` for
   * "quat disinfectant" too. Before the fix, a TRUE signal short-circuited straight to
   * `reason: 'chemistry_term'` (`chemistry = product`) without ever reaching this deterministic
   * shape check, so "Diversey quat disinfectant" recommended a specific Betco product (with a
   * dilution ratio) instead of asking which competitor product was meant.
   */
  it('is not short-circuited to chemistry_term by a TRUE B0-786 signal for a "<chemistry> <product class>" shape', async () => {
    const verdict = await classify({
      userMessage: 'I need a Betco replacement for a Diversey quat disinfectant. Which one?',
      competitorBrand: 'Diversey',
      competitorProduct: 'quat disinfectant',
      competitorIsGenericChemistry: true,
    });
    expect(verdict).toEqual({
      suppressed: true,
      reason: 'generic_chemistry_description',
      productLineKey: null,
      matched: 'diversey quat disinfectant',
    });
  });

  it('keeps "Spartan Quat Disinfectant" (brand inside the product string) on the cross-reference path', async () => {
    expect(
      await classify({
        competitorBrand: 'Spartan',
        competitorProduct: 'Spartan Quat Disinfectant',
      }),
    ).toEqual({ suppressed: false });
  });
});

/**
 * B0-876 — P#19: "GE Fight Bac RTU" resolved as competitor brand "GE", product "Fight Bac RTU".
 * GE is Betco's Green Earth product line (28 document / 26 entity titles start with "GE ").
 */
describe('Betco line prefix (B0-876)', () => {
  it('splits the prefix off the brand slot or the product string, never past a real brand', () => {
    expect(splitBetcoLinePrefix('ge', 'fight bac rtu')).toEqual({
      prefix: 'ge',
      name: 'fight bac rtu',
      full: 'ge fight bac rtu',
    });
    expect(splitBetcoLinePrefix('', 'ge fight bac rtu')).toEqual({
      prefix: 'ge',
      name: 'fight bac rtu',
      full: 'ge fight bac rtu',
    });
    expect(splitBetcoLinePrefix('green earth', 'green earth daily disinfectant')).toEqual({
      prefix: 'green earth',
      name: 'daily disinfectant',
      full: 'green earth daily disinfectant',
    });
    expect(splitBetcoLinePrefix('spartan', 'ge something')).toBeNull();
    expect(splitBetcoLinePrefix('', 'gentle cleaner')).toBeNull();
  });

  it('suppresses "GE" + "Fight Bac RTU" via the catalog when the rest of the name resolves', async () => {
    const resolver = resolverReturning({ catalogMatch: true, catalogProductLineKey: null });
    const verdict = await classify({
      userMessage: 'Is GE Fight Bac RTU approved for use in my state?',
      competitorBrand: 'GE',
      competitorProduct: 'Fight Bac RTU',
      resolveBetcoEntity: resolver,
    });
    expect(verdict).toEqual({
      suppressed: true,
      reason: 'betco_catalog',
      productLineKey: null,
      matched: 'ge fight bac rtu',
    });
    expect(resolver).toHaveBeenCalledWith('fight bac rtu');
  });

  it('suppresses on the prefix alone when the alias/catalog lookups miss or fail', async () => {
    expect(
      await classify({
        competitorBrand: null,
        competitorProduct: 'GE Fight Bac RTU',
        resolveBetcoEntity: resolverReturning(NO_MATCH),
      }),
    ).toEqual({
      suppressed: true,
      reason: 'betco_catalog',
      productLineKey: null,
      matched: 'ge fight bac rtu',
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      await classify({
        competitorBrand: 'Green Earth',
        competitorProduct: 'Daily Disinfectant',
        resolveBetcoEntity: vi.fn(async () => {
          throw new Error('alias table unavailable');
        }),
      }),
    ).toMatchObject({ suppressed: true, reason: 'betco_catalog', matched: 'green earth daily disinfectant' });
    warn.mockRestore();
  });

  it('reports the product line when the rest of the name resolves unambiguously', async () => {
    expect(
      await classify({
        competitorBrand: 'GE',
        competitorProduct: 'Fight Bac RTU',
        resolveBetcoEntity: resolverReturning({ productLineKey: 'B332DBA3', ambiguousAlias: false }),
      }),
    ).toEqual({
      suppressed: true,
      reason: 'betco_product',
      productLineKey: 'B332DBA3',
      matched: 'ge fight bac rtu',
    });
  });

  it('does NOT treat a genuine competitor as Betco', async () => {
    expect(
      await classify({
        competitorBrand: 'Spartan',
        competitorProduct: 'BNC-15',
        resolveBetcoEntity: resolverReturning({ catalogMatch: true }),
      }),
    ).toEqual({ suppressed: false });
  });
});

describe('betco.com self-reference in web results (B0-876)', () => {
  it('recognises betco.com and its subdomains only', () => {
    expect(isBetcoHost('https://www.betco.com/products/ge-fight-bac-rtu-canada')).toBe(true);
    expect(isBetcoHost('https://betco.com/')).toBe(true);
    expect(isBetcoHost('https://www.spartanchemical.com/betco-comparison')).toBe(false);
    expect(isBetcoHost('https://notbetco.com/')).toBe(false);
    expect(isBetcoHost('not a url')).toBe(false);
  });

  it('flags only the TOP result', () => {
    const betco = { url: 'https://www.betco.com/products/ge-fight-bac-rtu-canada', title: 'GE Fight Bac™ RTU Disinfectant (Canada)' };
    const other = { url: 'https://example.com/spec', title: 'Spec' };
    expect(findBetcoSelfReferenceWebResult([betco, other])).toBe(betco);
    expect(findBetcoSelfReferenceWebResult([other, betco])).toBeNull();
    expect(findBetcoSelfReferenceWebResult([])).toBeNull();
  });
});
