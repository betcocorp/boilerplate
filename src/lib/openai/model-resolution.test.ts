import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-757 — `resolveResponsesModel`'s `preview` branch now reads the `BEX_RESPONSES_MODEL` settings
 * row (via `resolveGenerationModelDefaultTag`) instead of `process.env.BEX_RESPONSES_MODEL` /
 * `OPENAI_BEX_MODEL`. B0-831 made that row a `BEX_MODEL_TAGS` tag that is re-resolved through the
 * same function, so the `BEX_MODEL_GPT*` env pins apply to `preview` too. Only `getStringSetting`
 * is mocked; every other branch is a synchronous mapping over `process.env.BEX_MODEL_GPT*`.
 */
vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: vi.fn((_key: string, fallback: string) => Promise.resolve(fallback)),
}));

import { getStringSetting } from '~/lib/settings/settings-service';
import {
  anthropicModelPinEnvKey,
  DEFAULT_BEX_RESPONSES_MODEL_TAG,
  resolveGenerationModelDefaultTag,
  resolveResponsesModel,
} from '~/lib/openai/client';
import {
  ANTHROPIC_MODEL_TAGS,
  BEX_MODEL_TAGS,
  MODEL_DESCRIPTIONS,
  modelProviderFor,
  OPENAI_MODEL_TAGS,
} from '~/lib/constants/models';

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
  'BEX_MODEL_GPT4O',
  'BEX_MODEL_GPT41',
  'BEX_MODEL_GPT55',
  'BEX_MODEL_GPT56',
  ...ANTHROPIC_MODEL_TAGS.map(anthropicModelPinEnvKey),
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of MODEL_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  vi.mocked(getStringSetting).mockImplementation((_key, fallback) => Promise.resolve(fallback));
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
  it('resolves the new tags to their own model ids by default', async () => {
    // Verified against the live API 2026-08-20: gpt-5.5 -> gpt-5.5-2026-04-23, and gpt-5.6 is a
    // servable alias for gpt-5.6-sol even though it is absent from /v1/models.
    expect(await resolveResponsesModel('gpt-5.5')).toBe('gpt-5.5');
    expect(await resolveResponsesModel('gpt-5.6')).toBe('gpt-5.6');
  });

  it('honours BEX_MODEL_GPT55 / BEX_MODEL_GPT56 overrides', async () => {
    process.env.BEX_MODEL_GPT55 = 'gpt-5.5-2026-04-23';
    process.env.BEX_MODEL_GPT56 = 'gpt-5.6-terra';

    expect(await resolveResponsesModel('gpt-5.5')).toBe('gpt-5.5-2026-04-23');
    expect(await resolveResponsesModel('gpt-5.6')).toBe('gpt-5.6-terra');
  });

  it('keeps the two overrides independent of each other and of the older tags', async () => {
    process.env.BEX_MODEL_GPT55 = 'pinned-55';

    expect(await resolveResponsesModel('gpt-5.5')).toBe('pinned-55');
    expect(await resolveResponsesModel('gpt-5.6')).toBe('gpt-5.6');
    expect(await resolveResponsesModel('gpt-4.1')).toBe('gpt-4.1');
    expect(await resolveResponsesModel('gpt-4o')).toBe('gpt-4o');
  });

  it('does not let the fleet-wide preview default capture a named tag', async () => {
    // BEX_RESPONSES_MODEL only moves `preview`; naming a model must still get that model.
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_RESPONSES_MODEL' ? 'gpt-4o' : fallback),
    );

    expect(await resolveResponsesModel('preview')).toBe('gpt-4o');
    expect(await resolveResponsesModel('gpt-5.5')).toBe('gpt-5.5');
    expect(await resolveResponsesModel('gpt-5.6')).toBe('gpt-5.6');
  });
});

