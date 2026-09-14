import { describe, expect, it } from 'vitest';

import type { ProductLineLock } from '~/lib/audit/trace';
import { planRegulatedClaimRedaction } from '~/lib/workflows/product-support/run-product-support-workflow';
import { evaluateRegulatedClaimGrounding } from '~/lib/workflows/product-support/validator';

/**
 * B0-257 work item 1 — regulated-claim guardrail. Demonstrates the "must-cite,
 * must-not-paraphrase" behavior for EPA registration, dilution ratio, contact-time,
 * hazard, and first-aid claims: grounded when the exact value/statement appears in a
 * retrieved source, ungrounded (hard failure) when it doesn't -- the guardrail never
 * rounds/converts/infers, it only checks verbatim presence.
 */

const LABEL_SOURCE = {
  documentId: 'doc-label-1',
  title: 'Test Disinfectant Label',
  documentBody: [
    'Product: Test Disinfectant',
    'EPA Reg. No. 1677-129',
    '',
    'Directions for Use:',
    'Dilute at 2 oz. per gallon of water for general disinfection.',
    '',
    'Kill Claims:',
    'Effective against Staphylococcus aureus with a 10 minute contact time.',
    '',
    'Hazards and Precautions:',
    'Causes severe skin burns and eye damage. Wear protective gloves and eye protection.',
    '',
    'First Aid:',
    'If swallowed, call a poison control center or doctor immediately.',
  ].join('\n'),
};

/** SDS-shaped source used by the B0-366 false-positive cases (GHS sections 2, 4 and 14). */
const SDS_SOURCE = {
  documentId: 'doc-sds-1',
  title: 'Test Disinfectant SDS',
  documentBody: [
    'SECTION 2: Hazards identification',
    'Signal word: Danger',
    'Hazard statements: H314 Causes severe skin burns and eye damage.',
    '',
    'SECTION 4: First aid measures',
    'IF IN EYES: Rinse cautiously with water for several minutes. Remove contact lenses, if present and easy to do. Continue rinsing.',
    'IF SWALLOWED: Rinse mouth. Do NOT induce vomiting.',
    '',
    'SECTION 14: Transport information',
    'Transport hazard class(es): Not regulated.',
    'UN number: None',
    '',
    'Use dilution: Dilute to a 1% solution for daily cleaning.',
  ].join('\n'),
};

const CAUTION_LABEL_SOURCE = {
  documentId: 'doc-label-2',
  title: 'Test Neutral Cleaner Label',
  documentBody: ['Product: Test Neutral Cleaner', 'Signal word: CAUTION'].join('\n'),
};

describe('evaluateRegulatedClaimGrounding — EPA registration', () => {
  it('passes when the reg number is quoted verbatim from the label', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'This product is EPA Reg. No. 1677-129.',
      sources: [LABEL_SOURCE],
    });
    expect(result.categoriesDetected).toContain('epa_registration');
    expect(result.ungroundedCategories).not.toContain('epa_registration');
  });

  it('fails when the reg number does not match any source (fabricated/wrong)', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'This product is EPA Reg. No. 9999-999.',
      sources: [LABEL_SOURCE],
    });
    expect(result.categoriesDetected).toContain('epa_registration');
    expect(result.ungroundedCategories).toContain('epa_registration');
    expect(result.ungroundedDetails.some((d) => d.category === 'epa_registration')).toBe(true);
  });
});

describe('evaluateRegulatedClaimGrounding — dilution ratio', () => {
  it('passes for the exact oz/gal value on the label, even with a slightly different unit spelling', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Use 2 oz/gal for general disinfection.',
      sources: [LABEL_SOURCE],
    });
    expect(result.categoriesDetected).toContain('dilution_ratio');
    expect(result.ungroundedCategories).not.toContain('dilution_ratio');
  });

  it('fails for a dilution value not present on the label (must not guess/round)', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Use 4 oz/gal for general disinfection.',
      sources: [LABEL_SOURCE],
    });
    expect(result.ungroundedCategories).toContain('dilution_ratio');
  });
});

describe('evaluateRegulatedClaimGrounding — contact time', () => {
  it('passes when the exact contact time is quoted', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Allow a 10 minute contact time on the surface.',
      sources: [LABEL_SOURCE],
    });
    expect(result.categoriesDetected).toContain('contact_time');
    expect(result.ungroundedCategories).not.toContain('contact_time');
  });

  it('fails for a fabricated contact time', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Allow a 30 minute contact time on the surface.',
      sources: [LABEL_SOURCE],
    });
    expect(result.ungroundedCategories).toContain('contact_time');
  });

  it('does not flag an unrelated number+time-unit mention with no contact/dwell context', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Orders typically ship within 5 minutes of confirmation.',
      sources: [LABEL_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('contact_time');
  });
});

describe('evaluateRegulatedClaimGrounding — hazard and first aid', () => {
  it('passes when the hazard sentence is quoted near-verbatim from the SDS/label', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Causes severe skin burns and eye damage. Wear protective gloves and eye protection.',
      sources: [LABEL_SOURCE],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).not.toContain('hazard');
  });

  it('fails when the hazard statement is paraphrased rather than quoted', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'This product is corrosive and may hurt your skin a bit, so be careful.',
      sources: [LABEL_SOURCE],
    });
    // "corrosive" matches the hazard trigger pattern but the sentence is not a verbatim
    // quote of anything in the source -- must be treated as ungrounded, not guessed-safe.
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('passes for a verbatim first-aid instruction and fails for a fabricated one', () => {
    const grounded = evaluateRegulatedClaimGrounding({
      draftAnswer: 'If swallowed, call a poison control center or doctor immediately.',
      sources: [LABEL_SOURCE],
    });
    expect(grounded.ungroundedCategories).not.toContain('first_aid');

    const ungrounded = evaluateRegulatedClaimGrounding({
      draftAnswer: 'If swallowed, induce vomiting immediately and drink a glass of milk.',
      sources: [LABEL_SOURCE],
    });
    expect(ungrounded.ungroundedCategories).toContain('first_aid');
  });
});

