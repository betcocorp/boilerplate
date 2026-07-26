import { describe, expect, it } from 'vitest';

import { RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/recommendations-specialist/recommendations-specialist-system-prompt';
import { PRODUCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/product-specialist/product-specialist-system-prompt';
import { buildProductSupportInstructions } from '~/lib/workflows/product-support/product-support-prompts';

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
    expect(instructions).toContain(
      "I'm sorry, but I don't have enough information to provide that answer. Please contact a Betco sales representative directly.",
    );
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
