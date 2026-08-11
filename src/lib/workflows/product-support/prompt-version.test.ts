import { describe, expect, it } from 'vitest';

import { productSupportTools } from '~/lib/tools/definitions';
import {
  PRODUCT_SUPPORT_PREAMBLE,
  PRODUCT_SUPPORT_SHARED_INSTRUCTIONS,
  VALIDATOR_SYSTEM_PROMPT,
} from '~/lib/workflows/product-support/product-support-prompts';
import {
  PROMPT_BUNDLE_VERSION,
  PROMPT_BUNDLE_VERSION_SHORT,
  PRODUCT_SUPPORT_SPECIALIST_PROMPTS,
  SHORT_HASH_LENGTH,
  computePromptBundleVersionFrom,
  computePromptVersion,
  computePromptVersionFrom,
  computePromptVersionShort,
  shortHash,
  stableStringify,
  type PromptBundleInputs,
  type SpecialistPromptTexts,
} from '~/lib/workflows/product-support/prompt-version';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Fixture prompts — deliberately tiny so "edit one prompt" is unambiguous. */
const fixtureSpecialists: SpecialistPromptTexts = {
  bathroom: 'bathroom policy',
  dilution: 'dilution policy',
  floor: 'floor policy',
  product: 'product policy',
  recommendations: 'recommendations policy',
};

const fixtureShared = {
  preamble: 'preamble text',
  sharedInstructions: 'shared instruction text',
};

const fixtureBundle: PromptBundleInputs = {
  specialists: fixtureSpecialists,
  shared: fixtureShared,
  validatorPrompt: 'validator policy',
  tools: [{ type: 'function', name: 'search_product_docs', parameters: { type: 'object' } }],
};

const versionFor = (decision: string, specialists = fixtureSpecialists) =>
  computePromptVersionFrom({ decision, specialists, shared: fixtureShared });

describe('stableStringify (B0-393)', () => {
  it('is insensitive to object key order, recursively', () => {
    const a = { b: 1, a: { z: [1, 2], y: 'x' } };
    const b = { a: { y: 'x', z: [1, 2] }, b: 1 };

    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('{"a":{"y":"x","z":[1,2]},"b":1}');
  });

  it('is sensitive to array order (tool order is part of what the model sees)', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('drops undefined object values and normalises undefined array entries, like JSON.stringify', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify([undefined, 1])).toBe('[null,1]');
    expect(stableStringify(null)).toBe('null');
  });
});

describe('promptVersion (B0-393)', () => {
  it('is a full-length sha256 hex digest', () => {
    expect(computePromptVersion('floor')).toMatch(SHA256_HEX);
    expect(versionFor('floor')).toMatch(SHA256_HEX);
  });

  it('is stable: same inputs produce the same hash on every call', () => {
    expect(computePromptVersion('floor')).toBe(computePromptVersion('floor'));
    expect(versionFor('floor')).toBe(versionFor('floor'));
  });

  it('is deterministic across processes and deploys (pinned digest for a fixed input)', () => {
    // If this literal ever needs changing, the hashing INPUTS or layout changed — which means every
    // previously stored promptVersion has been invalidated. That must be a deliberate decision.
    expect(versionFor('floor')).toBe(
      '627cfdc886f393e8ee4ce87fb3b8c692715dbaeb66802bba32a6076455a1bdcb',
    );
  });

  it('gives each specialist route its own hash', () => {
    const hashes = ['bathroom', 'dilution', 'floor', 'product', 'recommendations'].map((d) =>
      versionFor(d),
    );

    expect(new Set(hashes).size).toBe(5);
  });

  it('hashes an ambiguous/unknown decision as the product specialist (fallthrough preserved)', () => {
    expect(versionFor('ambiguous')).toBe(versionFor('product'));
    expect(versionFor('')).toBe(versionFor('product'));
    expect(versionFor('not-a-specialist')).toBe(versionFor('product'));

    expect(computePromptVersion('ambiguous')).toBe(computePromptVersion('product'));
    expect(computePromptVersion('')).toBe(computePromptVersion('product'));
  });

  it('specialist isolation: editing the floor prompt changes ONLY the floor-routed hash', () => {
    const edited: SpecialistPromptTexts = {
      ...fixtureSpecialists,
      floor: 'floor policy (edited)',
    };

    expect(versionFor('floor', edited)).not.toBe(versionFor('floor'));

    for (const decision of ['bathroom', 'dilution', 'product', 'recommendations', 'ambiguous']) {
      expect(versionFor(decision, edited)).toBe(versionFor(decision));
    }
  });

  it('does not normalise whitespace — a trailing space is an edit', () => {
    const edited: SpecialistPromptTexts = { ...fixtureSpecialists, floor: 'floor policy ' };

    expect(versionFor('floor', edited)).not.toBe(versionFor('floor'));
  });

  it('changes when the shared static instruction text changes (all routes)', () => {
    const withEditedShared = (decision: string) =>
      computePromptVersionFrom({
        decision,
        specialists: fixtureSpecialists,
        shared: { ...fixtureShared, sharedInstructions: 'shared instruction text (edited)' },
      });

    for (const decision of ['bathroom', 'dilution', 'floor', 'product', 'recommendations']) {
      expect(withEditedShared(decision)).not.toBe(versionFor(decision));
    }
  });

  it('excludes per-message routing hint data by construction (decision only selects the policy)', () => {
    // Two items on the same route with different scores/rationale cannot differ: the pure function
    // takes no scores or rationale at all, and equal decisions ⇒ equal hash.
    expect(versionFor('floor')).toBe(versionFor('floor'));
    // And a route with no signal at all lands on the product hash rather than a unique one.
    expect(versionFor('ambiguous')).toBe(versionFor('product'));
  });

  it('stamps the real workflow prompts (wired to the live constants)', () => {
    expect(computePromptVersion('floor')).toBe(
      computePromptVersionFrom({
        decision: 'floor',
        specialists: PRODUCT_SUPPORT_SPECIALIST_PROMPTS,
        shared: {
          preamble: PRODUCT_SUPPORT_PREAMBLE,
          sharedInstructions: PRODUCT_SUPPORT_SHARED_INSTRUCTIONS,
        },
      }),
    );
  });
});