describe('evaluateRegulatedClaimGrounding — compatibility (B0-756)', () => {
  const COMPATIBILITY_SOURCE = {
    documentId: 'doc-label-3',
    title: 'Test Neutral Disinfectant Label',
    documentBody: [
      'Product: Test Neutral Disinfectant',
      '',
      'Surfaces & Use Sites:',
      'This product is safe for use on glazed porcelain, plastic, and stainless steel.',
    ].join('\n'),
  };

  it('passes when the compatibility statement is quoted verbatim from the label', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'This product is safe for use on glazed porcelain, plastic, and stainless steel.',
      sources: [COMPATIBILITY_SOURCE],
    });
    expect(result.categoriesDetected).toContain('compatibility');
    expect(result.ungroundedCategories).not.toContain('compatibility');
  });

  it('rejects the live-observed pH7Q fabrication: a stainless-steel claim with no supporting source', () => {
    // Confirmed live (2026-09-03): asked "Can I use pH7Q on stainless steel?", Bex answered this
    // sentence verbatim while the turn's tool result carried `sources: []` -- nothing retrieved
    // said anything about stainless steel at all.
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Per the pH7Q label and Betco Sustainability brochure, stainless steel is an approved surface for use.',
      sources: [],
    });
    expect(result.categoriesDetected).toContain('compatibility');
    expect(result.ungroundedCategories).toContain('compatibility');
  });

  it('does not flag generic facility/setting language as a compatibility claim', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'Recommended for use in hospitals, nursing homes, schools/colleges, commercial and industrial institutions.',
      sources: [COMPATIBILITY_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('compatibility');
  });

  it('fails when a different formulation\'s compatibility claim is extrapolated onto this product', () => {
    // The other half of B0-756: pH7Q Dual's label saying stainless steel is fine does not make it
    // true for plain pH7Q -- the sentence must be grounded against THIS turn's own sources.
    const dualOnlySource = {
      documentId: 'doc-label-4',
      title: 'Test Neutral Disinfectant Dual Label',
      documentBody: 'This product (Dual) is safe for use on stainless steel.',
    };
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'The standard formula is also safe for use on stainless steel.',
      sources: [dualOnlySource],
    });
    expect(result.ungroundedCategories).toContain('compatibility');
  });
});

describe('evaluateRegulatedClaimGrounding — B0-756 audit additions', () => {
  it('passes for a verbatim efficacy/kill claim and fails for a fabricated one', () => {
    const grounded = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Effective against Staphylococcus aureus with a 10 minute contact time.',
      sources: [LABEL_SOURCE],
    });
    expect(grounded.categoriesDetected).toContain('efficacy_claim');
    expect(grounded.ungroundedCategories).not.toContain('efficacy_claim');

    const fabricated = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Kills MRSA in 30 seconds.',
      sources: [LABEL_SOURCE],
    });
    expect(fabricated.ungroundedCategories).toContain('efficacy_claim');
  });

  it('does not flag generic marketing copy ("disinfects, cleans and deodorizes") as an efficacy claim', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'This concentrated multi-purpose, germicidal detergent and deodorant, disinfects, cleans and deodorizes in one labor-saving step.',
      sources: [LABEL_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('efficacy_claim');
  });

  it('passes for a verbatim CAS number and fails for a fabricated one', () => {
    const casSource = {
      documentId: 'doc-sds-2',
      title: 'Test Disinfectant SDS',
      documentBody: 'Sodium hypochlorite, CAS No. 7681-52-9, is the active ingredient.',
    };
    const grounded = evaluateRegulatedClaimGrounding({
      draftAnswer: 'The active ingredient is sodium hypochlorite, CAS No. 7681-52-9.',
      sources: [casSource],
    });
    expect(grounded.categoriesDetected).toContain('cas_number');
    expect(grounded.ungroundedCategories).not.toContain('cas_number');

    const fabricated = evaluateRegulatedClaimGrounding({
      draftAnswer: 'The active ingredient has CAS No. 1234-56-7.',
      sources: [casSource],
    });
    expect(fabricated.ungroundedCategories).toContain('cas_number');
  });

  it('passes for a verbatim DIN and fails for a fabricated one', () => {
    const dinSource = {
      documentId: 'doc-label-din',
      title: 'Test Disinfectant Canadian Label',
      documentBody: 'DIN 02345678',
    };
    const grounded = evaluateRegulatedClaimGrounding({
      draftAnswer: 'The Canadian DIN is 02345678.',
      sources: [dinSource],
    });
    expect(grounded.categoriesDetected).toContain('din_registration');
    expect(grounded.ungroundedCategories).not.toContain('din_registration');

    const fabricated = evaluateRegulatedClaimGrounding({
      draftAnswer: 'The Canadian DIN is 09999999.',
      sources: [dinSource],
    });
    expect(fabricated.ungroundedCategories).toContain('din_registration');
  });

  it('extracts and verifies ppm and mL/L dilution values', () => {
    const concentrationSource = {
      documentId: 'doc-label-ppm',
      title: 'Test Sanitizer Label',
      documentBody: 'Use at 200 ppm for sanitizing, or 25 mL/L for general cleaning.',
    };
    const grounded = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Use at 200 ppm for sanitizing, or 25 mL/L for general cleaning.',
      sources: [concentrationSource],
    });
    expect(grounded.categoriesDetected).toContain('dilution_ratio');
    expect(grounded.ungroundedCategories).not.toContain('dilution_ratio');

    const fabricated = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Use at 500 ppm for sanitizing.',
      sources: [concentrationSource],
    });
    expect(fabricated.ungroundedCategories).toContain('dilution_ratio');
  });
});

describe('evaluateRegulatedClaimGrounding — no regulated content', () => {
  it('detects nothing for a plain descriptive answer', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Test Disinfectant comes in a 1 gallon bottle and is part of the cleaning line.',
      sources: [LABEL_SOURCE],
    });
    expect(result.categoriesDetected).toHaveLength(0);
    expect(result.ungroundedCategories).toHaveLength(0);
  });

  it('does not flag anything when there are no sources at all and no regulated claim was made', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Test Disinfectant is a general-purpose cleaner.',
      sources: [],
    });
    expect(result.categoriesDetected).toHaveLength(0);
  });
});

