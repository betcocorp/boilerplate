import { describe, expect, it } from 'vitest';

import {
  GENERATION_RUNTIME_LABELS,
  certainGenerationRuntimeForModel,
  generationRuntimeLabel,
  generationRuntimeRationale,
  isGenerationRuntime,
  selectGenerationRuntime,
} from './generation-runtime';

describe('selectGenerationRuntime (B0-912)', () => {
  it('forces the AI SDK loop for an Anthropic model, whatever the flag says', () => {
    // The OpenAI Responses loop throws on a `claude-*` id by design, so this is not a preference.
    expect(
      selectGenerationRuntime({ model: 'claude-opus-5', aiSdkGenerationSetting: false }),
    ).toBe('ai_sdk');
    expect(
      selectGenerationRuntime({ model: 'claude-opus-5', aiSdkGenerationSetting: true }),
    ).toBe('ai_sdk');
  });

  it('keeps an OpenAI model on the canonical Responses loop while the flag is off', () => {
    expect(selectGenerationRuntime({ model: 'gpt-4.1', aiSdkGenerationSetting: false })).toBe(
      'responses',
    );
  });

  it('lets the flag opt an OpenAI model into the AI SDK loop', () => {
    expect(selectGenerationRuntime({ model: 'gpt-4.1', aiSdkGenerationSetting: true })).toBe(
      'ai_sdk',
    );
  });

  it('reproduces the 2026-09-08 mismatch: one paired comparison, two different loops', () => {
    const aiSdkGenerationSetting = false;
    expect(selectGenerationRuntime({ model: 'gpt-4.1', aiSdkGenerationSetting })).toBe('responses');
    expect(selectGenerationRuntime({ model: 'claude-opus-5', aiSdkGenerationSetting })).toBe(
      'ai_sdk',
    );
  });

  it('routes a pinned Anthropic id outside the tag list by prefix, not by list membership', () => {
    expect(
      selectGenerationRuntime({
        model: 'claude-some-unreleased-id',
        aiSdkGenerationSetting: false,
      }),
    ).toBe('ai_sdk');
  });
});

describe('isGenerationRuntime', () => {
  it('accepts only the two known runtimes', () => {
    expect(isGenerationRuntime('responses')).toBe(true);
    expect(isGenerationRuntime('ai_sdk')).toBe(true);
    expect(isGenerationRuntime('ai-sdk')).toBe(false);
    expect(isGenerationRuntime('')).toBe(false);
    expect(isGenerationRuntime(undefined)).toBe(false);
    expect(isGenerationRuntime(42)).toBe(false);
  });
});

describe('labels and rationale', () => {
  it('names each loop', () => {
    expect(generationRuntimeLabel('responses')).toBe(GENERATION_RUNTIME_LABELS.responses);
    expect(generationRuntimeLabel('ai_sdk')).toBe(GENERATION_RUNTIME_LABELS.ai_sdk);
  });

  it('explains why each vendor got the loop it got', () => {
    expect(generationRuntimeRationale('claude-opus-5')).toContain('Anthropic');
    expect(generationRuntimeRationale('gpt-4.1')).toContain('BEX_AI_SDK_GENERATION_ENABLED');
  });
});

describe('certainGenerationRuntimeForModel (B0-912, historical runs)', () => {
  it('settles an Anthropic run — it can only have been the AI SDK loop', () => {
    expect(certainGenerationRuntimeForModel('claude-opus-5')).toBe('ai_sdk');
  });

  it('refuses to settle an OpenAI run — its loop followed a flag value from the time', () => {
    expect(certainGenerationRuntimeForModel('gpt-4.1')).toBeNull();
    expect(certainGenerationRuntimeForModel('gpt-5.6')).toBeNull();
  });
});
