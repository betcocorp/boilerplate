import { describe, expect, it } from 'vitest';

import {
  RECOMMENDATIONS_DECLINE_COPY,
  RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT,
} from '~/lib/agents/recommendations-specialist/recommendations-specialist-system-prompt';
import { PRODUCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/product-specialist/product-specialist-system-prompt';
import {
  buildProductSupportInstructions,
  buildProductSupportPromptCacheKey,
  EFFECTIVE_PROMPT_IDS,
  effectivePromptIdForDecision,
} from '~/lib/workflows/product-support/product-support-prompts';
import {
  computePromptVersion,
  PRODUCT_SUPPORT_SPECIALIST_PROMPTS as SPECIALIST_PROMPT_TEXTS,
} from '~/lib/workflows/product-support/prompt-version';

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

describe('buildProductSupportInstructions — classifier-driven orchestrator hint (B0-508)', () => {
  const llmClassification = {
    intent: 'bathroom' as const,
    confidence: 0.87456,
    entities: {
      betcoProduct: 'Green Earth Neutral Cleaner',
      competitorBrand: null,
      competitorProduct: null,
      surfaceType: 'restroom floor',
      taskDescription: 'find the right cleaner for a restroom floor',
    },
    suggestedTool: 'search_product_docs' as const,
    source: 'llm' as const,
  };

  it('renders intent/confidence/entities instead of raw scores when the classifier ran', () => {
    const instructions = buildProductSupportInstructions({
      mode: 'orchestrator',
      routing: { ...baseRouting, decision: 'bathroom' },
      classification: llmClassification,
    });

    expect(instructions).toContain('Intent classification: bathroom (confidence 0.87)');
    expect(instructions).toContain(
      'Entities: Betco product: Green Earth Neutral Cleaner · surface: restroom floor · task: find the right cleaner for a restroom floor',
    );
    expect(instructions).not.toContain('Scores:');
  });

  it('degrades to the scores line when no classification is supplied (default/backward-compat)', () => {
    const instructions = buildProductSupportInstructions({
      mode: 'orchestrator',
      routing: { ...baseRouting, decision: 'bathroom' },
    });

    expect(instructions).toContain('Scores:');
    expect(instructions).not.toContain('Intent classification:');
  });

  it('degrades to the scores line when the classifier fell back to the keyword router', () => {
    const instructions = buildProductSupportInstructions({
      mode: 'orchestrator',
      routing: { ...baseRouting, decision: 'bathroom' },
      classification: { ...llmClassification, confidence: 0.5, source: 'keyword_fallback' },
    });

    expect(instructions).toContain('Scores:');
    expect(instructions).not.toContain('Intent classification:');
  });

  it('shows "none extracted" when the classifier found no entities', () => {
    const instructions = buildProductSupportInstructions({
      mode: 'orchestrator',
      routing: { ...baseRouting, decision: 'product' },
      classification: {
        ...llmClassification,
        entities: {
          betcoProduct: null,
          competitorBrand: null,
          competitorProduct: null,
          surfaceType: null,
          taskDescription: null,
        },
      },
    });

    expect(instructions).toContain('Entities: none extracted');
  });
});

describe('effectivePromptIdForDecision (B0-392)', () => {
  it('maps each specialist decision to its own prompt id', () => {
    for (const id of EFFECTIVE_PROMPT_IDS) {
      expect(effectivePromptIdForDecision(id)).toBe(id);
    }
  });

  it('resolves the ambiguous fallthrough to the product specialist', () => {
    // `routeUserMessageToSme` returns no agent for an empty or zero-signal message, the workflow
    // labels that `ambiguous`, and prompt assembly then falls through to the PRODUCT policy. The
    // label says "ambiguous"; the prompt that ran is the product specialist's.
    expect(effectivePromptIdForDecision('ambiguous')).toBe('product');
    expect(effectivePromptIdForDecision('')).toBe('product');
    expect(effectivePromptIdForDecision('not-a-specialist')).toBe('product');
  });

  it('is the same mapping the assembled instructions and the prompt-version stamp use', () => {
    for (const decision of ['ambiguous', 'bathroom', 'floor', 'not-a-specialist']) {
      const effective = effectivePromptIdForDecision(decision);

      // The assembled prompt for the decision equals the assembled prompt for its effective id…
      expect(
        buildProductSupportInstructions({
          mode: 'orchestrator',
          routing: { ...baseRouting, decision },
        }).includes(SPECIALIST_PROMPT_TEXTS[effective]),
      ).toBe(true);
      // …and so does the hash stamped alongside it.
      expect(computePromptVersion(decision)).toBe(computePromptVersion(effective));
    }
  });
});