/**
 * B0-366 — one case per rejected snippet observed in production `ungroundedDetails`. Each of
 * these was a false positive by construction: Markdown structure, a section heading, the model's
 * own framing sentence, or a bare percentage that is not a dilution ratio.
 */
describe('evaluateRegulatedClaimGrounding — B0-366 false positives', () => {
  it('grounds a first-aid line the model rendered as a Markdown bullet', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: '- If in eyes: Rinse cautiously with water for several minutes.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).toContain('first_aid');
    expect(result.ungroundedCategories).not.toContain('first_aid');
  });

  it('grounds a bolded, bulleted GHS signal word ("- **Signal word:** Danger")', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: '- **Signal word:** Danger',
      sources: [SDS_SOURCE],
    });
    expect(result.ungroundedCategories).not.toContain('hazard');
  });

  it('grounds a bulleted signal word whose value differs in case ("- Signal word: CAUTION")', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: '- Signal word: CAUTION',
      sources: [CAUTION_LABEL_SOURCE],
    });
    expect(result.ungroundedCategories).not.toContain('hazard');
  });

  it('does not treat a section heading ("**First aid measures:**") as a first-aid claim', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: '**First aid measures:**',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('first_aid');
    expect(result.ungroundedCategories).toHaveLength(0);
  });

  it("does not treat the model's own framing sentence as a hazard claim", () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'The hazard warnings for Betco HAN Non-Acid Bathroom Cleaner are as follows:',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('hazard');
    expect(result.ungroundedCategories).toHaveLength(0);
  });

  it('grounds a reformatted SDS section 14 line ("Transport hazard class(es): Not regulated.")', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Transport hazard class(es): Not regulated.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).not.toContain('hazard');
  });

  it('does not treat a bare efficacy percentage as a dilution ratio', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'In testing it was effective on 100% of tested surfaces.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('dilution_ratio');
  });

  it('still extracts and verifies a percentage presented as a dilution/concentration', () => {
    const grounded = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Dilute to a 1% solution for daily cleaning.',
      sources: [SDS_SOURCE],
    });
    expect(grounded.categoriesDetected).toContain('dilution_ratio');
    expect(grounded.ungroundedCategories).not.toContain('dilution_ratio');

    const fabricated = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Dilute to a 5% solution for daily cleaning.',
      sources: [SDS_SOURCE],
    });
    expect(fabricated.ungroundedCategories).toContain('dilution_ratio');
  });

  it('does not treat generic PPE / label-warning boilerplate as a hazard claim', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'Wear appropriate PPE when handling this product. Always follow all label warnings and use only as directed.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('hazard');
    expect(result.ungroundedCategories).toHaveLength(0);
  });
});

/**
 * B0-366 severity guard — the precision fixes above must not soften the hard rejection. Each of
 * these fabrications must still land in `ungroundedCategories` (the caller clamps confidence to
 * 0.4, disapproves, and raises a human-review task).
 */
describe('evaluateRegulatedClaimGrounding — fabrications still hard-rejected after B0-366', () => {
  it('rejects a fabricated dilution ratio', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Dilute at 6 oz. per gallon of water (1:21) for disinfection.',
      sources: [LABEL_SOURCE, SDS_SOURCE],
    });
    expect(result.ungroundedCategories).toContain('dilution_ratio');
    expect(
      result.ungroundedDetails.some((d) => d.category === 'dilution_ratio'),
    ).toBe(true);
  });

  it('rejects a fabricated hazard statement', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'This product is flammable and will cause permanent blindness on contact with the eyes.',
      sources: [LABEL_SOURCE, SDS_SOURCE],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('rejects a fabricated hazard statement even when it is rendered as a Markdown bullet', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: '- **Signal word:** Extreme Danger',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('rejects a fabricated EPA registration number', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'This product is registered under EPA Reg. No. 1677-321.',
      sources: [LABEL_SOURCE, SDS_SOURCE],
    });
    expect(result.categoriesDetected).toContain('epa_registration');
    expect(result.ungroundedCategories).toContain('epa_registration');
  });

  it('rejects a fabricated contact time', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Allow a 45 second contact time for bactericidal activity.',
      sources: [LABEL_SOURCE, SDS_SOURCE],
    });
    expect(result.categoriesDetected).toContain('contact_time');
    expect(result.ungroundedCategories).toContain('contact_time');
  });

  it('rejects a fabricated first-aid instruction rendered as a Markdown bullet', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: '- If in eyes: Apply an antibiotic ointment and bandage the eye.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).toContain('first_aid');
    expect(result.ungroundedCategories).toContain('first_aid');
  });
});

/**
 * B0-868 — `efficacy_claim` over-fired on knowledge-base prose. Each "not detected" sentence below
 * is a live golden-item sentence that was classified `efficacy_claim`, failed the verbatim check
 * (it is a paraphrase, not a label line) and replaced the whole answer with the canned decline.
 * None of them asserts an organism/kill claim about a product.
 */
describe('evaluateRegulatedClaimGrounding — B0-868 efficacy_claim precision', () => {
  const NOT_EFFICACY_CLAIMS = [
    'Dilution control systems eliminate guesswork by automatically blending concentrate with water.',
    'mixed with water every time, eliminating guesswork and overpouring.',
    'If dilution is inconsistent, disinfectants may not meet their kill claims.',
    'regulatory requirements for pathogen kill',
    'Cleaning removes dirt and soil from surfaces but does not kill or reduce germs.',
    'Disinfecting kills both viruses and bacteria.',
    'Eliminate odors at the source: clean drains, fixtures, and trash.',
    'Betco offers several EPA-registered disinfectants that are labeled as effective against norovirus.',
  ];

  for (const sentence of NOT_EFFICACY_CLAIMS) {
    it(`does not classify as efficacy_claim: "${sentence}"`, () => {
      const result = evaluateRegulatedClaimGrounding({ draftAnswer: sentence, sources: [] });
      expect(result.categoriesDetected).not.toContain('efficacy_claim');
      expect(result.ungroundedCategories).not.toContain('efficacy_claim');
    });
  }

  const STILL_EFFICACY_CLAIMS = [
    // Product name + organism: the right kind of catch, kept detected on purpose.
    'Neutral pH Disinfectant: Labeled to kill HIV-1 on pre-cleaned surfaces.',
    'Kills SARS-CoV-2 in one minute.',
    'pH7Q not only kills norovirus but also cleans in one step.',
    'pH7Q is effective against norovirus.',
    'This product achieves a 3-log reduction on hard non-porous surfaces.',
    'This product is bactericidal.',
    '- Kills MRSA in 30 seconds.',
  ];

  for (const sentence of STILL_EFFICACY_CLAIMS) {
    it(`still classifies as efficacy_claim and requires grounding: "${sentence}"`, () => {
      const result = evaluateRegulatedClaimGrounding({ draftAnswer: sentence, sources: [] });
      expect(result.categoriesDetected).toContain('efficacy_claim');
      expect(result.ungroundedCategories).toContain('efficacy_claim');
    });
  }

  it('still grounds a verbatim kill claim when the label is among the sources', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Effective against Staphylococcus aureus with a 10 minute contact time.',
      sources: [LABEL_SOURCE],
    });
    expect(result.categoriesDetected).toContain('efficacy_claim');
    expect(result.ungroundedCategories).not.toContain('efficacy_claim');
  });
});

