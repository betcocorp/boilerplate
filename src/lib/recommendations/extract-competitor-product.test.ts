import { beforeEach, describe, expect, it, vi } from 'vitest';

// B0-904 — the model comes from the XREF_COMPETITOR_EXTRACT_MODEL settings row (default `preview`)
// through `resolveModel`; both are mocked so no test touches Supabase or a provider.
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

import {
  extractCompetitorProduct,
  isCompetitorIdentityUnresolved,
  isImplausibleCompetitorProductText,
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
      model: null,
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
      model: null,
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
      model: null,
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
      model: null,
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
      model: null,
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
      model: null,
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
      model: null,
    });
  });
});

/**
 * B0-908 — the default `runLlm` goes through the provider-neutral `completeStructuredWithUsage`, so
 * a `claude-*` id resolved for the `preview` tag is sent as-is with the same prompt + schema bytes,
 * and the helper's usage is what lands on the result.
 */
describe('extractCompetitorProduct — default runLlm (B0-908)', () => {
  beforeEach(() => {
    mockComplete.mockReset();
    mockResolveModel.mockReset();
    mockResolveModel.mockResolvedValue('claude-sonnet-5');
    settingOverrides.clear();
  });

  it('calls completeStructuredWithUsage with the resolved claude id and the competitor_extract schema', async () => {
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ brand: 'Spartan', product: 'BNC-15', otherCompetitorProduct: null }),
      usage: USAGE,
    });

    const out = await extractCompetitorProduct('betco equivalent to spartan bnc-15');

    expect(mockResolveModel).toHaveBeenCalledWith('preview');
    expect(mockComplete).toHaveBeenCalledOnce();
    const request = mockComplete.mock.calls[0][0];
    expect(request).toMatchObject({
      model: 'claude-sonnet-5',
      user: 'betco equivalent to spartan bnc-15',
      schemaName: 'competitor_extract',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          brand: { type: ['string', 'null'] },
          product: { type: ['string', 'null'] },
          otherCompetitorProduct: { type: ['string', 'null'] },
        },
        required: ['brand', 'product', 'otherCompetitorProduct'],
      },
      maxOutputTokens: 1200,
      temperature: 0,
    });
    expect(request.system).toContain('You extract the competitor cleaning/chemical product');
    // B0-904 — the identity carries the id the call was actually made with, for the workflow gate.
    expect(out).toEqual({
      brand: 'Spartan',
      product: 'BNC-15',
      otherCompetitorProduct: null,
      usage: USAGE,
      resolved: true,
      model: 'claude-sonnet-5',
    });
  });

  it('B0-904 — reads the model tag from the XREF_COMPETITOR_EXTRACT_MODEL settings row and resolves it through resolveModel', async () => {
    settingOverrides.set('XREF_COMPETITOR_EXTRACT_MODEL', 'claude-haiku-4-5');
    mockResolveModel.mockImplementation(async (tag: string) => tag);
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ brand: null, product: 'BNC-15', otherCompetitorProduct: null }),
      usage: USAGE,
    });

    const out = await extractCompetitorProduct('spartan bnc-15');

    expect(mockResolveModel).toHaveBeenCalledWith('claude-haiku-4-5');
    expect(mockComplete.mock.calls[0][0].model).toBe('claude-haiku-4-5');
    expect(out.model).toBe('claude-haiku-4-5');
  });

  it('B0-904 — a stored value outside BEX_MODEL_TAGS falls back to the preview tag (allowed_values is advisory)', async () => {
    settingOverrides.set('XREF_COMPETITOR_EXTRACT_MODEL', 'gpt-4o-mini');
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ brand: null, product: 'BNC-15', otherCompetitorProduct: null }),
      usage: USAGE,
    });

    await extractCompetitorProduct('spartan bnc-15');

    expect(mockResolveModel).toHaveBeenCalledWith('preview');
  });

  it('degrades to the raw message when the helper throws (truncation, refusal, transport)', async () => {
    mockComplete.mockRejectedValue(new Error('output truncated at max_output_tokens'));

    const out = await extractCompetitorProduct('spartan bnc-15');

    expect(out).toEqual({
      brand: null,
      product: 'spartan bnc-15',
      otherCompetitorProduct: null,
      usage: ZERO_USAGE,
      resolved: false,
      model: null,
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

describe('isImplausibleCompetitorProductText (B0-1056)', () => {
  it('rejects real user questions with no competitor product identity', () => {
    expect(
      isImplausibleCompetitorProductText('Why does the grout stay dirty even after we mop it?'),
    ).toBe(true);
    expect(
      isImplausibleCompetitorProductText(
        "I found a spec sheet online for a competitor's disinfectant. Can you find the Betco match?",
      ),
    ).toBe(true);
    expect(
      isImplausibleCompetitorProductText(
        "Which Betco product is identical to the competitor product we're using now?",
      ),
    ).toBe(true);
  });

  it('rejects empty text', () => {
    expect(isImplausibleCompetitorProductText('   ')).toBe(true);
  });

  it('accepts real, short, declarative competitor product names', () => {
    expect(isImplausibleCompetitorProductText('BNC-15')).toBe(false);
    expect(isImplausibleCompetitorProductText('Xtreme Blue Triple Foam Polish')).toBe(false);
    expect(isImplausibleCompetitorProductText('CDC-10')).toBe(false);
  });
});
