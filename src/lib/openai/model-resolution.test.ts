import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveResponsesModel } from '~/lib/openai/client';
import { BEX_MODEL_TAGS, MODEL_DESCRIPTIONS } from '~/lib/constants/models';

/**
 * B0-598 / B0-599 — tag → concrete-model-id resolution, and the invariant that every selectable
 * tag is actually resolvable.
 *
 * Worth pinning down because the return value of `resolveResponsesModel` is what B0-563 stamps
 * into `workflow_steps.output.model`, which the B0-565 cost views join to `model_pricing` with an
 * INNER lateral: a tag that resolves to an unexpected id does not merely mislabel a run, it drops
 * it out of cost reporting.
 */

const MODEL_ENV_KEYS = [
  'BEX_RESPONSES_MODEL',
  'OPENAI_BEX_MODEL',
  'BEX_MODEL_GPT4O',
  'BEX_MODEL_GPT41',
  'BEX_MODEL_GPT55',
  'BEX_MODEL_GPT56',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of MODEL_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MODEL_ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('resolveResponsesModel — gpt-5.5 / gpt-5.6 (B0-598)', () => {
  it('resolves the new tags to their own model ids by default', () => {
    // Verified against the live API 2026-08-20: gpt-5.5 -> gpt-5.5-2026-04-23, and gpt-5.6 is a
    // servable alias for gpt-5.6-sol even though it is absent from /v1/models.
    expect(resolveResponsesModel('gpt-5.5')).toBe('gpt-5.5');
    expect(resolveResponsesModel('gpt-5.6')).toBe('gpt-5.6');
  });

  it('honours BEX_MODEL_GPT55 / BEX_MODEL_GPT56 overrides', () => {
    process.env.BEX_MODEL_GPT55 = 'gpt-5.5-2026-04-23';
    process.env.BEX_MODEL_GPT56 = 'gpt-5.6-terra';

    expect(resolveResponsesModel('gpt-5.5')).toBe('gpt-5.5-2026-04-23');
    expect(resolveResponsesModel('gpt-5.6')).toBe('gpt-5.6-terra');
  });

  it('keeps the two overrides independent of each other and of the older tags', () => {
    process.env.BEX_MODEL_GPT55 = 'pinned-55';

    expect(resolveResponsesModel('gpt-5.5')).toBe('pinned-55');
    expect(resolveResponsesModel('gpt-5.6')).toBe('gpt-5.6');
    expect(resolveResponsesModel('gpt-4.1')).toBe('gpt-4.1');
    expect(resolveResponsesModel('gpt-4o')).toBe('gpt-4o');
  });

  it('does not let the fleet-wide preview default capture a named tag', () => {
    // BEX_RESPONSES_MODEL only moves `preview`; naming a model must still get that model.
    process.env.BEX_RESPONSES_MODEL = 'gpt-4o-mini';

    expect(resolveResponsesModel('preview')).toBe('gpt-4o-mini');
    expect(resolveResponsesModel('gpt-5.5')).toBe('gpt-5.5');
    expect(resolveResponsesModel('gpt-5.6')).toBe('gpt-5.6');
  });
});

describe('resolveResponsesModel — pre-existing behaviour is unchanged', () => {
  it('resolves preview from BEX_RESPONSES_MODEL, then OPENAI_BEX_MODEL, then gpt-4.1-mini', () => {
    expect(resolveResponsesModel('preview')).toBe('gpt-4.1-mini');
    expect(resolveResponsesModel(undefined)).toBe('gpt-4.1-mini');
    expect(resolveResponsesModel('')).toBe('gpt-4.1-mini');

    process.env.OPENAI_BEX_MODEL = 'from-legacy-var';
    expect(resolveResponsesModel('preview')).toBe('from-legacy-var');

    process.env.BEX_RESPONSES_MODEL = 'from-primary-var';
    expect(resolveResponsesModel('preview')).toBe('from-primary-var');
  });

  it('still throws for the custom tag, which is why it is not offered in any dropdown', () => {
    expect(() => resolveResponsesModel('custom')).toThrow(/Custom model tag is not configured/);
  });
});

describe('BEX_MODEL_TAGS (B0-599)', () => {
  it('includes both new tags', () => {
    expect(BEX_MODEL_TAGS).toContain('gpt-5.5');
    expect(BEX_MODEL_TAGS).toContain('gpt-5.6');
  });

  it('resolves every selectable tag to a non-empty id, and never to the throwing custom path', () => {
    // The invariant that matters: nothing offered in the UI can fail to resolve.
    for (const tag of BEX_MODEL_TAGS) {
      expect(() => resolveResponsesModel(tag)).not.toThrow();
      expect(resolveResponsesModel(tag).length).toBeGreaterThan(0);
    }
  });

  it('describes every tag, so the selector can never render an undefined description', () => {
    for (const tag of BEX_MODEL_TAGS) {
      expect(MODEL_DESCRIPTIONS[tag]).toBeTruthy();
    }
    expect(Object.keys(MODEL_DESCRIPTIONS).sort()).toEqual([...BEX_MODEL_TAGS].sort());
  });
});
