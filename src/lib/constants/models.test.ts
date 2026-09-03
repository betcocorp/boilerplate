import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_GRADING_MODEL_TAGS,
  BEX_MODEL_TAGS,
  GRADING_MODEL_TAGS,
  isGradingModelTag,
  isModelEffort,
  MODEL_EFFORTS,
  modelProviderFor,
} from './models';

/**
 * B0-806 — the Anthropic grading tags sit beside, not inside, `BEX_MODEL_TAGS`: every non-grading
 * model picker feeds the OpenAI Responses runtime, which cannot call a Claude id.
 */
describe('grading model tags (B0-806)', () => {
  it('is the OpenAI tags plus the Anthropic tags, with the Anthropic tags kept out of BEX_MODEL_TAGS', () => {
    expect(GRADING_MODEL_TAGS).toEqual([...BEX_MODEL_TAGS, ...ANTHROPIC_GRADING_MODEL_TAGS]);
    for (const tag of ANTHROPIC_GRADING_MODEL_TAGS) {
      expect(BEX_MODEL_TAGS).not.toContain(tag);
      expect(isGradingModelTag(tag)).toBe(true);
    }
    expect(isGradingModelTag('claude-haiku-4-5')).toBe(false);
  });

  it('uses the exact Claude API ids, with no date suffix', () => {
    expect(ANTHROPIC_GRADING_MODEL_TAGS).toEqual(['claude-opus-5', 'claude-sonnet-5']);
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
