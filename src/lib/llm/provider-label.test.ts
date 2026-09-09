import { describe, expect, it } from 'vitest';

import supportedModels, { BEX_MODEL_TAGS } from '~/lib/constants/models';
import {
  groupModelsByProvider,
  isModelProvider,
  providerLabel,
  providerLabelForModel,
} from '~/lib/llm/provider-label';

describe('providerLabel (B0-905)', () => {
  it('names both vendors', () => {
    expect(providerLabel('openai')).toBe('OpenAI');
    expect(providerLabel('anthropic')).toBe('Anthropic');
  });

  it('derives the vendor from a tag or a resolved model id', () => {
    expect(providerLabelForModel('gpt-4.1')).toBe('OpenAI');
    expect(providerLabelForModel('gpt-5.5-2026-04-23')).toBe('OpenAI');
    expect(providerLabelForModel('claude-sonnet-5')).toBe('Anthropic');
    expect(providerLabelForModel('claude-opus-4-8-20260501')).toBe('Anthropic');
  });

  it('recognises only the two provider ids', () => {
    expect(isModelProvider('openai')).toBe(true);
    expect(isModelProvider('anthropic')).toBe(true);
    expect(isModelProvider('OpenAI')).toBe(false);
    expect(isModelProvider('')).toBe(false);
    expect(isModelProvider(null)).toBe(false);
    expect(isModelProvider('toString')).toBe(false);
  });
});

describe('groupModelsByProvider (B0-905)', () => {
  it('splits supportedModels into OpenAI then Anthropic, preserving order and losing nothing', () => {
    const groups = groupModelsByProvider(supportedModels);

    expect(groups.map((g) => g.label)).toEqual(['OpenAI', 'Anthropic']);
    expect(groups.flatMap((g) => g.models.map((m) => m.name))).toEqual(
      supportedModels.map((m) => m.name),
    );
    expect(groups[0]!.models.every((m) => !m.name.startsWith('claude-'))).toBe(true);
    expect(groups[1]!.models.every((m) => m.name.startsWith('claude-'))).toBe(true);
    // `preview` is not a supportedModels entry; pickers render it above the groups.
    expect(groups.flatMap((g) => g.models.map((m) => m.name))).not.toContain('preview');
    expect(BEX_MODEL_TAGS).toContain('preview');
  });

  it('omits a vendor with no models rather than rendering an empty heading', () => {
    expect(groupModelsByProvider([{ name: 'gpt-4.1' }])).toEqual([
      { provider: 'openai', label: 'OpenAI', models: [{ name: 'gpt-4.1' }] },
    ]);
    expect(groupModelsByProvider([])).toEqual([]);
  });
});
