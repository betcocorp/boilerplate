import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: vi.fn((_key: string, fallback: string) => Promise.resolve(fallback)),
  // B0-899 — resolveGradingModel now goes through resolveModel, whose `preview` branch reads this.
  getLlmProvider: vi.fn(() => Promise.resolve('openai' as const)),
}));

import { isGradingModelTag, modelProviderFor } from '~/lib/constants/models';
import { getStringSetting } from '~/lib/settings/settings-service';

import {
  DEFAULT_GRADING_EFFORT,
  DEFAULT_GRADING_MODEL_TAG,
  effortForModel,
  effortFromState,
  GRADING_EFFORT_SETTING_KEY,
  GRADING_MODEL_SETTING_KEY,
  loadGradingEffort,
  loadGradingModelTag,
  resolveGradingModel,
} from './grading-model';

/**
 * B0-806 — which model grades a report and how hard it thinks. An Anthropic tag is the exact Claude
 * API id and bypasses the OpenAI alias/override layer; an OpenAI tag still goes through it, so
 * grading on OpenAI is byte-for-byte what it was before this provider existed.
 *
 * B0-822 — the shipped default is `claude-opus-5` (Tom Bird, 2026-09-03), the same tag the
 * `REPORT_GRADING_MODEL` row is seeded to, so a missing row and the seeded row grade identically.
 */

beforeEach(() => {
  vi.mocked(getStringSetting).mockClear();
  vi.mocked(getStringSetting).mockImplementation((_key, fallback) => Promise.resolve(fallback));
});

describe('DEFAULT_GRADING_MODEL_TAG (B0-822)', () => {
  it('is claude-opus-5, a GRADING_MODEL_TAGS entry served by Anthropic', () => {
    expect(DEFAULT_GRADING_MODEL_TAG).toBe('claude-opus-5');
    expect(isGradingModelTag(DEFAULT_GRADING_MODEL_TAG)).toBe(true);
    expect(modelProviderFor(DEFAULT_GRADING_MODEL_TAG)).toBe('anthropic');
  });
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
    // `preview` still resolves through the BEX_RESPONSES_MODEL row (a BEX_MODEL_TAGS tag, B0-831).
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_RESPONSES_MODEL' ? 'gpt-4o' : fallback),
    );
    expect(await resolveGradingModel('preview')).toBe('gpt-4o');
  });

  it('falls back to the shipped default tag for a missing or blank tag, on the Anthropic path', async () => {
    expect(await resolveGradingModel(undefined)).toBe('claude-opus-5');
    expect(await resolveGradingModel('  ')).toBe('claude-opus-5');
    // The default is an Anthropic tag, so no OpenAI alias/override row is read for it.
    expect(getStringSetting).not.toHaveBeenCalled();
  });
});

describe('loadGradingModelTag', () => {
  it('reads the REPORT_GRADING_MODEL row and defaults to claude-opus-5 when it is missing', async () => {
    expect(await loadGradingModelTag()).toBe('claude-opus-5');
    expect(getStringSetting).toHaveBeenCalledWith(GRADING_MODEL_SETTING_KEY, 'claude-opus-5');
  });

  it('honours a row switched back to an OpenAI tag (the /admin/settings escape hatch)', async () => {
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === GRADING_MODEL_SETTING_KEY ? 'gpt-5.6' : fallback),
    );
    expect(await loadGradingModelTag()).toBe('gpt-5.6');
    expect(await resolveGradingModel(await loadGradingModelTag())).toBe('gpt-5.6');
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