/**
 * B0-869 — `compatibility` over-fired on procedural wood-floor guidance (every SportsZone decline)
 * and on hedged negatives. Only a sentence asserting that a NAMED product is safe/approved/
 * compatible on a NAMED surface is held to the verbatim-quote rule.
 */
describe('evaluateRegulatedClaimGrounding — B0-869 compatibility precision', () => {
  const NOT_COMPATIBILITY_CLAIMS = [
    'Clean the floor with an approved wood floor cleaner, such as Squeaky or Game Time.',
    'Ensure all cleaning products are approved for sealed wood athletic floors.',
    'Use only products labeled for use on sealed wood athletic floors.',
    "Use low-tack painter's tape or tape labeled as safe for finished wood/gym floors.",
    'Both methods are approved and commonly used for water-based wood floor finishes.',
    'Always pair water with an approved wood floor cleaner.',
    'Confirm that mats used are non-staining and suitable for use on wood floors.',
    'The Urethane Gloss Finish label specifies: Not recommended for floors previously maintained with oil-modified or solvent-based finishes.',
    'pH7Q is not specifically labeled for use on stainless steel; this is not an approved or documented application.',
    'Not recommended for linoleum, sheet vinyl, rubber, LVT (Per the LiquiStrip product line profile).',
    'It is suitable for use on all types of resilient tile (vinyl, VCT).',
    'It is recommended for use on floors, walls, toilets, sinks, glazed porcelain, and plastic.',
    'It is not recommended for linoleum or sheet vinyl.',
  ];

  for (const sentence of NOT_COMPATIBILITY_CLAIMS) {
    it(`does not classify as compatibility: "${sentence}"`, () => {
      const result = evaluateRegulatedClaimGrounding({ draftAnswer: sentence, sources: [] });
      expect(result.categoriesDetected).not.toContain('compatibility');
      expect(result.ungroundedCategories).not.toContain('compatibility');
    });
  }

  const STILL_COMPATIBILITY_CLAIMS = [
    'pH7Q is safe to use on stainless steel.',
    'Per the pH7Q label and Betco Sustainability brochure, stainless steel is an approved surface for use.',
    'The standard formula is also safe for use on stainless steel.',
    'Push will not etch marble or dull terrazzo.',
    // "not only" is an intensifier, not a negation -- must not slip through the conservative rule.
    'pH7Q is not only safe on stainless steel but also on brass.',
  ];

  for (const sentence of STILL_COMPATIBILITY_CLAIMS) {
    it(`still classifies as compatibility and rejects without a source: "${sentence}"`, () => {
      const result = evaluateRegulatedClaimGrounding({ draftAnswer: sentence, sources: [] });
      expect(result.categoriesDetected).toContain('compatibility');
      expect(result.ungroundedCategories).toContain('compatibility');
    });
  }
});

/**
 * B0-870 — hazard / first_aid fired on an offer sentence and on a "Source:" citation line, and the
 * `corrosive` trigger fired on a PRODUCT NAME ("Concentrated Non Corrosive Heavy Duty Restroom
 * Cleaner"). Sentences are the live P#17 / R#18 drafts verbatim.
 */
