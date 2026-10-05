import { describe, expect, it } from 'vitest';

import {
  CURRENT_GENERATION_RUNTIME,
  GENERATION_RUNTIME_LABELS,
  certainGenerationRuntimeForModel,
  generationRuntimeLabel,
  generationRuntimeRationale,
  isGenerationRuntime,
} from './generation-runtime';

describe('CURRENT_GENERATION_RUNTIME (B0-914)', () => {
  it('is the AI SDK loop: the only generation loop there is', () => {
    expect(CURRENT_GENERATION_RUNTIME).toBe('ai_sdk');
    expect(isGenerationRuntime(CURRENT_GENERATION_RUNTIME)).toBe(true);
  });
});

describe('certainGenerationRuntimeForModel', () => {
  it('settles a legacy Anthropic run as the AI SDK loop', () => {
    expect(certainGenerationRuntimeForModel('claude-opus-5')).toBe('ai_sdk');
  });

  it('leaves a legacy OpenAI run unknown rather than guessing which loop served it', () => {
    expect(certainGenerationRuntimeForModel('gpt-4.1')).toBeNull();
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

  it('states the same one-loop rationale for every vendor', () => {
    expect(generationRuntimeRationale('claude-opus-5')).toContain('AI SDK loop');
    expect(generationRuntimeRationale('gpt-4.1')).toContain('AI SDK loop');
    expect(generationRuntimeRationale('gpt-4.1')).not.toContain('BEX_AI_SDK_GENERATION_ENABLED');
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
