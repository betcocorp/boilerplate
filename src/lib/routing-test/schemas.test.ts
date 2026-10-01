import { describe, expect, it } from 'vitest';

import { SME_AGENT_IDS } from '~/lib/agents/agent-registry';
import {
  firstIssueMessage,
  routingTestExpectedAgentSchema,
  routingTestItemCreateSchema,
  routingTestItemUpdateSchema,
  routingTestRouterTypeSchema,
} from '~/lib/routing-test/schemas';

describe('routingTestExpectedAgentSchema (B0-657)', () => {
  it('accepts every id in SME_AGENT_IDS and nothing else', () => {
    for (const id of SME_AGENT_IDS) {
      expect(routingTestExpectedAgentSchema.safeParse(id).success).toBe(true);
    }
    expect(routingTestExpectedAgentSchema.safeParse('orchestrator').success).toBe(
      false,
    );
    expect(routingTestExpectedAgentSchema.safeParse('ambiguous').success).toBe(
      false,
    );
    expect(routingTestExpectedAgentSchema.safeParse('').success).toBe(false);
  });

  it('stays derived from the registry, so the enum and the DB CHECK cover the same nine ids', () => {
    // B0-746 — the former single `floor` id was split into four substrate specialists.
    expect([...SME_AGENT_IDS]).toEqual([
      'product',
      'bathroom',
      'dilution',
      'floor_wood_sport',
      'floor_concrete',
      'floor_stg',
      'floor_vct',
      'recommendations',
      'cross_reference',
    ]);
  });
});

describe('routingTestItemCreateSchema', () => {
  it('trims the prompt', () => {
    const parsed = routingTestItemCreateSchema.parse({
      prompt: '  How do I dilute pH7Q?  ',
      expectedAgent: 'dilution',
    });
    expect(parsed.prompt).toBe('How do I dilute pH7Q?');
  });

  it('rejects a blank or whitespace-only prompt', () => {
    for (const prompt of ['', '   ', '\n\t']) {
      const result = routingTestItemCreateSchema.safeParse({
        prompt,
        expectedAgent: 'product',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(firstIssueMessage(result.error)).toBe(
          'Enter a prompt before saving.',
        );
      }
    }
  });

  it('rejects an expected agent outside the SME enum', () => {
    const result = routingTestItemCreateSchema.safeParse({
      prompt: 'Anything',
      expectedAgent: 'janitorial',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an over-long prompt', () => {
    const result = routingTestItemCreateSchema.safeParse({
      prompt: 'x'.repeat(4001),
      expectedAgent: 'product',
    });
    expect(result.success).toBe(false);
  });
});

describe('routingTestItemUpdateSchema', () => {
  it('requires a uuid id', () => {
    expect(
      routingTestItemUpdateSchema.safeParse({
        id: 'not-a-uuid',
        prompt: 'Anything',
        expectedAgent: 'floor_vct',
      }).success,
    ).toBe(false);

    expect(
      routingTestItemUpdateSchema.safeParse({
        id: '3f1cf2f6-2c1a-4d3b-9f47-1a0a6ac1a111',
        prompt: 'Anything',
        expectedAgent: 'floor_vct',
      }).success,
    ).toBe(true);
  });
});

describe('routingTestRouterTypeSchema (B0-659/B0-666)', () => {
  it('accepts keyword, semantic, and llm', () => {
    expect(routingTestRouterTypeSchema.safeParse('keyword').success).toBe(true);
    expect(routingTestRouterTypeSchema.safeParse('semantic').success).toBe(true);
    expect(routingTestRouterTypeSchema.safeParse('llm').success).toBe(true);
    expect(routingTestRouterTypeSchema.safeParse('other').success).toBe(false);
  });
});
