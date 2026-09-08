import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-908 — `runValidatorPass` and `runRevisionPass` no longer call `client.responses.create`; both
 * go through `~/lib/llm/structured-completion`, which routes on the resolved model id (`claude-*`
 * to Anthropic, else OpenAI). These tests pin what the validator owns: the same prompt bytes, schema
 * and transport knobs regardless of provider, usage carried through unchanged, and the helper's
 * truncated/refused errors taking the validator's existing failure paths instead of failing the
 * turn. (`validator-issues.test.ts` still exercises the OpenAI provider end to end through the
 * helper by mocking the OpenAI client itself.)
 */
const completeStructuredMock = vi.fn();
const completeTextMock = vi.fn();
vi.mock('~/lib/llm/structured-completion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/llm/structured-completion')>();
  return {
    ...actual,
    completeStructuredWithUsage: (...args: unknown[]) => completeStructuredMock(...args),
    completeTextWithUsage: (...args: unknown[]) => completeTextMock(...args),
  };
});

const settingOverrides = new Map<string, string>();
vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: vi.fn((key: string, fallback: string) =>
    Promise.resolve(settingOverrides.get(key) ?? fallback),
  ),
}));

import {
  StructuredOutputRefusedError,
  StructuredOutputTruncatedError,
} from '~/lib/llm/structured-completion';
import {
  DEFAULT_BEX_VALIDATOR_MODEL_TAG,
  REVISION_SYSTEM_PROMPT,
  resolveValidatorModelTag,
  runRevisionPass,
  runValidatorPass,
} from '~/lib/workflows/product-support/validator';
import { VALIDATOR_SYSTEM_PROMPT } from '~/lib/workflows/product-support/product-support-prompts';

const USAGE = { promptTokens: 120, completionTokens: 40, totalTokens: 160, cachedPromptTokens: 0 };
const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 };

const APPROVED = {
  approved: true,
  confidence: 0.9,
  issues: [],
  supported_claims: ['Claim A is supported.'],
  requires_human_review: false,
};

type StructuredRequest = {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  temperature?: number;
  requestOptions?: { maxRetries?: number; timeoutMs?: number };
};

function structuredCall(index = 0): StructuredRequest {
  return completeStructuredMock.mock.calls[index]?.[0] as StructuredRequest;
}

function textCall(index = 0): Omit<StructuredRequest, 'schemaName' | 'schema'> {
  return completeTextMock.mock.calls[index]?.[0] as Omit<StructuredRequest, 'schemaName' | 'schema'>;
}

beforeEach(() => {
  completeStructuredMock.mockReset();
  completeTextMock.mockReset();
  settingOverrides.clear();
  // `preview` resolves through the BEX_RESPONSES_MODEL row; pin it so the default path is stable.
  settingOverrides.set('BEX_RESPONSES_MODEL', 'gpt-4.1-mini');
});

describe('resolveValidatorModelTag — B0-908 accepts Anthropic tags', () => {
  it('honors a stored claude-* tag and still rejects a non-tag value', async () => {
    settingOverrides.set('BEX_VALIDATOR_MODEL', 'claude-sonnet-5');
    expect(await resolveValidatorModelTag()).toBe('claude-sonnet-5');

    settingOverrides.set('BEX_VALIDATOR_MODEL', 'gpt-4o-mini');
    expect(await resolveValidatorModelTag()).toBe(DEFAULT_BEX_VALIDATOR_MODEL_TAG);
  });
});

