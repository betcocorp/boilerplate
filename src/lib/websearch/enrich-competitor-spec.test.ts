import { beforeEach, describe, expect, it, vi } from 'vitest';

// B0-904 — the model comes from the XREF_SPEC_ENRICH_MODEL settings row (default `preview`) through
// `resolveModel`; both are mocked so no test touches Supabase or a provider.
const { mockComplete, mockResolveModel, settingOverrides } = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockResolveModel: vi.fn(async (tag: string) => (tag === 'preview' ? 'gpt-test' : tag)),
  settingOverrides: new Map<string, string>(),
}));
vi.mock('~/lib/llm/structured-completion', () => ({
  completeStructuredWithUsage: mockComplete,
}));
vi.mock('~/lib/llm/resolve-model', () => ({
  resolveModel: mockResolveModel,
}));
vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: vi.fn((key: string, fallback: string) =>
    Promise.resolve(settingOverrides.get(key) ?? fallback),
  ),
}));
vi.mock('~/lib/workflows/product-support/max-output-tokens', () => ({
  resolveMaxOutputTokens: () => 1200,
}));

import { wrapUntrustedWebEvidence } from '~/lib/recommendations/recommendation-guardrails';
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
  manufacturer: null,
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
        manufacturer: 'Spartan Chemical',
        sourceUrl: 'https://epa.example/reg',
      }),
    );
    expect(spec.chemistryClass).toBe('peroxide');
    expect(spec.provenance.chemistryClass).toEqual({ source: 'llm', sourceUrl: 'https://epa.example/reg' });
    expect(spec.productCategory).toBe('disinfectant');
    expect(spec.provenance.productCategory).toEqual({ source: 'llm', sourceUrl: 'https://epa.example/reg' });
    expect(spec.keyClaims).toEqual(['kills 99.9% of germs']);
    expect(spec.provenance.keyClaims).toEqual({ source: 'llm', sourceUrl: 'https://epa.example/reg' });
    // B0-1055 — manufacturer is LLM-only (no heuristic extractor), so it always carries llm provenance.
    expect(spec.manufacturer).toBe('Spartan Chemical');
    expect(spec.provenance.manufacturer).toEqual({ source: 'llm', sourceUrl: 'https://epa.example/reg' });
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
    expect(spec.manufacturer).toBeNull();
    expect(spec.provenance.manufacturer).toBeNull();
  });
});

/**
 * B0-908 — the default `runLlm` goes through the provider-neutral `completeStructuredWithUsage`, so
 * a `claude-*` id resolved for the `preview` tag is sent as-is, with the same fenced (B0-91) user
 * payload and strict schema the OpenAI call carried. Any failure still degrades to heuristic-only.
 */
describe('enrichCompetitorSpec — default runLlm (B0-908)', () => {
  const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 };
  const TEXT = 'Some product page with no chemistry terms.';
  const SOURCES = [{ url: 'https://a', title: 'A' }];

  beforeEach(() => {
    mockComplete.mockReset();
    mockResolveModel.mockReset();
    mockResolveModel.mockResolvedValue('claude-sonnet-5');
    settingOverrides.clear();
  });

  it('B0-904 — reads the model tag from the XREF_SPEC_ENRICH_MODEL settings row and resolves it through resolveModel', async () => {
    settingOverrides.set('XREF_SPEC_ENRICH_MODEL', 'claude-haiku-4-5');
    mockResolveModel.mockImplementation(async (tag: string) => tag);
    mockComplete.mockResolvedValue({ text: JSON.stringify(EMPTY), usage: USAGE });

    await enrichCompetitorSpec({ text: TEXT, sources: SOURCES });

    expect(mockResolveModel).toHaveBeenCalledWith('claude-haiku-4-5');
    expect(mockComplete.mock.calls[0][0].model).toBe('claude-haiku-4-5');
  });

  it('B0-904 — a stored value outside BEX_MODEL_TAGS falls back to the preview tag (allowed_values is advisory)', async () => {
    settingOverrides.set('XREF_SPEC_ENRICH_MODEL', 'gpt-4o-mini');
    mockComplete.mockResolvedValue({ text: JSON.stringify(EMPTY), usage: USAGE });

    await enrichCompetitorSpec({ text: TEXT, sources: SOURCES });

    expect(mockResolveModel).toHaveBeenCalledWith('preview');
  });

  it('calls completeStructuredWithUsage with the resolved claude id, fenced content and the fill schema', async () => {
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ ...EMPTY, productCategory: 'disinfectant', sourceUrl: 'https://a' }),
      usage: USAGE,
    });

    const spec = await enrichCompetitorSpec({ text: TEXT, sources: SOURCES });

    expect(mockResolveModel).toHaveBeenCalledWith('preview');
    expect(mockComplete).toHaveBeenCalledOnce();
    const request = mockComplete.mock.calls[0][0];
    expect(request).toMatchObject({
      model: 'claude-sonnet-5',
      user: JSON.stringify({ content: wrapUntrustedWebEvidence(TEXT), sources: SOURCES }),
      schemaName: 'competitor_spec_fill',
      maxOutputTokens: 1200,
      temperature: 0,
    });
    expect(request.system).toContain('You extract a structured cleaning-product spec');
    expect(request.schema.required).toEqual([
      'chemistryClass',
      'epaRegistration',
      'contactTimeSeconds',
      'dilutionOzPerGal',
      'productCategory',
      'primaryUse',
      'formFactor',
      'keyClaims',
      'manufacturer',
      'sourceUrl',
    ]);
    expect(request.schema.additionalProperties).toBe(false);
    expect(spec.productCategory).toBe('disinfectant');
    expect(spec.provenance.productCategory).toEqual({ source: 'llm', sourceUrl: 'https://a' });
  });

  it('degrades to heuristic-only when the helper throws', async () => {
    mockComplete.mockRejectedValue(new Error('model refused the request'));

    const spec = await enrichCompetitorSpec({ text: HEURISTIC_TEXT, sources: SOURCES });

    expect(spec.chemistryClass).toBe('quat');
    expect(spec.productCategory).toBeNull();
    expect(spec.keyClaims).toEqual([]);
  });
});
