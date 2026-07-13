import { describe, expect, it } from 'vitest';

import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';

describe('routeUserMessageToSme — recommendations (REC-7)', () => {
  it('routes the BNC-15 competitive-analysis trigger query to the recommendations agent', () => {
    const route = routeUserMessageToSme(
      'Spartan Chemical has the product BNC-15, find the Betco product you would recommend and give a competitive analysis.',
    );
    expect(route.agent).toBe('recommendations');
    expect(route.recommendationScore).toBeGreaterThan(route.productScore);
  });

  it('routes an explicit cross-reference / equivalent query to recommendations', () => {
    expect(
      routeUserMessageToSme("What is the Betco equivalent of Zep's heavy-duty degreaser?").agent,
    ).toBe('recommendations');
    expect(
      routeUserMessageToSme('Cross-reference this competitor disinfectant to a comparable Betco product.').agent,
    ).toBe('recommendations');
  });

  it('does not let the broad "recommend" signal hijack a floor-procedure query', () => {
    const route = routeUserMessageToSme(
      'What do you recommend to strip and recoat a VCT floor using the floor maintenance program?',
    );
    expect(route.agent).toBe('floor');
  });

  it('leaves a pure Betco-product spec question on the product agent', () => {
    const route = routeUserMessageToSme('What is the SDS hazard rating and dilution ratio for this Betco cleaner?');
    expect(route.agent).toBe('product');
  });

  it('returns a zero recommendationScore and no agent for an empty message', () => {
    const route = routeUserMessageToSme('   ');
    expect(route.agent).toBeNull();
    expect(route.recommendationScore).toBe(0);
  });
});