describe('evaluateRegulatedClaimGrounding — B0-870 offer sentences, citation lines, attributed quotes', () => {
  /** Body text of rag.document 8dd51230 (product_line_profile) around the quoted line, verbatim. */
  const RESTROOM_CLEANER_PROFILE_SOURCE = {
    documentId: '8dd51230-bcd6-4632-8928-3a16a4a78528',
    title: 'Concentrated Non Corrosive Heavy Duty Restroom Cleaner',
    documentBody:
      'acid resistant surfaces only. Do not use this product on marble, aluminum, terrazzo, Formicar or carpeting. Test in an inconspicuous area before use. Contains acids, do not use with bleach, ammonia or any other chemicals. Spray product on surface to be cleaned.',
  };

  it('does not treat a first-person offer to provide SDS sections as a hazard or first-aid claim (P#17)', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'I can provide information from the current SDS for Push, including hazard classification, first aid, handling, and storage details, if needed.',
      sources: [],
    });
    expect(result.categoriesDetected).not.toContain('hazard');
    expect(result.categoriesDetected).not.toContain('first_aid');
    expect(result.ungroundedCategories).toHaveLength(0);
  });

  it('never treats a "Source:" citation line as a claim, even when a cited title contains a trigger word (R#18b)', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'Source: Betco disinfection and chemical best practices; Concentrated Non Corrosive Heavy Duty Restroom Cleaner product label; Betco dilution control safety guidelines. [doc:17ebbaab-c6a1-4f3c-91ca-549db575a274] [doc:8dd51230-bcd6-4632-8928-3a16a4a78528]',
      sources: [],
    });
    expect(result.categoriesDetected).toHaveLength(0);
    expect(result.ungroundedCategories).toHaveLength(0);
  });

  it('does not let "Non Corrosive" in a product name trigger the hazard category (R#18a, live bullet verbatim)', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        '- Never mix acids with ammonia or bleach, as stated on the Concentrated Non Corrosive Heavy Duty Restroom Cleaner label: "Contains acids, do not use with bleach, ammonia or any other chemicals." (Source: Concentrated Non Corrosive Heavy Duty Restroom Cleaner label)',
      sources: [RESTROOM_CLEANER_PROFILE_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('hazard');
    expect(result.ungroundedCategories).toHaveLength(0);
  });

  it('grounds an attributed label quote via the quoted span when the label body is among the sources', () => {
    const draftAnswer =
      "- The label's hazard precaution reads: \"Contains acids, do not use with bleach, ammonia or any other chemicals.\"";
    const grounded = evaluateRegulatedClaimGrounding({
      draftAnswer,
      sources: [RESTROOM_CLEANER_PROFILE_SOURCE],
    });
    expect(grounded.categoriesDetected).toContain('hazard');
    expect(grounded.ungroundedCategories).not.toContain('hazard');

    const notRetrieved = evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] });
    expect(notRetrieved.ungroundedCategories).toContain('hazard');
  });

  it('does not let a genuine quote carry a fabricated hazard tail in the same sentence', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'The SDS states "Causes severe skin burns and eye damage" and the product is also highly flammable.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('does not treat bare "hazard" topic vocabulary as a claim', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Refer to the current SDS for hazard information before handling.',
      sources: [],
    });
    expect(result.categoriesDetected).not.toContain('hazard');
  });

  it('still treats "hazard" next to an imperative label precaution as a claim', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Hazard note: do not mix this product with bleach or ammonia.',
      sources: [],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('still requires grounding for a real GHS hazard transcription with no source (AC)', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Signal word: DANGER. H314 Causes severe skin burns and eye damage.',
      sources: [],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('still verifies a first-aid instruction that merely ends in "if needed"', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'If in eyes: rinse for 5 minutes and call a physician if needed.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).toContain('first_aid');
    expect(result.ungroundedCategories).toContain('first_aid');
  });
});

/**
 * B0-888 — the B0-871 sentence-redaction marker was firing on sentences that ARE supported by a
 * retrieved document but are paraphrased (not verbatim), and on sentences that are not product
 * claims at all (imperative caveats like "Caveat: Always confirm..."). These tests cover the three
 * fixes: (1) `hasProductSubject` no longer treats an imperative word right after a "Caveat:"/
 * "Note:"-style label as a product name; (2)/(3) a key-term-attributed or textually-adjacent
 * verbatim quote is sufficient grounding for a paraphrase of the same claim; and a regression proving
 * neither change weakens the guardrail against a genuinely fabricated claim.
 */
describe('evaluateRegulatedClaimGrounding — B0-888 label-prefixed imperatives are not product claims', () => {
  it('does not classify "Caveat: Always confirm..." as a compatibility claim', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Caveat: Always confirm mats are compatible with wood floors before use.',
      sources: [],
    });
    expect(result.categoriesDetected).not.toContain('compatibility');
    expect(result.ungroundedCategories).not.toContain('compatibility');
  });

  it('does not classify other label + imperative-opener combinations as a compatibility claim', () => {
    const NOT_CLAIMS = [
      'Note: Never mix this cleaner with bleach on stainless steel surfaces.',
      'Important: Ensure mats are compatible with wood floors before installation.',
      'Tip: Test a small area of wood flooring before use.',
    ];
    for (const draftAnswer of NOT_CLAIMS) {
      const result = evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] });
      expect(result.categoriesDetected, draftAnswer).not.toContain('compatibility');
    }
  });

  // B0-984 — live sentence from SportsZone golden item 22b61cfb (game-line tape): read as a
  // compatibility claim about a product called "Use", which forced `list_allowed_surfaces("3M Game
  // Line Tape")` and then got redacted. A generic-guidance label plus an imperative is advice.
  it('does not classify "General guidance: Use only low tack…" as a compatibility claim (B0-984)', () => {
    const NOT_CLAIMS = [
      "**General guidance:** Use only low tack painter's tape or tape labeled/approved for finished wood/gym floors, and remove it as soon as possible.",
      'Recommendation: Apply only finishes labeled for wood gym floors.',
      'Best practice: Keep mats compatible with wood floors under every entry.',
    ];
    for (const draftAnswer of NOT_CLAIMS) {
      const result = evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] });
      expect(result.categoriesDetected, draftAnswer).not.toContain('compatibility');
    }
  });

  // B0-984 — a capitalised word right after a colon or dash starts a clause; it is not a product.
  it('does not treat the capitalised first word after a colon or dash as a product name (B0-984)', () => {
    const NOT_CLAIMS = [
      'Step 1 — Apply the finish only to surfaces approved for wood floors.',
      'Before coating: Confirm the tape is approved for finished gym floors.',
    ];
    for (const draftAnswer of NOT_CLAIMS) {
      const result = evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] });
      expect(result.categoriesDetected, draftAnswer).not.toContain('compatibility');
    }
    // …while a real mid-sentence product name still counts.
    const claim = evaluateRegulatedClaimGrounding({
      draftAnswer: 'For gym floors, GymShoe is approved for use on finished wood.',
      sources: [],
    });
    expect(claim.categoriesDetected).toContain('compatibility');
  });

  it('still classifies a compatibility claim when the label prefix is followed by a real product name, not an imperative', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Note: Push is safe for use on stainless steel.',
      sources: [],
    });
    expect(result.categoriesDetected).toContain('compatibility');
    expect(result.ungroundedCategories).toContain('compatibility');
  });
});

