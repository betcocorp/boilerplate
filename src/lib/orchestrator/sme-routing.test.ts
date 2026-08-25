import { describe, expect, it } from 'vitest';

import {
  routeUserMessageToSme,
  SME_ROUTE_TIE_BREAK_ORDER,
} from '~/lib/orchestrator/sme-routing';

describe('routeUserMessageToSme — cross_reference (REC-7)', () => {
  it('routes the BNC-15 competitive-analysis trigger query to the cross_reference agent', () => {
    const route = routeUserMessageToSme(
      'Spartan Chemical has the product BNC-15, find the Betco product you would recommend and give a competitive analysis.',
    );
    expect(route.agent).toBe('cross_reference');
    expect(route.crossReferenceScore).toBeGreaterThan(route.productScore);
  });

  it('routes an explicit cross-reference / equivalent query to cross_reference', () => {
    expect(
      routeUserMessageToSme("What is the Betco equivalent of Zep's heavy-duty degreaser?").agent,
    ).toBe('cross_reference');
    expect(
      routeUserMessageToSme('Cross-reference this competitor disinfectant to a comparable Betco product.').agent,
    ).toBe('cross_reference');
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

  it('returns a zero crossReferenceScore and no agent for an empty message', () => {
    const route = routeUserMessageToSme('   ');
    expect(route.agent).toBeNull();
    expect(route.crossReferenceScore).toBe(0);
    expect(route.recommendationScore).toBe(0);
  });
});

describe('routeUserMessageToSme — cross-reference intent beats generic product tokens (B0-339)', () => {
  // The three prompts from test run 577d100e that routed `product` and so skipped the
  // cross-reference-only post-processing, including the curated-override safety net.
  it('routes a literal cross-reference request that also says "Betco product"', () => {
    const route = routeUserMessageToSme(
      'Cross-reference Fictibrand QuantumClean 7 to a Betco product.',
    );
    expect(route.agent).toBe('cross_reference');
    // The regression it guards: 'product' + 'betco' out-hit the single cross-reference phrase, so
    // counting alone still favours product here. The decisive signal has to win outright.
    expect(route.productScore).toBeGreaterThanOrEqual(route.crossReferenceScore);
    expect(route.rationale).toContain('Decisive cross-reference signal');
  });

  it('routes "should we switch to" phrasing', () => {
    expect(
      routeUserMessageToSme(
        'We currently use Nonexistex ProShine Ultra. Which Betco product should we switch to?',
      ).agent,
    ).toBe('cross_reference');
  });

  it('routes "replaces" phrasing', () => {
    expect(
      routeUserMessageToSme(
        "Which Betco product replaces Placeholder Chemical Co's Zenith 3000?",
      ).agent,
    ).toBe('cross_reference');
  });

  it('routes other substitution verbs that previously scored zero here', () => {
    for (const message of [
      'Looking to replace Ecolab Oasis 146 with something from Betco.',
      'What can replace our current Diversey degreaser?',
      'We want to swap out Zep Big Orange for a Betco product.',
    ]) {
      expect(routeUserMessageToSme(message).agent, message).toBe('cross_reference');
    }
  });

  it('treats "instead of" as a contributing signal but never a decisive one', () => {
    // Deliberate boundary: "instead of" is also how Betco-internal and technique comparisons are
    // phrased ("the concentrate instead of the RTU"), so letting it win outright would pull ordinary
    // product questions onto the cross-reference path. It still counts toward the score.
    const route = routeUserMessageToSme(
      'Should I use the Betco concentrate instead of the RTU for this floor?',
    );
    expect(route.crossReferenceScore).toBeGreaterThan(0);
    expect(route.rationale).not.toContain('Decisive');
    expect(route.agent).not.toBe('cross_reference');
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

describe('routeUserMessageToSme — job-based recommendations (B0-663, additive only)', () => {
  it('routes a generic job/problem ask with no competitor and no domain signal', () => {
    const route = routeUserMessageToSme(
      'I have an issue with static cling building up on the carpet, what would you recommend?',
    );
    expect(route.agent).toBe('recommendations');
    expect(route.recommendationScore).toBeGreaterThan(0);
  });

  it('does not fire on a factual/spec lookup phrased as a question', () => {
    for (const message of [
      'Does Betco make a neutral floor cleaner?',
      'Tell me about the Green Earth product line.',
      'What is the SDS for this concentrate?',
    ]) {
      expect(routeUserMessageToSme(message).agent, message).not.toBe('recommendations');
    }
  });

  it('additive-only: a domain-specific "what should I use" question still routes to its specialist', () => {
    const route = routeUserMessageToSme('What should I use on urinals and toilets in a restroom?');
    expect(route.agent).toBe('bathroom');
    expect(route.recommendationScore).toBeGreaterThan(0);
    expect(route.bathroomScore).toBeGreaterThan(route.recommendationScore);
  });

  it('never gets the decisive short-circuit treatment cross_reference gets', () => {
    // A message with only job-phrase signals (no decisive cross-reference phrase) must resolve via
    // scoring/tie-break, never a "decisive" decisionPath.
    const route = routeUserMessageToSme('What should I use to degrease a commercial kitchen floor?');
    expect(route.agent).toBe('recommendations');
    expect(route.decisionPath).not.toBe('decisive_cross_reference_signal');
  });
});

describe('routeUserMessageToSme — matched phrases and decision path (B0-392)', () => {
  it('returns the exact phrases behind each score, and the counts still equal their length', () => {
    const route = routeUserMessageToSme(
      'Cross-reference this competitor disinfectant to a comparable Betco product.',
    );

    expect(route.matchedPhrases.cross_reference).toEqual([
      'cross-reference',
      'competitor',
      'comparable',
    ]);
    expect(route.matchedPhrases.product).toEqual(['product', 'disinfect', 'betco']);
    expect(route.matchedPhrases.floor).toEqual([]);

    // The phrases are the score: counts are unchanged, they are just no longer the only record.
    expect(route.matchedPhrases.cross_reference).toHaveLength(route.crossReferenceScore);
    expect(route.matchedPhrases.recommendations).toHaveLength(route.recommendationScore);
    expect(route.matchedPhrases.product).toHaveLength(route.productScore);
    expect(route.matchedPhrases.bathroom).toHaveLength(route.bathroomScore);
    expect(route.matchedPhrases.dilution).toHaveLength(route.dilutionScore);
    expect(route.matchedPhrases.floor).toHaveLength(route.floorScore);
  });

  it('shows why the counts are not comparable across categories', () => {
    // "competitive analysis" matches BOTH `competitive` and `competitive analysis`, so it scores 2
    // where an equivalent single floor phrase scores 1. Only the phrases make that visible.
    const route = routeUserMessageToSme('Please give a competitive analysis of this.');

    expect(route.matchedPhrases.cross_reference).toEqual([
      'competitive analysis',
      'competitive',
    ]);
    expect(route.crossReferenceScore).toBe(2);
  });

  it('reports a zero-signal message as no_signal (not a tie, not ambiguity between agents)', () => {
    const route = routeUserMessageToSme('Hello there, how is the weather today?');

    expect(route.agent).toBeNull();
    expect(route.decisionPath).toBe('no_signal');
    expect(route.tiedCategories).toEqual([]);
    expect(Object.values(route.matchedPhrases).every((phrases) => phrases.length === 0)).toBe(
      true,
    );
  });

  it('reports an empty message as empty_message', () => {
    expect(routeUserMessageToSme('   ').decisionPath).toBe('empty_message');
  });

  it('names the tie-break path and the tied categories when a tie is resolved', () => {
    // floor 1 ("burnish") vs bathroom 1 ("tile") — resolved by priority, not by score.
    const route = routeUserMessageToSme('Burnish the tile.');

    expect(route.decisionPath).toBe('tie_break');
    expect(route.tiedCategories).toEqual(['bathroom', 'floor']);
    expect(route.agent).toBe('floor');
    // A tie resolves to a real agent by priority — it is never reported as "ambiguous".
    expect(route.agent).not.toBeNull();
    expect(SME_ROUTE_TIE_BREAK_ORDER.indexOf(route.agent as never)).toBeGreaterThanOrEqual(0);
  });

  it('records the decisive cross-reference phrases that short-circuited the count', () => {
    const route = routeUserMessageToSme(
      'Cross-reference Fictibrand QuantumClean 7 to a Betco product.',
    );

    expect(route.decisionPath).toBe('decisive_cross_reference_signal');
    expect(route.decisiveCrossReferencePhrases).toContain('cross-reference');
    expect(route.agent).toBe('cross_reference');
  });

  it('reports an uncontested winner as outright_winner', () => {
    const route = routeUserMessageToSme(
      'How do I calibrate the dispenser and set the metering tip on my dilution control system?',
    );

    expect(route.decisionPath).toBe('outright_winner');
    expect(route.tiedCategories).toEqual([]);
  });
});
