import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-886 — the revision pass must be a targeted EDIT, not a full rewrite, and its output must
 * never leak a meta-commentary preamble ("Revised Answer:", "Here is a revised answer...") into
 * the user-facing text. This file exercises `runRevisionPass`'s plumbing (does it hand back the
 * model's text unmangled, minus a stripped preamble?) and the small pure helpers
 * (`stripRevisionPreamble`, `isOnlyRegulatedClaimIssues`) directly.
 */

const createMock = vi.fn();

vi.mock('~/lib/openai/client', () => ({
  getOpenAIClient: () => ({ responses: { create: (...args: unknown[]) => createMock(...args) } }),
  resolveResponsesModel: () => 'gpt-test',
}));
vi.mock('~/lib/openai/model-capabilities', () => ({
  samplingParamsFor: () => ({}),
}));
vi.mock('~/lib/openai/response-item-parsing', () => ({
  extractAssistantText: (res: { output_text: string }) => res.output_text,
}));
vi.mock('~/lib/openai/transport-retry', () => ({
  resolveOpenAiRequestTimeoutMs: () => 1000,
  retryTransportFaults: (fn: () => unknown) => fn(),
}));
vi.mock('~/lib/workflows/product-support/max-output-tokens', () => ({
  resolveMaxOutputTokens: () => 1024,
}));
vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: async (_key: string, fallback: string) => fallback,
  getBooleanSetting: async (_key: string, fallback: boolean) => fallback,
  // B0-899 — resolveRevisionModel goes through resolveModel, whose `preview` branch reads this.
  getLlmProvider: async () => 'openai' as const,
}));

import {
  isOnlyRegulatedClaimIssues,
  runRevisionPass,
  stripRevisionPreamble,
} from '~/lib/workflows/product-support/validator';

function mockModelOutput(text: string) {
  createMock.mockResolvedValue({ output_text: text, usage: null });
}

const EIGHT_BULLET_DRAFT = [
  '- Bullet one: dilute at 1:10 per the label.',
  '- Bullet two: wear gloves and eye protection.',
  '- Bullet three: apply with a microfiber cloth.',
  '- Bullet four: allow a 10-minute dwell time.',
  '- Bullet five: rinse with clean water afterward.',
  '- Bullet six: store away from direct sunlight.',
  '- Bullet seven: kills 99.9% of common bacteria.', // <- the flagged claim
  '- Bullet eight: Source: pH7Q Dual label.',
].join('\n');

beforeEach(() => {
  createMock.mockReset();
});

describe('runRevisionPass', () => {
  it('returns the model text verbatim (minus a preamble) so an edit-only response keeps unflagged bullets intact', async () => {
    const editedBullet = '- Bullet seven: effective against common bacteria per the label.';
    const revisedDraft = EIGHT_BULLET_DRAFT.replace(
      '- Bullet seven: kills 99.9% of common bacteria.',
      editedBullet,
    );
    mockModelOutput(revisedDraft);

    const result = await runRevisionPass({
      draftAnswer: EIGHT_BULLET_DRAFT,
      validatorIssues: ['Bullet seven overstates efficacy beyond the evidence summary.'],
      evidenceSummary: 'pH7Q Dual label: effective against common bacteria.',
    });

    const otherBullets = EIGHT_BULLET_DRAFT.split('\n').filter(
      (line) => !line.includes('Bullet seven'),
    );
    for (const bullet of otherBullets) {
      expect(result.text).toContain(bullet);
    }
    expect(result.text).toContain(editedBullet);
    expect(result.text).not.toContain('kills 99.9%');
  });

  it('strips a leading "Revised Answer:" preamble from the model output', async () => {
    mockModelOutput('Revised Answer:\n\nUse 2 oz per gallon of water.');

    const result = await runRevisionPass({
      draftAnswer: 'Use 3 oz per gallon of water.',
      validatorIssues: ['dilution not supported'],
      evidenceSummary: 'Use 2 oz per gallon of water.',
    });

    expect(result.text).toBe('Use 2 oz per gallon of water.');
  });

  it('strips a leading "Here is a revised answer...:" preamble from the model output', async () => {
    mockModelOutput(
      'Here is a revised answer based only on the provided evidence:\nUse 2 oz per gallon of water.',
    );

    const result = await runRevisionPass({
      draftAnswer: 'Use 3 oz per gallon of water.',
      validatorIssues: ['dilution not supported'],
      evidenceSummary: 'Use 2 oz per gallon of water.',
    });

    expect(result.text).toBe('Use 2 oz per gallon of water.');
  });
});

describe('stripRevisionPreamble', () => {
  it('strips "Revised Answer:" verbatim', () => {
    expect(stripRevisionPreamble('Revised Answer:\n\nUse 2 oz per gallon of water.')).toBe(
      'Use 2 oz per gallon of water.',
    );
  });

  it('strips "Here is a revised answer based only on the provided evidence:" verbatim', () => {
    expect(
      stripRevisionPreamble(
        'Here is a revised answer based only on the provided evidence:\nUse 2 oz per gallon of water.',
      ),
    ).toBe('Use 2 oz per gallon of water.');
  });

  it('leaves ordinary answer text with no preamble unchanged', () => {
    const text = 'Use 2 oz per gallon of water.\n\nSource: pH7Q Dual label.';
    expect(stripRevisionPreamble(text)).toBe(text);
  });

  it('never strips a mid-answer sentence that happens to start a line with "Revised"', () => {
    const text = 'Use 2 oz per gallon of water.\n\nRevised guidance takes effect next quarter.';
    expect(stripRevisionPreamble(text)).toBe(text);
  });
});

describe('isOnlyRegulatedClaimIssues', () => {
  it('is true when every issue is a regulated_claim_unverified marker', () => {
    expect(
      isOnlyRegulatedClaimIssues([
        'regulated_claim_unverified:dilution_ratio',
        'regulated_claim_unverified:epa_registration',
      ]),
    ).toBe(true);
  });

  it('is false when any issue is not a regulated_claim_unverified marker', () => {
    expect(
      isOnlyRegulatedClaimIssues([
        'regulated_claim_unverified:dilution_ratio',
        'efficacy claim not supported by evidence',
      ]),
    ).toBe(false);
  });

  it('is false for an empty issues list', () => {
    expect(isOnlyRegulatedClaimIssues([])).toBe(false);
  });
});