describe('runValidatorPass — provider-neutral structured call', () => {
  it('sends the validator prompt, payload and strict schema through the helper and returns its usage', async () => {
    completeStructuredMock.mockResolvedValue({ text: JSON.stringify(APPROVED), usage: USAGE });

    const result = await runValidatorPass({ draftAnswer: 'draft', evidenceSummary: 'evidence' });

    expect(completeStructuredMock).toHaveBeenCalledTimes(1);
    const call = structuredCall();
    expect(call.model).toBe('gpt-4.1-mini');
    expect(call.system).toBe(VALIDATOR_SYSTEM_PROMPT);
    expect(call.user).toBe(JSON.stringify({ draft: 'draft', evidence_summary: 'evidence' }));
    expect(call.schemaName).toBe('validation_result');
    expect(call.schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys(call.schema.properties as object)).toEqual([
      'approved',
      'confidence',
      'issues',
      'supported_claims',
      'requires_human_review',
    ]);
    expect(call.temperature).toBe(0);
    expect(call.maxOutputTokens).toBeGreaterThan(0);
    expect(call.requestOptions).toEqual({ maxRetries: 0, timeoutMs: 60_000 });

    expect(result.approved).toBe(true);
    expect(result.supported_claims).toEqual(['Claim A is supported.']);
    expect(result.usage).toEqual(USAGE);
  });

  it('passes the resolved claude-sonnet-5 id when BEX_VALIDATOR_MODEL holds that tag (helper routes to Anthropic)', async () => {
    settingOverrides.set('BEX_VALIDATOR_MODEL', 'claude-sonnet-5');
    completeStructuredMock.mockResolvedValue({ text: JSON.stringify(APPROVED), usage: USAGE });

    await runValidatorPass({ draftAnswer: 'draft', evidenceSummary: 'evidence' });

    expect(structuredCall().model).toBe('claude-sonnet-5');
    // Same bytes as the OpenAI case: the provider difference lives entirely inside the helper.
    expect(structuredCall().system).toBe(VALIDATOR_SYSTEM_PROMPT);
    expect(structuredCall().schemaName).toBe('validation_result');
    expect(structuredCall().temperature).toBe(0);
  });

  it('an explicit modelTag wins over the settings row', async () => {
    settingOverrides.set('BEX_VALIDATOR_MODEL', 'claude-sonnet-5');
    completeStructuredMock.mockResolvedValue({ text: JSON.stringify(APPROVED), usage: USAGE });

    await runValidatorPass({ draftAnswer: 'draft', evidenceSummary: 'evidence', modelTag: 'gpt-4.1' });

    expect(structuredCall().model).toBe('gpt-4.1');
  });

  it('keeps the parse-failure fallback (hard fail, human review) with the call usage on an unparseable answer', async () => {
    completeStructuredMock.mockResolvedValue({ text: 'not json', usage: USAGE });

    const result = await runValidatorPass({ draftAnswer: 'draft', evidenceSummary: 'evidence' });

    expect(result).toEqual({
      approved: false,
      confidence: 0,
      issues: ['validator_output_parse_failed'],
      requires_human_review: true,
      usage: USAGE,
    });
  });

  it('treats a truncated structured answer like a parse failure instead of failing the turn', async () => {
    completeStructuredMock.mockRejectedValue(new StructuredOutputTruncatedError());

    const result = await runValidatorPass({ draftAnswer: 'draft', evidenceSummary: 'evidence' });

    expect(result.approved).toBe(false);
    expect(result.issues).toEqual(['validator_output_parse_failed']);
    expect(result.requires_human_review).toBe(true);
    expect(result.usage).toEqual(ZERO);
  });

  it('treats an Anthropic refusal like a parse failure instead of failing the turn', async () => {
    settingOverrides.set('BEX_VALIDATOR_MODEL', 'claude-sonnet-5');
    completeStructuredMock.mockRejectedValue(new StructuredOutputRefusedError('policy', 'declined'));

    const result = await runValidatorPass({ draftAnswer: 'draft', evidenceSummary: 'evidence' });

    expect(result.issues).toEqual(['validator_output_parse_failed']);
    expect(result.requires_human_review).toBe(true);
  });

  it('still propagates a non-output error (a 4xx from the provider is not a validator verdict)', async () => {
    completeStructuredMock.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));

    await expect(
      runValidatorPass({ draftAnswer: 'draft', evidenceSummary: 'evidence' }),
    ).rejects.toThrow('bad request');
  });
});

describe('runRevisionPass — provider-neutral free-text call', () => {
  it('sends the revision prompt and payload through the free-text helper and returns text + usage', async () => {
    completeTextMock.mockResolvedValue({ text: 'revised answer', usage: USAGE });

    const result = await runRevisionPass({
      draftAnswer: 'draft',
      validatorIssues: ['issue 1'],
      evidenceSummary: 'evidence',
    });

    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(completeStructuredMock).not.toHaveBeenCalled();
    const call = textCall();
    expect(call.model).toBe('gpt-4.1-mini');
    expect(call.system).toBe(REVISION_SYSTEM_PROMPT);
    expect(call.user).toBe(
      JSON.stringify({ draft: 'draft', issues: ['issue 1'], evidence_summary: 'evidence' }),
    );
    expect(call.temperature).toBe(0.2);
    expect(call.requestOptions).toEqual({ maxRetries: 0, timeoutMs: 60_000 });
    expect(result).toEqual({ text: 'revised answer', usage: USAGE });
  });

  it('passes a claude-sonnet-5 modelTag through unchanged so the helper takes the Anthropic path', async () => {
    completeTextMock.mockResolvedValue({ text: 'revised', usage: USAGE });

    await runRevisionPass({
      draftAnswer: 'draft',
      validatorIssues: [],
      evidenceSummary: 'evidence',
      modelTag: 'claude-sonnet-5',
    });

    expect(textCall().model).toBe('claude-sonnet-5');
  });

  it('returns empty text on a refusal, which the workflow already reads as "revision refused, keep the draft"', async () => {
    completeTextMock.mockRejectedValue(new StructuredOutputRefusedError(null, null));

    const result = await runRevisionPass({
      draftAnswer: 'draft',
      validatorIssues: ['issue 1'],
      evidenceSummary: 'evidence',
    });

    expect(result).toEqual({ text: '', usage: ZERO });
  });
});
