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

describe('routeUserMessageToSme — cross-reference intent beats generic product tokens (B0-339)', () => {
  // The three prompts from test run 577d100e that routed `product` and so skipped the
  // recommendations-only post-processing, including the curated-override safety net.
  it('routes a literal cross-reference request that also says "Betco product"', () => {
    const route = routeUserMessageToSme(
      'Cross-reference Fictibrand QuantumClean 7 to a Betco product.',
    );
    expect(route.agent).toBe('recommendations');
    // The regression it guards: 'product' + 'betco' out-hit the single cross-reference phrase, so
    // counting alone still favours product here. The decisive signal has to win outright.
    expect(route.productScore).toBeGreaterThanOrEqual(route.recommendationScore);
    expect(route.rationale).toContain('Decisive cross-reference signal');
  });

  it('routes "should we switch to" phrasing', () => {
    expect(
      routeUserMessageToSme(
        'We currently use Nonexistex ProShine Ultra. Which Betco product should we switch to?',
      ).agent,
    ).toBe('recommendations');
  });

  it('routes "replaces" phrasing', () => {
    expect(
      routeUserMessageToSme(
        "Which Betco product replaces Placeholder Chemical Co's Zenith 3000?",
      ).agent,
    ).toBe('recommendations');
  });

  it('routes other substitution verbs that previously scored zero here', () => {
    for (const message of [
      'Looking to replace Ecolab Oasis 146 with something from Betco.',
      'What can replace our current Diversey degreaser?',
      'We want to swap out Zep Big Orange for a Betco product.',
    ]) {
      expect(routeUserMessageToSme(message).agent, message).toBe('recommendations');
    }
  });

  it('treats "instead of" as a contributing signal but never a decisive one', () => {
    // Deliberate boundary: "instead of" is also how Betco-internal and technique comparisons are
    // phrased ("the concentrate instead of the RTU"), so letting it win outright would pull ordinary
    // product questions onto the cross-reference path. It still counts toward the score.
    const route = routeUserMessageToSme(
      'Should I use the Betco concentrate instead of the RTU for this floor?',
    );
    expect(route.recommendationScore).toBeGreaterThan(0);
    expect(route.rationale).not.toContain('Decisive');
    expect(route.agent).not.toBe('recommendations');
  });

  it('leaves genuine product questions on the product route', () => {
    for (const message of [
      'What is the dilution ratio for Green Earth All Purpose Cleaner?',
      'What is the EPA reg number for Betco Fight Bac RTU?',
      'Is this Betco product compatible with my dispenser?',
      'What are the PPE and first aid requirements on the SDS for this concentrate?',
      'What dwell time does this Betco disinfectant need?',
    ]) {
      expect(routeUserMessageToSme(message).agent, message).toBe('product');
    }
  });

  it('still lets procedure specialists win over a decisive cross-reference phrase', () => {
    // Guards against the decisive short-circuit stealing turns from dilution/floor/bathroom.
    expect(
      routeUserMessageToSme(
        'How do I calibrate the dispenser and set the metering tip on my dilution control system?',
      ).agent,
    ).toBe('dilution');
  });
});
