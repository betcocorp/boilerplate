import { describe, expect, it } from 'vitest';

import {
  enrichCompetitorSpec,
  type LlmCompetitorSpecFill,
} from '~/lib/websearch/enrich-competitor-spec';

const EMPTY: LlmCompetitorSpecFill = {
  chemistryClass: null,
  epaRegistration: null,
  contactTimeSeconds: null,
  dilutionOzPerGal: null,
  productCategory: null,
  primaryUse: null,
  formFactor: null,
  keyClaims: [],
  sourceUrl: null,
};

const mockLlm = (fill: Partial<LlmCompetitorSpecFill>) => ({
  runLlm: async () => ({ ...EMPTY, ...fill }),
});

const HEURISTIC_TEXT =
  'This quat-based disinfectant, EPA Reg. No. 6836-361, kills germs in 60 seconds at 2 oz per gallon.';

describe('enrichCompetitorSpec (B0-86)', () => {
  it('heuristic-only: base fields come from the deterministic extractor, new fields stay null', async () => {
    const spec = await enrichCompetitorSpec(
      { text: HEURISTIC_TEXT, sources: [{ url: 'https://mfr.example/bnc15' }] },
      mockLlm({}),
    );
    expect(spec.chemistryClass).toBe('quat');
    expect(spec.epaRegistration).toBe('6836-361');
    expect(spec.contactTimeSeconds).toBe(60);
    expect(spec.dilutionOzPerGal).toBe(2);
    expect(spec.provenance.chemistryClass).toEqual({
      source: 'heuristic',
      sourceUrl: 'https://mfr.example/bnc15',
    });
    // new fields the heuristic can't produce and the LLM didn't fill → null, no provenance
    expect(spec.productCategory).toBeNull();
    expect(spec.provenance.productCategory).toBeNull();
    expect(spec.keyClaims).toEqual([]);
  });

  it('LLM-fill: fields the heuristic left null are filled by the LLM with llm provenance', async () => {
    const spec = await enrichCompetitorSpec(
      { text: 'Some product page with no chemistry terms.', sources: [{ url: 'https://a' }] },
      mockLlm({
        chemistryClass: 'peroxide',
        productCategory: 'disinfectant',
        primaryUse: 'surface disinfection',
        keyClaims: ['kills 99.9% of germs'],
        sourceUrl: 'https://epa.example/reg',
      }),
    );
    expect(spec.chemistryClass).toBe('peroxide');
    expect(spec.provenance.chemistryClass).toEqual({ source: 'llm', sourceUrl: 'https://epa.example/reg' });
    expect(spec.productCategory).toBe('disinfectant');
    expect(spec.provenance.productCategory).toEqual({ source: 'llm', sourceUrl: 'https://epa.example/reg' });
    expect(spec.keyClaims).toEqual(['kills 99.9% of germs']);
    expect(spec.provenance.keyClaims).toEqual({ source: 'llm', sourceUrl: 'https://epa.example/reg' });
  });

  it('conflict resolution: the deterministic value wins over a conflicting LLM value', async () => {
    const spec = await enrichCompetitorSpec(
      { text: HEURISTIC_TEXT, sources: [{ url: 'https://mfr.example' }] },
      mockLlm({ chemistryClass: 'alcohol', epaRegistration: '9999-9' }),
    );
    expect(spec.chemistryClass).toBe('quat'); // heuristic wins
    expect(spec.provenance.chemistryClass?.source).toBe('heuristic');
    expect(spec.epaRegistration).toBe('6836-361'); // heuristic wins
  });

  it('never hallucinates: a field neither source resolves stays null with null provenance', async () => {
    const spec = await enrichCompetitorSpec({ text: 'nothing useful here', sources: [] }, mockLlm({}));
    expect(spec.formFactor).toBeNull();
    expect(spec.provenance.formFactor).toBeNull();
    expect(spec.dilutionOzPerGal).toBeNull();
    expect(spec.provenance.dilutionOzPerGal).toBeNull();
  });
});
