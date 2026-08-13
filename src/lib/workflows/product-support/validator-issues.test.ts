import { beforeEach, describe, expect, it, vi } from 'vitest';

const createResponse = vi.fn();

vi.mock('~/lib/openai/client', () => ({
  getOpenAIClient: () => ({ responses: { create: createResponse } }),
  resolveResponsesModel: () => 'gpt-test',
}));

import {
  partitionValidatorIssues,
  runValidatorPass,
} from '~/lib/workflows/product-support/validator';

/**
 * B0-369 — the validator's `issues` array feeds runRevisionPass, so a confirmation in there asks
 * the revision model to repair a claim that verified fine (and renders as a red finding in the
 * trace). `issues` must hold UNSUPPORTED findings only; confirmations move to `supported_claims`.
 * Partial-support findings are real and must stay in `issues`.
 */

/** Shapes a Responses-API payload the way `extractAssistantText` reads it. */
function mockValidatorOutput(payload: unknown): void {
  createResponse.mockResolvedValue({
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(payload) }],
      },
    ],
  });
}

const CONFIRMATIONS = [
  "Claim 'Dilute at ½ oz. per gallon of water (1:256) for disinfection' is supported.",
  "Claim 'Suitable for use with auto-scrubbers' is supported.",
  "Claim 'Rinse food contact surfaces with potable water after use' is supported.",
  "Claim 'Quat-Stat 5 is a one-step, hospital-grade quaternary ammonium disinfectant cleaner with a 5-minute contact time' is supported.",
];

const GENUINE_ISSUES = [
  'No evidence provided to support any claims in the draft.',
  "Claim 'kills 99.999% of viruses in 30 seconds' is not supported by the evidence summary.",
  'The dilution ratio in the draft does not appear in any provided document.',
  'PPE guidance is missing even though the SDS mentions corrosivity.',
];

const PARTIAL_SUPPORT_ISSUES = [
  "Claim 'effective against all viruses' is only partially supported: evidence confirms SARS-CoV-2 but not all viruses.",
  "Claim 'safe on all floor types' is partially supported; the label covers sealed concrete only.",
];

describe('partitionValidatorIssues', () => {
  it('moves confirmations out of issues', () => {
    const result = partitionValidatorIssues(CONFIRMATIONS);
    expect(result.issues).toEqual([]);
    expect(result.supportedClaims).toEqual(CONFIRMATIONS);
  });

  it('keeps genuinely unsupported findings in issues', () => {
    const result = partitionValidatorIssues(GENUINE_ISSUES);
    expect(result.issues).toEqual(GENUINE_ISSUES);
    expect(result.supportedClaims).toEqual([]);
  });

  it('keeps partial-support findings in issues', () => {
    const result = partitionValidatorIssues(PARTIAL_SUPPORT_ISSUES);
    expect(result.issues).toEqual(PARTIAL_SUPPORT_ISSUES);
    expect(result.supportedClaims).toEqual([]);
  });

  it('separates a mixed array without dropping any genuine finding', () => {
    const result = partitionValidatorIssues([
      CONFIRMATIONS[0],
      GENUINE_ISSUES[0],
      PARTIAL_SUPPORT_ISSUES[0],
      CONFIRMATIONS[1],
    ]);
    expect(result.issues).toEqual([GENUINE_ISSUES[0], PARTIAL_SUPPORT_ISSUES[0]]);
    expect(result.supportedClaims).toEqual([CONFIRMATIONS[0], CONFIRMATIONS[1]]);
  });
});

describe('runValidatorPass — issues channel', () => {
  beforeEach(() => {
    createResponse.mockReset();
  });

  it('returns no issues when every claim verifies, so the caller skips the revision pass', async () => {
    mockValidatorOutput({
      approved: true,
      confidence: 0.9,
      issues: CONFIRMATIONS,
      supported_claims: [],
      requires_human_review: false,
    });

    const result = await runValidatorPass({
      draftAnswer: 'draft',
      evidenceSummary: 'evidence',
    });

    expect(result.issues).toEqual([]);
    expect(result.supported_claims).toEqual(CONFIRMATIONS);
    // run-product-support-workflow.ts only revises when `!approved && issues.length > 0`.
    expect(result.approved && result.issues.length === 0).toBe(true);
  });

  it('keeps a genuinely unsupported claim as an issue and stays disapproved', async () => {
    mockValidatorOutput({
      approved: false,
      confidence: 0.3,
      issues: [GENUINE_ISSUES[0], CONFIRMATIONS[0]],
      supported_claims: [],
      requires_human_review: true,
    });

    const result = await runValidatorPass({
      draftAnswer: 'draft',
      evidenceSummary: 'evidence',
    });

    expect(result.approved).toBe(false);
    expect(result.issues).toEqual([GENUINE_ISSUES[0]]);
    expect(result.supported_claims).toEqual([CONFIRMATIONS[0]]);
  });

  it('keeps a partial-support finding as an issue', async () => {
    mockValidatorOutput({
      approved: false,
      confidence: 0.5,
      issues: [PARTIAL_SUPPORT_ISSUES[0]],
      supported_claims: [CONFIRMATIONS[2]],
      requires_human_review: true,
    });

    const result = await runValidatorPass({
      draftAnswer: 'draft',
      evidenceSummary: 'evidence',
    });

    expect(result.issues).toEqual([PARTIAL_SUPPORT_ISSUES[0]]);
    expect(result.supported_claims).toEqual([CONFIRMATIONS[2]]);
  });

  it('preserves the parse-failure fallback (hard fail, human review)', async () => {
    createResponse.mockResolvedValue({ output: [] });

    const result = await runValidatorPass({
      draftAnswer: 'draft',
      evidenceSummary: 'evidence',
    });

    expect(result.approved).toBe(false);
    expect(result.issues).toEqual(['validator_output_parse_failed']);
    expect(result.requires_human_review).toBe(true);
  });
});