describe('evaluateRegulatedClaimGrounding — B0-888 key-term fallback and adjacent-quote grounding', () => {
  const HIV_LABEL_SOURCE = {
    documentId: 'doc-label-hiv',
    title: 'Test Disinfectant Label',
    documentBody: 'Kills HIV-1 on pre-cleaned environmental surfaces in 1 minute.',
  };

  it('grounds an ungrounded efficacy paraphrase immediately followed by a grounded verbatim quote of the same claim', () => {
    const draftAnswer =
      'This product is labeled to kill HIV-1 on pre-cleaned environmental surfaces. ' +
      'The label states: "Kills HIV-1 on pre-cleaned environmental surfaces in 1 minute."';
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer,
      sources: [HIV_LABEL_SOURCE],
    });
    expect(result.categoriesDetected).toContain('efficacy_claim');
    expect(result.ungroundedCategories).not.toContain('efficacy_claim');
    expect(result.keyTermGroundedCategories).toContain('efficacy_claim');
  });

  it('still redacts the same efficacy paraphrase when no supporting source exists anywhere (regression)', () => {
    const draftAnswer = 'This product is labeled to kill HIV-1 on pre-cleaned environmental surfaces.';
    const result = evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] });
    expect(result.categoriesDetected).toContain('efficacy_claim');
    expect(result.ungroundedCategories).toContain('efficacy_claim');
  });

  it('grounds a paraphrase attributed to a specific source via the key-term fallback ("per the X label")', () => {
    const PH7Q_LABEL_SOURCE = {
      documentId: 'doc-label-ph7q-compat',
      title: 'pH7Q Dual Label',
      documentBody: 'pH7Q Dual is safe for use on stainless steel and other acid-resistant surfaces.',
    };
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Per the pH7Q Dual label, stainless steel surfaces are compatible with this cleaner.',
      sources: [PH7Q_LABEL_SOURCE],
    });
    expect(result.categoriesDetected).toContain('compatibility');
    expect(result.ungroundedCategories).not.toContain('compatibility');
    expect(result.keyTermGroundedCategories).toContain('compatibility');
  });

  it('does NOT ground a fabricated organism claim against a source that never mentions it (regression, proves the guardrail was not weakened)', () => {
    const UNRELATED_SOURCE = {
      documentId: 'doc-label-unrelated',
      title: 'Test Neutral Cleaner Label',
      documentBody: 'Dilute at 2 oz per gallon of water. Safe for use on sealed floors.',
    };
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'This product kills Ebola virus on contact.',
      sources: [UNRELATED_SOURCE],
    });
    expect(result.categoriesDetected).toContain('efficacy_claim');
    expect(result.ungroundedCategories).toContain('efficacy_claim');
    expect(result.keyTermGroundedCategories).not.toContain('efficacy_claim');
  });

  it('does NOT ground a fabricated compatibility claim merely because an unrelated source is retrieved (regression)', () => {
    const UNRELATED_SOURCE = {
      documentId: 'doc-label-unrelated-2',
      title: 'Test Neutral Cleaner Label',
      documentBody: 'Dilute at 2 oz per gallon of water for daily use.',
    };
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'This product is safe for use on stainless steel.',
      sources: [UNRELATED_SOURCE],
    });
    expect(result.categoriesDetected).toContain('compatibility');
    expect(result.ungroundedCategories).toContain('compatibility');
  });

  it('never applies the key-term fallback to hazard claims -- verbatim is still required', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'This product causes severe skin burns per the label.',
      sources: [
        {
          documentId: 'doc-label-hazard',
          title: 'Test Label',
          documentBody: 'Causes irreversible eye damage. Wear protective gloves.',
        },
      ],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });
});

/**
 * B0-915 — the `hazard` / `first_aid` detectors classified Bex's OWN meta-commentary as regulated
 * claims. Because that prose can never be verified verbatim against a retrieved label, each one
 * escalated the guardrail to `redactionMode: decline` and replaced the entire answer with refusal
 * copy (the grader scored those non-answers at clarity 35 and 50 against 93/94 for the same
 * question answered by the other vendor). Every "must not flag" draft below is a live
 * `ungroundedDetails` snippet, verbatim, from five eval runs across both answering vendors.
 *
 * The second half is the important half: the offer/pointer/generic exclusion is hard-gated, so a
 * real GHS statement, H-code, product-specific precaution or SDS first-aid procedure is still a
 * regulated claim requiring verbatim grounding no matter how much framing surrounds it.
 */
describe('evaluateRegulatedClaimGrounding — B0-915 offer / pointer / generic-safety prose', () => {
  it('does not flag generic safety-and-training advice that transcribes no label value', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        '1. **Train for safety and consistency** - proper dilution, PPE use, never mix chemicals, clear written SOPs.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('hazard');
    expect(result.ungroundedCategories).toHaveLength(0);
  });

  it('does not flag a pointer naming the product label / SDS as the governing source', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        "For any specific Betco product in use, the governing PPE and ventilation instructions are the product label's precautionary statements and **SDS Section 8 (Exposure Controls / Personal Protection)** - follow those over any general guidance",
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('hazard');
    expect(result.ungroundedCategories).toHaveLength(0);
  });

  it('does not flag an offer to supply SDS content listed as a menu of sections', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        '- I can supply the current Push SDS content instead - hazard identification (Section 2), first aid (Section 4), handling and storage (Section 7), PPE (Section 8), or incompatible materials (Section 10) - as well as current label facts such',
      sources: [],
    });
    expect(result.categoriesDetected).not.toContain('first_aid');
    expect(result.categoriesDetected).not.toContain('hazard');
    expect(result.ungroundedCategories).toHaveLength(0);
  });

  it('does not flag generic emergency guidance that points back at the label and SDS', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'If a mix occurs and anyone is exposed, evacuate and ventilate the area, then call Poison Control (1-800-222-1222 in the US) or emergency services immediately, with the label and SDS in hand.',
      sources: [],
    });
    expect(result.categoriesDetected).not.toContain('first_aid');
    expect(result.ungroundedCategories).toHaveLength(0);
  });
});

/**
 * B0-915 severity guard — every one of these must still be detected and, with no source carrying
 * it, still land in `ungroundedCategories`. Several deliberately wrap the regulated content in the
 * exact offer/pointer/training framing the exclusion above looks for, proving the gate wins.
 */