describe('resolveResponsesModel — Anthropic tags (B0-908)', () => {
  it('derives the pin env key from the tag the same way the gpt pins are named', () => {
    expect(anthropicModelPinEnvKey('claude-sonnet-5')).toBe('BEX_MODEL_CLAUDE_SONNET_5');
    expect(anthropicModelPinEnvKey('claude-opus-4-8')).toBe('BEX_MODEL_CLAUDE_OPUS_4_8');
    expect(anthropicModelPinEnvKey('claude-haiku-4-5')).toBe('BEX_MODEL_CLAUDE_HAIKU_4_5');
  });

  it('resolves every Anthropic tag to itself — the tag IS the Claude API id', async () => {
    for (const tag of ANTHROPIC_MODEL_TAGS) {
      expect(await resolveResponsesModel(tag)).toBe(tag);
      expect(modelProviderFor(await resolveResponsesModel(tag))).toBe('anthropic');
    }
  });

  it('honours a BEX_MODEL_CLAUDE_* pin for that tag only', async () => {
    process.env.BEX_MODEL_CLAUDE_SONNET_5 = 'claude-sonnet-5-20260101';

    expect(await resolveResponsesModel('claude-sonnet-5')).toBe('claude-sonnet-5-20260101');
    expect(await resolveResponsesModel('claude-opus-5')).toBe('claude-opus-5');
    expect(await resolveResponsesModel('gpt-4.1')).toBe('gpt-4.1');
  });

  it('ignores an Anthropic tag stored in BEX_RESPONSES_MODEL — the OpenAI default row is OpenAI-only (B0-899)', async () => {
    // B0-908 briefly let this row hold a claude tag; B0-899 split the Anthropic default into its
    // own row (BEX_ANTHROPIC_MODEL) read by `resolveModel`, so here a claude value is out-of-set
    // and falls back exactly like any other unrecognised value.
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_RESPONSES_MODEL' ? 'claude-sonnet-5' : fallback),
    );

    expect(await resolveGenerationModelDefaultTag()).toBe(DEFAULT_BEX_RESPONSES_MODEL_TAG);
    expect(await resolveResponsesModel('preview')).toBe('gpt-4.1-mini');
    expect(await resolveResponsesModel(undefined)).toBe('gpt-4.1-mini');
    // Naming a tag must still get that model, on either vendor.
    expect(await resolveResponsesModel('gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(await resolveResponsesModel('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('accepts every OpenAI tag as the preview default and nothing else (B0-899)', async () => {
    for (const tag of OPENAI_MODEL_TAGS) {
      vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
        Promise.resolve(key === 'BEX_RESPONSES_MODEL' ? tag : fallback),
      );
      expect(await resolveGenerationModelDefaultTag()).toBe(tag);
    }
    for (const tag of ANTHROPIC_MODEL_TAGS) {
      vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
        Promise.resolve(key === 'BEX_RESPONSES_MODEL' ? tag : fallback),
      );
      expect(await resolveGenerationModelDefaultTag()).toBe('gpt-4.1-mini');
    }
  });
});

describe('resolveResponsesModel — pre-existing behaviour is unchanged', () => {
  it('resolves preview from the BEX_RESPONSES_MODEL settings row, defaulting to gpt-4.1-mini', async () => {
    expect(await resolveResponsesModel('preview')).toBe('gpt-4.1-mini');
    expect(await resolveResponsesModel(undefined)).toBe('gpt-4.1-mini');
    expect(await resolveResponsesModel('')).toBe('gpt-4.1-mini');

    // B0-831 — the row is a BEX_MODEL_TAGS tag now, like BEX_ROUTER_MODEL: allowed_values is
    // advisory, not a DB constraint, so an unrecognised stored value (a dated snapshot, a typo)
    // falls back to the default tag instead of reaching OpenAI as a non-existent model id.
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_RESPONSES_MODEL' ? 'gpt-4.1-mini-2026-01-01' : fallback),
    );
    expect(await resolveResponsesModel('preview')).toBe('gpt-4.1-mini');
  });

  it('refuses to store "preview" as its own default (would resolve to itself)', async () => {
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_RESPONSES_MODEL' ? 'preview' : fallback),
    );
    expect(await resolveResponsesModel('preview')).toBe('gpt-4.1-mini');
  });

  it('resolves preview through the stored tag so the BEX_MODEL_* pins apply, exactly like resolveRouterModel (B0-831)', async () => {
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_RESPONSES_MODEL' ? 'gpt-4.1' : fallback),
    );
    process.env.BEX_MODEL_GPT41 = 'gpt-4.1-2026-01-01';

    expect(await resolveResponsesModel('preview')).toBe('gpt-4.1-2026-01-01');
    expect(await resolveResponsesModel(undefined)).toBe('gpt-4.1-2026-01-01');
  });

  it('still throws for the custom tag, which is why it is not offered in any dropdown', async () => {
    await expect(resolveResponsesModel('custom')).rejects.toThrow(
      /Custom model tag is not configured/,
    );
  });
});

describe('BEX_MODEL_TAGS (B0-599 / B0-908)', () => {
  it('includes both new gpt tags and every Anthropic tag', () => {
    expect(BEX_MODEL_TAGS).toContain('gpt-5.5');
    expect(BEX_MODEL_TAGS).toContain('gpt-5.6');
    for (const tag of ANTHROPIC_MODEL_TAGS) {
      expect(BEX_MODEL_TAGS).toContain(tag);
    }
  });

  it('resolves every selectable tag to a non-empty id, and never to the throwing custom path', async () => {
    // The invariant that matters: nothing offered in the UI can fail to resolve.
    for (const tag of BEX_MODEL_TAGS) {
      const resolved = await resolveResponsesModel(tag);
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it('describes every tag, so the selector can never render an undefined description', () => {
    for (const tag of BEX_MODEL_TAGS) {
      expect(MODEL_DESCRIPTIONS[tag]).toBeTruthy();
    }
    expect(Object.keys(MODEL_DESCRIPTIONS).sort()).toEqual([...BEX_MODEL_TAGS].sort());
  });
});
