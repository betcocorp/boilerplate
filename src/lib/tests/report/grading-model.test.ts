import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: vi.fn((_key: string, fallback: string) => Promise.resolve(fallback)),
}));

import { getStringSetting } from '~/lib/settings/settings-service';

import {
  DEFAULT_GRADING_EFFORT,
  DEFAULT_GRADING_MODEL_TAG,
  effortForModel,
  effortFromState,
  GRADING_EFFORT_SETTING_KEY,
  loadGradingEffort,
  resolveGradingModel,
} from './grading-model';

/**
 * B0-806 — which model grades a report and how hard it thinks. An Anthropic tag is the exact Claude
 * API id and bypasses the OpenAI alias/override layer; an OpenAI tag still goes through it, so
 * grading on OpenAI is byte-for-byte what it was before this provider existed.
 */

beforeEach(() => {
  vi.mocked(getStringSetting).mockImplementation((_key, fallback) => Promise.resolve(fallback));
});

describe('resolveGradingModel', () => {
  it('returns an Anthropic tag as-is, without consulting any settings row', async () => {
    expect(await resolveGradingModel('claude-opus-5')).toBe('claude-opus-5');
    expect(await resolveGradingModel('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(getStringSetting).not.toHaveBeenCalled();
  });

  it('sends an OpenAI tag through resolveResponsesModel exactly as before', async () => {
    expect(await resolveGradingModel('gpt-5.6')).toBe('gpt-5.6');
    expect(await resolveGradingModel('gpt-4.1')).toBe('gpt-4.1');
    // `preview` still resolves through the BEX_RESPONSES_MODEL row.
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_RESPONSES_MODEL' ? 'gpt-4o-mini' : fallback),
    );
    expect(await resolveGradingModel('preview')).toBe('gpt-4o-mini');
  });

  it('falls back to the shipped default tag for a missing or blank tag', async () => {
    expect(await resolveGradingModel(undefined)).toBe(DEFAULT_GRADING_MODEL_TAG);
    expect(await resolveGradingModel('  ')).toBe(DEFAULT_GRADING_MODEL_TAG);
  });
});

describe('loadGradingEffort', () => {
  it('defaults to high when the row is missing', async () => {
    expect(await loadGradingEffort()).toBe(DEFAULT_GRADING_EFFORT);
    expect(DEFAULT_GRADING_EFFORT).toBe('high');
  });

  it('reads the row, normalising case and whitespace', async () => {
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === GRADING_EFFORT_SETTING_KEY ? ' XHIGH ' : fallback),
    );
    expect(await loadGradingEffort()).toBe('xhigh');
  });

  it('rejects an unrecognised stored value (allowed_values is advisory, not a DB constraint)', async () => {
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === GRADING_EFFORT_SETTING_KEY ? 'turbo' : fallback),
    );
    expect(await loadGradingEffort()).toBe('high');
  });
});

describe('effort bookkeeping', () => {
  it('records an effort only for a model that honours one', () => {
    expect(effortForModel('claude-opus-5', 'xhigh')).toBe('xhigh');
    expect(effortForModel('gpt-5.6', 'xhigh')).toBeNull();
  });

  it('reads a persisted effort back, and sends none for a legacy or unrecognised value', () => {
    expect(effortFromState('max')).toBe('max');
    expect(effortFromState(null)).toBeUndefined();
    expect(effortFromState(undefined)).toBeUndefined();
    expect(effortFromState('turbo')).toBeUndefined();
  });
});