describe('evaluateRegulatedClaimGrounding — B0-915 real statements are still caught', () => {
  it('still catches a prescribed treatment action riding along with an emergency referral', () => {
    // Review guard on B0-915: `EMERGENCY_REFERRAL_PATTERN` excludes a sentence on the words
    // "Poison Control" alone. A fabricated treatment instruction must not inherit that exemption --
    // it names no exposure route, so the first-aid procedure pattern misses it, and "2 oz" with no
    // "/gal" is not a dilution token, so this category is the only thing standing in front of it.
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'Call Poison Control immediately and administer 2 oz of activated charcoal while you wait.',
      sources: [],
    });
    expect(result.categoriesDetected).toContain('first_aid');
    expect(result.ungroundedCategories).toContain('first_aid');
  });

  it('still catches a transcribed GHS signal word', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Signal word: DANGER',
      sources: [],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('still catches an explicit hazard statement', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Causes severe skin burns and eye damage.',
      sources: [],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('still catches an H-code even inside label/SDS pointer framing', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'Per the label, hazard statement H314 applies; refer to the SDS for the full precautionary statements.',
      sources: [],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('still catches a product-specific imperative precaution', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Hazard note: do not mix with chlorinated products.',
      sources: [],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('still catches a product-specific precaution wrapped in training framing', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Training note: always wear PPE and never mix with chlorinated products.',
      sources: [],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('still classifies a first-aid instruction transcribed from SDS section 4, and rejects a fabricated one', () => {
    const grounded = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'If in eyes: Rinse cautiously with water for several minutes. Remove contact lenses, if present and easy to do. Continue rinsing.',
      sources: [SDS_SOURCE],
    });
    expect(grounded.categoriesDetected).toContain('first_aid');
    expect(grounded.ungroundedCategories).not.toContain('first_aid');

    const fabricated = evaluateRegulatedClaimGrounding({
      draftAnswer: 'If in eyes, flush with warm milk and apply an antibiotic ointment.',
      sources: [SDS_SOURCE],
    });
    expect(fabricated.categoriesDetected).toContain('first_aid');
    expect(fabricated.ungroundedCategories).toContain('first_aid');
  });

  it('still catches an exposure-route first-aid line even though it only refers the user to Poison Control', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'If swallowed, call a poison control center or doctor immediately.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).toContain('first_aid');
    expect(result.ungroundedCategories).toContain('first_aid');
  });

  it('leaves the token categories untouched inside offer / pointer framing', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'I can supply the current Push SDS content instead. Per the label, dilute at 6 oz. per gallon (1:21), allow a 45 second contact time, and it is registered under EPA Reg. No. 1677-321.',
      sources: [LABEL_SOURCE, SDS_SOURCE],
    });
    expect(result.ungroundedCategories).toContain('dilution_ratio');
    expect(result.ungroundedCategories).toContain('contact_time');
    expect(result.ungroundedCategories).toContain('epa_registration');
  });

  it('leaves compatibility detection untouched inside training framing', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Training note: this product is safe for use on stainless steel.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).toContain('compatibility');
    expect(result.ungroundedCategories).toContain('compatibility');
  });
});

/**
 * B0-928 — three more live `ungroundedDetails` snippets (golden set, gpt-5.6, 2026-09-10,
 * app_version 4.4.0) classified `hazard` and, being unquotable, escalated to `redactionMode:
 * decline`, replacing each whole answer with 257 characters of refusal copy. Two root causes:
 *
 *  1. IMPERATIVE WITHOUT AN OBJECT -- `isHazardClaimSentence` accepted a bare
 *     `HAZARD_IMPERATIVE_PATTERN` hit next to "PPE"/"caution", while `carriesTranscribedLabelValue`
 *     (B0-915) required the same imperative to name an incompatibility or ignition source. Generic
 *     safe-work boilerplate ("never mix chemicals") satisfied the first and not the second.
 *  2. CLASS-LEVEL CHEMISTRY COMPARISON -- the un-negated "flammable" in a solvent-based vs.
 *     water-based coating contrast is not a transcribed label value.
 */
describe('evaluateRegulatedClaimGrounding — B0-928 safe-work boilerplate and class comparisons', () => {
  it('does not flag safe-work boilerplate whose only imperative names no incompatibility', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'Wear the PPE required by each product label/SDS, ventilate the area, post wet-floor signs, and never mix chemicals.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('hazard');
    expect(result.ungroundedCategories).toHaveLength(0);
  });

  it('does not flag the same boilerplate under a bolded "Safety:" lead-in', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        '**Safety:** Wear the PPE specified by each product label and SDS, post caution signs before beginning, maintain ventilation, and never mix cleaning chemicals.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('hazard');
    expect(result.ungroundedCategories).toHaveLength(0);
  });

  it('does not flag a generic solvent-based vs. water-based coating comparison', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'Solvent-based oil-modified urethanes are described as flammable, higher-VOC coatings with fumes/odors; water-based coatings are described as nonflammable, low-odor, and low-VOC.',
      sources: [SDS_SOURCE],
    });
    expect(result.categoriesDetected).not.toContain('hazard');
    expect(result.ungroundedCategories).toHaveLength(0);
  });
});

/**
 * B0-928 severity guard — neither fix may soften a real transcription. The last case is the one
 * that matters most: a class comparison that ALSO carries a GHS value token is still a hazard
 * claim, because the exclusion is hard-gated on `GHS_VALUE_TOKEN_PATTERN`.
 */
describe('evaluateRegulatedClaimGrounding — B0-928 real hazard statements are still caught', () => {
  const STILL_HAZARD = [
    'Signal word: DANGER.',
    'Causes severe skin burns and eye damage.',
    'H314 — causes severe skin burns.',
    // Both imperative precautions name an object, so the tightened conjunction still fires. They
    // carry a qualified trigger word because `isHazardClaimSentence` has always required one for
    // the imperative branch -- see the bare-imperative test below.
    'Hazard note: do not mix with chlorinated products or bleach.',
    'Warning: keep away from heat, sparks and open flame.',
    'Solvent-based and water-based coatings differ; the solvent-based product carries signal word DANGER.',
    // Two PRODUCT-FORM nouns and no chemistry class: "the sealer and the coating" names two things,
    // it does not contrast two chemistries, so the class-comparison exclusion must not apply.
    'Warning: the sealer and the coating are corrosive.',
  ];

  for (const draftAnswer of STILL_HAZARD) {
    it(`still detects and rejects: ${draftAnswer}`, () => {
      const result = evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] });
      expect(result.categoriesDetected, draftAnswer).toContain('hazard');
      expect(result.ungroundedCategories, draftAnswer).toContain('hazard');
    });
  }

  // Pre-existing and unchanged by B0-928: the imperative branch of `isHazardClaimSentence` sits
  // behind `HAZARD_QUALIFIED_TRIGGER_PATTERN`, so a bare label precaution with no
  // hazard/warning/caution/PPE word and no hazard adjective was never in this category -- B0-928
  // only added `PRECAUTION_OBJECT_PATTERN` to a branch these sentences never reached. Pinned so a
  // future change to that trigger gate is a deliberate decision, not a silent one.
  it('leaves the pre-existing bare-imperative gap exactly as it was', () => {
    for (const draftAnswer of [
      'Do not mix with chlorinated products or bleach.',
      'Keep away from heat, sparks and open flame.',
    ]) {
      const result = evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] });
      expect(result.categoriesDetected, draftAnswer).not.toContain('hazard');
    }
  });
});

