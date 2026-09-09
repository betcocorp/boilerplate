import { describe, expect, it } from 'vitest';

import supportedModels, {
  ANTHROPIC_GRADING_MODEL_TAGS,
  ANTHROPIC_MODEL_TAGS,
  BEX_MODEL_TAGS,
  GRADING_MODEL_TAGS,
  isAnthropicModelTag,
  isBexModelTag,
  isGradingModelTag,
  isModelEffort,
  isOpenAiModelTag,
  MODEL_DESCRIPTIONS,
  MODEL_EFFORTS,
  modelProviderFor,
  OPENAI_MODEL_TAGS,
} from './models';

/**
 * B0-908 — the Anthropic tags are tier-for-tier equivalents of the OpenAI tags and sit INSIDE
 * `BEX_MODEL_TAGS`, so every picker (chat, /admin/tests, router, validator, grader) offers them.
 * B0-806 had kept them grading-only because the other pickers fed the OpenAI Responses runtime;
 * every consumer now routes on `modelProviderFor`.
 */
describe('model tags (B0-806 / B0-908)', () => {
  it('lists the five exact Claude API ids, with no date suffix, in tier order', () => {
    expect(ANTHROPIC_MODEL_TAGS).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-5',
    ]);
    for (const tag of ANTHROPIC_MODEL_TAGS) {
      expect(tag).toMatch(/^claude-[a-z]+-\d(-\d)?$/);
      expect(modelProviderFor(tag)).toBe('anthropic');
    }
  });

  it('keeps preview first, then the gpt tags, then the Anthropic tags, with no duplicates', () => {
    expect(BEX_MODEL_TAGS[0]).toBe('preview');
    expect(BEX_MODEL_TAGS).toEqual([
      'preview',
      'gpt-4o',
      'gpt-4.1-mini',
      'gpt-4.1',
      'gpt-5.5',
      'gpt-5.6',
      ...ANTHROPIC_MODEL_TAGS,
    ]);
    expect(new Set(BEX_MODEL_TAGS).size).toBe(BEX_MODEL_TAGS.length);
    for (const tag of ANTHROPIC_MODEL_TAGS) {
      expect(isBexModelTag(tag)).toBe(true);
    }
  });

  /**
   * B0-899 — the two per-vendor subsets are what the two `preview` default rows validate against
   * (BEX_RESPONSES_MODEL → OPENAI_MODEL_TAGS, BEX_ANTHROPIC_MODEL → ANTHROPIC_MODEL_TAGS). They must
   * partition the explicit tags exactly: no tag in both, no explicit tag in neither.
   */
  it('splits the explicit tags into disjoint OpenAI and Anthropic subsets that cover BEX_MODEL_TAGS (B0-899)', () => {
    expect(OPENAI_MODEL_TAGS).toEqual(['gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6']);
    expect([...OPENAI_MODEL_TAGS, ...ANTHROPIC_MODEL_TAGS]).toEqual(
      BEX_MODEL_TAGS.filter((tag) => tag !== 'preview'),
    );
    for (const tag of OPENAI_MODEL_TAGS) {
      expect(isOpenAiModelTag(tag)).toBe(true);
      expect(isAnthropicModelTag(tag)).toBe(false);
      expect(modelProviderFor(tag)).toBe('openai');
    }
    for (const tag of ANTHROPIC_MODEL_TAGS) {
      expect(isAnthropicModelTag(tag)).toBe(true);
      expect(isOpenAiModelTag(tag)).toBe(false);
    }
    // `preview` is a member of neither: it is what the rows resolve, never what they hold.
    expect(isOpenAiModelTag('preview')).toBe(false);
    expect(isAnthropicModelTag('preview')).toBe(false);
    expect(isOpenAiModelTag('gpt-4o-mini')).toBe(false);
  });

  it('tells the picker that preview is provider-routed, naming both default rows (B0-899)', () => {
    expect(MODEL_DESCRIPTIONS.preview).toContain('BEX_LLM_PROVIDER');
    expect(MODEL_DESCRIPTIONS.preview).toContain('BEX_RESPONSES_MODEL');
    expect(MODEL_DESCRIPTIONS.preview).toContain('BEX_ANTHROPIC_MODEL');
  });

  it('collapses the grading lists onto the unified lists (compat aliases, B0-908)', () => {
    expect(GRADING_MODEL_TAGS).toEqual(BEX_MODEL_TAGS);
    expect(ANTHROPIC_GRADING_MODEL_TAGS).toEqual(ANTHROPIC_MODEL_TAGS);
    for (const tag of BEX_MODEL_TAGS) {
      expect(isGradingModelTag(tag)).toBe(true);
    }
    expect(isGradingModelTag('claude-opus-4-5')).toBe(false);
    expect(isGradingModelTag('custom')).toBe(false);
  });

  it('describes every tag with its OpenAI equivalent and rate, and offers every explicit tag in supportedModels', () => {
    expect(Object.keys(MODEL_DESCRIPTIONS).sort()).toEqual([...BEX_MODEL_TAGS].sort());
    const equivalents: Record<(typeof ANTHROPIC_MODEL_TAGS)[number], string> = {
      'claude-haiku-4-5': 'gpt-4.1-mini',
      'claude-sonnet-4-6': 'gpt-4o',
      'claude-sonnet-5': 'gpt-4.1',
      'claude-opus-4-8': 'gpt-5.5',
      'claude-opus-5': 'gpt-5.6',
    };
    for (const tag of ANTHROPIC_MODEL_TAGS) {
      expect(MODEL_DESCRIPTIONS[tag]).toContain(`Anthropic equivalent of ${equivalents[tag]}`);
      expect(MODEL_DESCRIPTIONS[tag]).toMatch(/\$\d+\.\d{2} → \$\d+\.\d{2} per Mtok/);
    }
    expect(supportedModels.map((m) => m.name)).toEqual(
      BEX_MODEL_TAGS.filter((tag) => tag !== 'preview'),
    );
    for (const model of supportedModels) {
      expect(model.label).toBe(`Model: ${model.name}`);
    }
  });

  it('routes on the claude- prefix, so a pinned Anthropic id outside the list still goes to Anthropic', () => {
    expect(modelProviderFor('claude-opus-5')).toBe('anthropic');
    expect(modelProviderFor(' Claude-Sonnet-5 ')).toBe('anthropic');
    expect(modelProviderFor('claude-opus-4-8')).toBe('anthropic');
    expect(modelProviderFor('gpt-5.6')).toBe('openai');
    expect(modelProviderFor('preview')).toBe('openai');
    expect(modelProviderFor('')).toBe('openai');
  });

  it('accepts exactly the five Anthropic effort levels', () => {
    expect(MODEL_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const effort of MODEL_EFFORTS) expect(isModelEffort(effort)).toBe(true);
    expect(isModelEffort('extreme')).toBe(false);
    expect(isModelEffort('High')).toBe(false);
  });
});