describe('promptBundleVersion (B0-393)', () => {
  const bundle = (overrides: Partial<PromptBundleInputs> = {}) =>
    computePromptBundleVersionFrom({ ...fixtureBundle, ...overrides });

  it('is a stable, full-length sha256 hex digest', () => {
    expect(PROMPT_BUNDLE_VERSION).toMatch(SHA256_HEX);
    expect(bundle()).toBe(bundle());
    expect(bundle()).toMatch(SHA256_HEX);
  });

  it('changes when ANY specialist prompt is edited', () => {
    for (const id of ['bathroom', 'dilution', 'floor', 'product', 'recommendations'] as const) {
      expect(
        bundle({ specialists: { ...fixtureSpecialists, [id]: `${fixtureSpecialists[id]} (edited)` } }),
      ).not.toBe(bundle());
    }
  });

  it('changes when the validator prompt or shared instruction text is edited', () => {
    expect(bundle({ validatorPrompt: 'validator policy (edited)' })).not.toBe(bundle());
    expect(
      bundle({ shared: { ...fixtureShared, sharedInstructions: 'shared instruction text!' } }),
    ).not.toBe(bundle());
    expect(bundle({ shared: { ...fixtureShared, preamble: 'preamble text!' } })).not.toBe(bundle());
  });

  it('changes when a tool definition name, description, or JSON schema is edited', () => {
    expect(
      bundle({ tools: [{ type: 'function', name: 'renamed', parameters: { type: 'object' } }] }),
    ).not.toBe(bundle());
    expect(
      bundle({
        tools: [
          {
            type: 'function',
            name: 'search_product_docs',
            description: 'added',
            parameters: { type: 'object' },
          },
        ],
      }),
    ).not.toBe(bundle());
    expect(
      bundle({
        tools: [
          {
            type: 'function',
            name: 'search_product_docs',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
        ],
      }),
    ).not.toBe(bundle());
  });

  it('ignores key ORDER inside tool definitions (stable-key stringify)', () => {
    expect(
      bundle({ tools: [{ parameters: { type: 'object' }, name: 'search_product_docs', type: 'function' }] }),
    ).toBe(bundle());
  });

  it('is stamped from the live prompt constants and tool definitions', () => {
    expect(PROMPT_BUNDLE_VERSION).toBe(
      computePromptBundleVersionFrom({
        specialists: PRODUCT_SUPPORT_SPECIALIST_PROMPTS,
        shared: {
          preamble: PRODUCT_SUPPORT_PREAMBLE,
          sharedInstructions: PRODUCT_SUPPORT_SHARED_INSTRUCTIONS,
        },
        validatorPrompt: VALIDATOR_SYSTEM_PROMPT,
        tools: productSupportTools,
      }),
    );
  });
});

describe('short display form (B0-393)', () => {
  it('is a prefix of the full hash, 6 hex chars by default', () => {
    const full = computePromptVersion('floor');

    expect(shortHash(full)).toHaveLength(SHORT_HASH_LENGTH);
    expect(full.startsWith(shortHash(full))).toBe(true);
    expect(shortHash(full, 4)).toHaveLength(4);
    expect(computePromptVersionShort('floor')).toBe(shortHash(full));
    expect(PROMPT_BUNDLE_VERSION_SHORT).toBe(shortHash(PROMPT_BUNDLE_VERSION));
  });

  it('keeps the full hash available for storage', () => {
    expect(computePromptVersion('floor')).toHaveLength(64);
    expect(PROMPT_BUNDLE_VERSION).toHaveLength(64);
  });
});