/**
 * B0-947 — `planRegulatedClaimRedaction`'s product-usage-specific test. Before this ticket the
 * test was a two-term proxy (locked product line AND label-led retrieval) with no question-shape
 * term at all, so a catalog-identity question — which resolves a product line by construction and
 * retrieves that product's label — scored as product-usage-specific and took the full decline.
 * Golden run 61e80e45 row 2 ("Do you have a product called Hard as Nailz?") scored 0.00 that way.
 */
describe('planRegulatedClaimRedaction — product-usage-specific requires a usage-shaped question (B0-947)', () => {
  const COMPAT_SENTENCE =
    'The product is suitable for use on all types of resilient tile, including vinyl composition, vinyl, and linoleum.';
  const IDENTITY_ANSWER =
    'The closest match in the Betco catalog is Hard As Nails, spelled without a "z" at the end. It is a Basic Coatings wood floor product, and no separate item named "Hard as Nailz" exists in the catalog today.';

  const LOCKED: ProductLineLock = {
    candidates: [{ productLineKey: 'hard-as-nails', label: 'Hard As Nails', maxSimilarity: 0.94 }],
    lockedProductLineKey: 'hard-as-nails',
    lockReason: 'explicit_filter',
  };

  /** Label-led retrieval: knowledge-kind sources do NOT dominate. */
  const LABEL_LED_SOURCES = [{ documentKind: 'label' }, { documentKind: 'label' }];

  function planFor(userMessage: string, draftAnswer = `${IDENTITY_ANSWER} ${COMPAT_SENTENCE}`) {
    return planRegulatedClaimRedaction({
      draftAnswer,
      userMessage,
      grounding: {
        categoriesDetected: ['compatibility'],
        ungroundedCategories: ['compatibility'],
        ungroundedDetails: [{ category: 'compatibility', snippet: COMPAT_SENTENCE }],
        keyTermGroundedCategories: [],
      },
      productLineLock: LOCKED,
      sources: LABEL_LED_SOURCES,
    });
  }

  it('withholds the sentence for an identity question even with a lock and label-led sources', () => {
    const plan = planFor('Do you have a product called Hard as Nailz?');
    expect(plan.mode).toBe('sentence_redaction');
    if (plan.mode === 'decline') return;
    expect(plan.redactedText).toContain(IDENTITY_ANSWER);
    expect(plan.redactedText).not.toContain(COMPAT_SENTENCE);
    // The removed text is replaced by a marker, never rephrased.
    expect(plan.redactedText).toContain(
      '[one compatibility statement withheld — not verifiable against a retrieved label]',
    );
    expect(plan.withheldCategories).toEqual(['compatibility']);
  });

  it('still declines for a usage-shaped question on the same lock and sources', () => {
    for (const question of [
      'How do I use pH7Q on a hospital floor?',
      'Can I use Hard As Nails on linoleum?',
      'Is it safe to use Hard As Nails over a wax finish?',
      'What PPE does Hard As Nails require?',
    ]) {
      const plan = planFor(question);
      expect(plan.mode, question).toBe('decline');
      if (plan.mode !== 'decline') continue;
      expect(plan.reason, question).toBe('product_usage_specific_question');
    }
  });

  it('still declines for a question about this product’s own label claims', () => {
    // B0-872's `hasUsageSafetyQuestionShape` is tuned for "how do I use / is it safe" and matches
    // none of these, so the usage-shape term alone would have let them REDACT — losing exactly the
    // compatibility sentence the user asked about. These ask what this product's label approves,
    // which is the case B0-871 kept on the full decline; the chemical-mixing ones most of all.
    for (const question of [
      'Is pH7Q Dual compatible with bleach in the dispenser?',
      'Can I mix pH7Q with bleach?',
      'What surfaces is Hard As Nails approved for?',
      'Is Hard As Nails rated for use over epoxy?',
    ]) {
      const plan = planFor(question);
      expect(plan.mode, question).toBe('decline');
      if (plan.mode !== 'decline') continue;
      expect(plan.reason, question).toBe('product_usage_specific_question');
    }
  });

  it('still declines outright for an ungrounded hazard sentence, whatever the question shape', () => {
    const hazard = 'Causes severe skin burns and eye damage.';
    for (const question of [
      'Do you have a product called Hard as Nailz?',
      'How do I use Hard As Nails safely?',
    ]) {
      const plan = planRegulatedClaimRedaction({
        draftAnswer: `${IDENTITY_ANSWER} ${hazard}`,
        userMessage: question,
        grounding: {
          categoriesDetected: ['hazard'],
          ungroundedCategories: ['hazard'],
          ungroundedDetails: [{ category: 'hazard', snippet: hazard }],
          keyTermGroundedCategories: [],
        },
        productLineLock: LOCKED,
        sources: LABEL_LED_SOURCES,
      });
      expect(plan.mode, question).toBe('decline');
      if (plan.mode !== 'decline') continue;
      expect(plan.reason, question).toBe('safety_critical_sentence_category');
    }
  });

  it('still applies the substantive-content guard to an identity question', () => {
    const plan = planFor('Do you have a product called Hard as Nailz?', `Yes. ${COMPAT_SENTENCE}`);
    expect(plan.mode).toBe('decline');
    if (plan.mode !== 'decline') return;
    expect(plan.reason).toBe('nothing_substantive_remains');
  });
});
