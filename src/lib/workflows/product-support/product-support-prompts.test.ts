import { describe, expect, it } from 'vitest';

import {
  RECOMMENDATIONS_DECLINE_COPY,
  RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT,
} from '~/lib/agents/recommendations-specialist/recommendations-specialist-system-prompt';
import { PRODUCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/product-specialist/product-specialist-system-prompt';
import {
  buildProductSupportInstructions,
  buildProductSupportPromptCacheKey,
} from '~/lib/workflows/product-support/product-support-prompts';

const baseRouting = {
  rationale: 'test rationale',
  productScore: 0,
  bathroomScore: 0,
  dilutionScore: 0,
  floorScore: 0,
  recommendationScore: 0,
};

describe('buildProductSupportInstructions — recommendations routing (B0-98)', () => {
  it('direct `recommendations` mode selects the recommendations specialist prompt', () => {
    const instructions = buildProductSupportInstructions({
      mode: 'recommendations',
      routing: { ...baseRouting, decision: 'recommendations' },
    });

    expect(instructions).toContain(RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT);
    expect(instructions).toContain('Routing mode: direct `recommendations` specialist');
    // Never silently fall back to the general product prompt when recommendations was selected.
    expect(instructions.indexOf(RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT)).toBeGreaterThanOrEqual(0);
  });

  it('orchestrator mode with a recommendations routing decision also selects the recommendations prompt', () => {
    const instructions = buildProductSupportInstructions({
      mode: 'orchestrator',
      routing: { ...baseRouting, decision: 'recommendations', recommendationScore: 3 },
    });

    expect(instructions).toContain(RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT);
    expect(instructions).toContain('Routing mode: orchestrator (auto-select specialist by intent).');
    expect(instructions).toContain('recommendations 3');
  });

  it('enforces the exact sub-threshold decline copy for the recommendations route', () => {
    const instructions = buildProductSupportInstructions({
      mode: 'recommendations',
      routing: { ...baseRouting, decision: 'recommendations' },
    });

    // The prompt embedded verbatim in the built instructions must carry the exact decline phrase
    // the recommendations specialist is required to use below the 0.80 confidence gate — this is
    // what `isDeclineAnswer` (run-product-support-workflow.ts) pattern-matches against.
    expect(instructions).toContain(RECOMMENDATIONS_DECLINE_COPY);
  });

  it('falls back to the product specialist prompt for an unrecognized/ambiguous decision', () => {
    const instructions = buildProductSupportInstructions({
      mode: 'orchestrator',
      routing: { ...baseRouting, decision: 'ambiguous' },
    });

    expect(instructions).toContain(PRODUCT_SPECIALIST_SYSTEM_PROMPT);
    expect(instructions).not.toContain(RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT);
  });

  it('renders the full scores line so a routing decision is always visible/debuggable', () => {
    const instructions = buildProductSupportInstructions({
      mode: 'orchestrator',
      routing: {
        decision: 'recommendations',
        rationale: 'recommendations signals (2) won',
        productScore: 0,
        bathroomScore: 0,
        dilutionScore: 0,
        floorScore: 0,
        recommendationScore: 2,
      },
    });

    expect(instructions).toContain(
      'Scores: product 0 · bathroom 0 · dilution 0 · floor 0 · recommendations 2',
    );
  });
});

describe('buildProductSupportInstructions — prompt-cache stable prefix (B0-324)', () => {
  const build = (routing: Partial<typeof baseRouting> & { decision: string }) =>
    buildProductSupportInstructions({
      mode: 'orchestrator',
      routing: { ...baseRouting, ...routing },
    });

  it('keeps the volatile routing hint at the very end, after the specialist policy and tool rules', () => {
    const instructions = build({ decision: 'product', rationale: 'product signals (2) won' });

    expect(instructions).toContain('## Orchestrator hint (non-authoritative)');
    expect(instructions.indexOf('## Orchestrator hint (non-authoritative)')).toBeGreaterThan(
      instructions.indexOf(PRODUCT_SPECIALIST_SYSTEM_PROMPT),
    );
    expect(instructions.indexOf('## Orchestrator hint (non-authoritative)')).toBeGreaterThan(
      instructions.indexOf('## Tool and grounding rules'),
    );
    // Nothing may follow the hint block — it is the tail of the prompt.
    expect(instructions.trimEnd()).toMatch(
      /do not treat this routing as evidence\.$/,
    );
  });

  it('two turns on the same route share a byte-identical prefix up to the routing hint', () => {
    const first = build({ decision: 'product', rationale: 'first message rationale', productScore: 2 });
    const second = build({ decision: 'product', rationale: 'second message rationale', productScore: 7 });

    const marker = '## Orchestrator hint (non-authoritative)';
    const firstPrefix = first.slice(0, first.indexOf(marker));
    const secondPrefix = second.slice(0, second.indexOf(marker));

    expect(firstPrefix).toBe(secondPrefix);
    // The shared prefix must stay large enough to clear OpenAI's ~1024-token cache floor.
    expect(firstPrefix.length).toBeGreaterThan(6000);
  });

  it('keys the prompt cache by mode + routing decision only (never per message or per run)', () => {
    const key = buildProductSupportPromptCacheKey({
      mode: 'orchestrator',
      decision: 'product',
    });

    expect(key).toBe('bex-product-support:orchestrator:product');
    // Same route ⇒ same key, so consecutive turns share one cache pool.
    expect(
      buildProductSupportPromptCacheKey({ mode: 'orchestrator', decision: 'product' }),
    ).toBe(key);
    // A different specialist policy is a different prefix, so it must not share the pool.
    expect(
      buildProductSupportPromptCacheKey({ mode: 'orchestrator', decision: 'recommendations' }),
    ).not.toBe(key);
    expect(
      buildProductSupportPromptCacheKey({ mode: 'recommendations', decision: 'recommendations' }),
    ).not.toBe(key);
  });
});
