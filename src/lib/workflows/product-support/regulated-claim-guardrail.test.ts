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

  it('still declines a hazard claim whose value term is absent from the source (B0-923 value-term path)', () => {
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
 * B0-1052 — fourth variant of the B0-870/B0-915/B0-928/B0-998 hazard false-positive family, this
 * one specific to markdown bullet-list formatting. Live failure: the SportsZone Specialist item
 * "When to choose water vs solvent based for a wooden gym floor?" (test item
 * 31024c03-c995-4daa-a102-71417cb7cf5c). The model's draft put the chemistry-class term in a bold
 * bullet HEADER and "flammable" in the sub-bullet BODY on the next line:
 *
 *   **Solvent-based (oil-modified) finishes:**
 *   - Higher VOCs and stronger odor; some are flammable, requiring special handling and ventilation.
 *
 * `splitIntoSentences` treats the newline as a sentence boundary, so by the time
 * `isGenericMaterialClassComparison` (B0-928/B0-998) ran on the sub-bullet alone it saw zero
 * chemistry-class terms (the header carries "solvent-based", not the body) and never excused it --
 * the whole correct, well-cited answer was replaced with generic hazard decline copy, discarding the
 * must-have "water-based contains lower VOCs" concept along with it.
 */
describe('evaluateRegulatedClaimGrounding — B0-1052 bullet-header / sub-bullet chemistry context', () => {
  it('does not flag a sub-bullet "flammable" mention whose chemistry-class term lives in the bullet header above it', () => {
    const draftAnswer = [
      'For a wooden gym floor, the choice depends on the finish chemistry:',
      '',
      '**Solvent-based (oil-modified) finishes:**',
      '- Higher VOCs and stronger odor; some are flammable, requiring special handling and ventilation.',
      '',
      '**Water-based finishes:**',
      '- Water-based finishes contain lower VOCs than solvent-based options, dry faster, and clean up with water.',
    ].join('\n');

    const result = evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] });
    expect(result.categoriesDetected).not.toContain('hazard');
    expect(result.ungroundedCategories).not.toContain('hazard');
  });

  it('does not require the header to be the literal first line of the answer', () => {
    // Same shape, reordered so the water-based bullet (no hazard trigger) comes first -- pins that
    // the exclusion looks at the sub-bullet's OWN immediately preceding line, not the answer start.
    const draftAnswer = [
      '**Water-based finishes:**',
      '- Contain lower VOCs than solvent-based options and clean up with water.',
      '',
      '**Solvent-based (oil-modified) finishes:**',
      '- Higher VOCs; some are flammable and require special handling and ventilation.',
    ].join('\n');

    const result = evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] });
    expect(result.categoriesDetected).not.toContain('hazard');
  });

  it('still declines a genuine product-specific hazard claim in a sub-bullet with no chemistry-class header above it', () => {
    const draftAnswer = [
      '**Push (floor stripper) precautions:**',
      '- This product is corrosive and causes severe skin burns; wear gloves and eye protection.',
    ].join('\n');

    const result = evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('still declines a bare "flammable" sub-bullet when the preceding line is not a chemistry-class header', () => {
    const draftAnswer = [
      '**General safety notes:**',
      '- Some finishes are flammable and require special handling and ventilation.',
    ].join('\n');

    const result = evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('still declines a hazard statement carrying a real GHS value token even under a chemistry header', () => {
    // Hard-gated the same way B0-928's exclusion is: a value-bearing GHS token anywhere in the
    // combined header+body text means this is a real transcribed label statement, not a generic
    // class comparison, regardless of the header's chemistry-class wording.
    const draftAnswer = [
      '**Solvent-based (oil-modified) finishes:**',
      '- Signal word: DANGER. This product is flammable.',
    ].join('\n');

    const result = evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).toContain('hazard');
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

  function hazardPlan(question: string, category: 'hazard' | 'first_aid', sentence: string) {
    return planRegulatedClaimRedaction({
      draftAnswer: `${IDENTITY_ANSWER} ${sentence}`,
      userMessage: question,
      grounding: {
        categoriesDetected: [category],
        ungroundedCategories: [category],
        ungroundedDetails: [{ category, snippet: sentence }],
        keyTermGroundedCategories: [],
      },
      productLineLock: LOCKED,
      sources: LABEL_LED_SOURCES,
    });
  }

  it('still declines outright for an ungrounded hazard / first-aid sentence on a safety or exposure question (B0-1131)', () => {
    const hazard = 'Causes severe skin burns and eye damage.';
    const firstAid = 'If in eyes, rinse cautiously with water for 15 minutes.';
    for (const question of [
      'How do I use Hard As Nails safely?',
      'What PPE does Hard As Nails require?',
      'Someone got floor stripper splashed in their eyes. What do I do?',
      'Is Hard As Nails flammable?',
      'My employee breathed in the fumes, is that dangerous?',
      'Can I mix Hard As Nails with bleach?',
    ]) {
      for (const [category, sentence] of [['hazard', hazard], ['first_aid', firstAid]] as const) {
        const plan = hazardPlan(question, category, sentence);
        expect(plan.mode, `${category}: ${question}`).toBe('decline');
        if (plan.mode !== 'decline') continue;
        expect(plan.reason, question).toBe('safety_critical_sentence_category');
      }
    }
  });

  it('withholds only the hazard / first-aid sentence on a non-safety question, keeping the rest (B0-1131 ROW-01)', () => {
    const hazard = 'For Push, there are no known significant hazards, and no special signal word or hazard statements are required.';
    for (const question of ['Do you have a product called Hard as Nailz?', 'Where do I find the SDS for Push?']) {
      const plan = hazardPlan(question, 'hazard', hazard);
      expect(plan.mode, question).toBe('sentence_redaction');
      if (plan.mode === 'decline') continue;
      expect(plan.redactedText).toContain(IDENTITY_ANSWER);
      expect(plan.redactedText).not.toContain(hazard);
      expect(plan.redactedText).toContain('[one hazard statement withheld — not verifiable against a retrieved label]');
      expect(plan.withheldCategories).toEqual(['hazard']);
    }
  });

  it('still applies the substantive-content guard to an identity question', () => {
    const plan = planFor('Do you have a product called Hard as Nailz?', `Yes. ${COMPAT_SENTENCE}`);
    expect(plan.mode).toBe('decline');
    if (plan.mode !== 'decline') return;
    expect(plan.reason).toBe('nothing_substantive_remains');
  });
});

/**
 * B0-1024 — a PURE token-shaped rejection (every ungrounded category is EPA/DIN/dilution/contact
 * time/CAS) with no OTHER regulated category grounded elsewhere used to decline the whole draft
 * (`nothing_grounded_to_keep`) BEFORE ever attempting redaction, discarding substantial
 * non-regulated-claim content that had nothing to do with the flagged claim. Fixture mirrors the
 * live golden-run failure (Product Golden Dataset row 3, "What is the best glass cleaner?",
 * `test_result_items` `a74a27e0`): the model's real draft was a correct multi-product
 * recommendation list with one product's dilution figure unverifiable.
 */
describe('planRegulatedClaimRedaction — pure token-shaped rejection redacts instead of declining when non-claim content survives (B0-1024)', () => {
  const RECOMMENDATION_DRAFT = [
    'There is no documented basis to rank one product as best. Here are the options:',
    'Product A is a ready-to-use glass cleaner for everyday use.',
    'Product B is a concentrate diluted at 2 oz/gal for heavy soil.',
    'Product C is a ready-to-use aerosol cleaner with a streak-free finish.',
  ].join(' ');

  it('redacts only the ungrounded dilution sentence and keeps the rest of the product list', () => {
    const plan = planRegulatedClaimRedaction({
      draftAnswer: RECOMMENDATION_DRAFT,
      userMessage: 'What is the best glass cleaner?',
      grounding: {
        categoriesDetected: ['dilution_ratio'],
        ungroundedCategories: ['dilution_ratio'],
        ungroundedDetails: [{ category: 'dilution_ratio', snippet: '2 oz/gal' }],
        keyTermGroundedCategories: [],
      },
      productLineLock: null,
      sources: [],
    });
    expect(plan.mode).toBe('token_redaction');
    if (plan.mode !== 'token_redaction') return;
    expect(plan.redactedText).toContain('Product A is a ready-to-use glass cleaner for everyday use.');
    expect(plan.redactedText).toContain(
      'Product C is a ready-to-use aerosol cleaner with a streak-free finish.',
    );
    expect(plan.redactedText).not.toContain('2 oz/gal');
    expect(plan.redactedText).toContain(
      '[one dilution ratio withheld — not verifiable against a retrieved label]',
    );
    expect(plan.withheldCategories).toEqual(['dilution_ratio']);
  });

  it('still declines when the entire draft IS the ungroundable claim, nothing left to salvage', () => {
    const plan = planRegulatedClaimRedaction({
      draftAnswer: 'Dilute at 2 oz/gal for general use.',
      userMessage: 'What is the dilution rate?',
      grounding: {
        categoriesDetected: ['dilution_ratio'],
        ungroundedCategories: ['dilution_ratio'],
        ungroundedDetails: [{ category: 'dilution_ratio', snippet: '2 oz/gal' }],
        keyTermGroundedCategories: [],
      },
      productLineLock: null,
      sources: [],
    });
    expect(plan.mode).toBe('decline');
    if (plan.mode !== 'decline') return;
    expect(plan.reason).toBe('nothing_grounded_to_keep');
  });

  it('keeps the historical short-answer exemption when another category IS grounded, however little remains', () => {
    const plan = planRegulatedClaimRedaction({
      draftAnswer: 'EPA Reg. No. 1677-129. Dilute at 2 oz/gal.',
      userMessage: 'What is the EPA registration and dilution rate?',
      grounding: {
        categoriesDetected: ['epa_registration', 'dilution_ratio'],
        ungroundedCategories: ['dilution_ratio'],
        ungroundedDetails: [{ category: 'dilution_ratio', snippet: '2 oz/gal' }],
        keyTermGroundedCategories: [],
      },
      productLineLock: null,
      sources: [],
    });
    expect(plan.mode).toBe('token_redaction');
    if (plan.mode !== 'token_redaction') return;
    expect(plan.redactedText).toContain('EPA Reg. No. 1677-129.');
  });
});

/**
 * B0-985 — the redaction planner blanked ungrounded TOKENS before locating ungrounded SENTENCES,
 * so a sentence that was both an ungrounded efficacy claim and contained an ungrounded contact
 * time could never be found again and the whole answer hard-declined
 * (`declineReason: snippet_not_found_in_draft`). Fixture: item c175d99e ("Is GE Fight Bac RTU
 * approved for use in my state?") on golden run 63d4dba3 — draft verbatim from the run's
 * `response_payload.draftAnswer`, gate record `ungroundedCategories: [contact_time, efficacy_claim]`.
 */
describe('planRegulatedClaimRedaction — sentence details are located before token replacement (B0-985)', () => {
  const C175D99E_KILL_CLAIM_BULLET =
    '- The product carries a wide range of kill claims, including SARS-CoV-2 (cause of COVID-19) with a 60-second contact time, and many bacteria and viruses with contact times ranging from 60 to 600 seconds.';
  const C175D99E_DRAFT = [
    'GE Fight Bac RTU is EPA-registered under EPA Reg. No. 34810-35-4170, but the retrieved documentation does not specify approval for individual states.',
    '',
    '- GE Fight Bac RTU is a ready-to-use disinfectant (no dilution required).',
    '- EPA Reg. No.: 34810-35-4170, per the verified product facts and product label.',
    C175D99E_KILL_CLAIM_BULLET,
    '- State-level approval is not listed in the retrieved documentation; some states require additional registration beyond EPA approval.',
    '',
    'To confirm approval for use in your specific state, please contact Betco Regulatory Affairs or your state’s pesticide regulatory agency. I can provide the full product label and SDS if needed.',
    '',
    'Source: GE Fight Bac RTU verified product facts; GE Fight Bac RTU product label. [doc:verified-facts] [doc:3d46dbf6-76fe-41a1-8c62-5dfc09c7e298]',
  ].join('\n');

  const NO_LOCK: ProductLineLock = {
    candidates: [],
    lockedProductLineKey: null,
    lockReason: 'skipped_ambiguous',
  };

  function plan(draftAnswer: string, details: Array<{ category: 'contact_time' | 'efficacy_claim'; snippet: string }>) {
    return planRegulatedClaimRedaction({
      draftAnswer,
      userMessage: 'Is GE Fight Bac RTU approved for use in my state?',
      grounding: {
        categoriesDetected: ['epa_registration', 'contact_time', 'efficacy_claim'],
        ungroundedCategories: [...new Set(details.map((d) => d.category))],
        ungroundedDetails: details,
        keyTermGroundedCategories: [],
      },
      productLineLock: NO_LOCK,
      sources: [{ documentKind: 'facts' }, { documentKind: 'label' }, { documentKind: 'sds' }],
    });
  }

  it('withholds the sentence that also contains the ungrounded token instead of declining (c175d99e)', () => {
    const result = plan(C175D99E_DRAFT, [
      { category: 'contact_time', snippet: '600 seconds' },
      { category: 'efficacy_claim', snippet: C175D99E_KILL_CLAIM_BULLET.slice(0, 240) },
    ]);
    expect(result.mode).toBe('sentence_redaction');
    if (result.mode === 'decline') return;
    expect(result.redactedText).not.toContain('600 seconds');
    expect(result.redactedText).not.toContain('kill claims');
    expect(result.redactedText).toContain('[one efficacy claim withheld — not verifiable against a retrieved label]');
    // Everything the guardrail did NOT object to is kept verbatim.
    expect(result.redactedText).toContain('EPA Reg. No.: 34810-35-4170, per the verified product facts and product label.');
    expect(result.redactedText).toContain('please contact Betco Regulatory Affairs or your state’s pesticide regulatory agency.');
    expect(result.unlocatedSnippets).toBeUndefined();
  });

  it('is order-independent: the token detail listed first yields the same plan', () => {
    const tokenFirst = plan(C175D99E_DRAFT, [
      { category: 'contact_time', snippet: '600 seconds' },
      { category: 'efficacy_claim', snippet: C175D99E_KILL_CLAIM_BULLET },
    ]);
    const sentenceFirst = plan(C175D99E_DRAFT, [
      { category: 'efficacy_claim', snippet: C175D99E_KILL_CLAIM_BULLET },
      { category: 'contact_time', snippet: '600 seconds' },
    ]);
    expect(tokenFirst).toEqual(sentenceFirst);
  });

  it('B0-1000 — withholds the WHOLE sentence carrying a token claim OUTSIDE the sentence-shaped claim too, never leaving the figure printed', () => {
    const draft = `${C175D99E_DRAFT}\n\nNote: the longest contact time listed is 600 seconds.`;
    const result = plan(draft, [
      { category: 'contact_time', snippet: '600 seconds' },
      { category: 'efficacy_claim', snippet: C175D99E_KILL_CLAIM_BULLET },
    ]);
    expect(result.mode).toBe('sentence_redaction');
    if (result.mode === 'decline') return;
    expect(result.redactedText).not.toContain('600 seconds');
    expect(result.redactedText).not.toContain('(unable to verify)');
    expect(result.redactedText).toContain(
      '[one contact/dwell time withheld — not verifiable against a retrieved label]',
    );
  });

  it('never declines for a sentence snippet it cannot locate: the token claim is still withheld and the miss is recorded', () => {
    const result = plan(C175D99E_DRAFT, [
      { category: 'contact_time', snippet: '600 seconds' },
      { category: 'efficacy_claim', snippet: 'This sentence is not in the draft at all.' },
    ]);
    expect(result.mode).toBe('sentence_redaction');
    if (result.mode === 'decline') return;
    expect(result.redactedText).not.toContain('600 seconds');
    expect(result.redactedText).not.toContain('kill claims');
    expect(result.redactedText).toContain(
      '[one contact/dwell time withheld — not verifiable against a retrieved label]',
    );
    expect(result.unlocatedSnippets).toEqual(['This sentence is not in the draft at all.']);
  });

  it('declines only when nothing at all could be redacted (the footer would otherwise misstate what was done)', () => {
    const result = plan(C175D99E_DRAFT, [
      { category: 'efficacy_claim', snippet: 'This sentence is not in the draft at all.' },
    ]);
    expect(result.mode).toBe('decline');
    if (result.mode !== 'decline') return;
    expect(result.reason).toBe('snippet_not_found_in_draft');
  });
});

/**
 * B0-986 — typed contact times. `renderFacts` writes `contact_time_seconds` as `60 sec` (historic
 * runs: `60s`), the label prints "1 minute", and the model quotes "60 seconds". The comparator now
 * reads the `Ns` shorthand as seconds and treats N min ≡ 60·N sec — for EQUALITY ONLY. Nothing here
 * rewrites displayed text: the last case proves the served draft is byte-identical.
 */
describe('evaluateRegulatedClaimGrounding — contact-time unit equivalence is comparison-only (B0-986)', () => {
  const FACTS_BLOCK_LEGACY = {
    documentId: 'verified-facts',
    title: 'Verified Product Facts (structured)',
    documentBody: [
      '### GE Fight Bac RTU',
      '- **Contact time:** 60s',
      '- **Efficacy (verified kill claims):**',
      '  - Listeria monocytogenes — claim: bactericidal, 600s contact, EPA 34810 35 4170 (confidence 0.9)',
    ].join('\n'),
  };
  const FACTS_BLOCK_CURRENT = {
    ...FACTS_BLOCK_LEGACY,
    documentBody: FACTS_BLOCK_LEGACY.documentBody.replace('60s', '60 sec').replace('600s contact', '600 sec contact'),
  };
  const LABEL_MINUTES = {
    documentId: 'doc-label-minutes',
    title: 'GE Fight Bac RTU',
    documentBody:
      'Treated surfaces must remain visibly wet for 1 minute. For Listeria monocytogenes allow a contact time of a minimum of 10 minutes.',
  };

  const cases: Array<{ quoted: string; against: typeof FACTS_BLOCK_LEGACY; label: string }> = [
    { quoted: '60s', against: FACTS_BLOCK_LEGACY, label: 'facts block (60s)' },
    { quoted: '60s', against: LABEL_MINUTES, label: 'label (1 minute)' },
    { quoted: '60 seconds', against: FACTS_BLOCK_LEGACY, label: 'facts block (60s)' },
    { quoted: '60 seconds', against: FACTS_BLOCK_CURRENT, label: 'facts block (60 sec)' },
    { quoted: '60 seconds', against: LABEL_MINUTES, label: 'label (1 minute)' },
    { quoted: '1 minute', against: FACTS_BLOCK_LEGACY, label: 'facts block (60s)' },
    { quoted: '1 minute', against: LABEL_MINUTES, label: 'label (1 minute)' },
    { quoted: '600s', against: LABEL_MINUTES, label: 'label (10 minutes)' },
    { quoted: '600 seconds', against: FACTS_BLOCK_LEGACY, label: 'facts block (600s contact)' },
    { quoted: '600 seconds', against: LABEL_MINUTES, label: 'label (10 minutes)' },
    { quoted: '10 minutes', against: FACTS_BLOCK_LEGACY, label: 'facts block (600s contact)' },
    { quoted: '10 minutes', against: FACTS_BLOCK_CURRENT, label: 'facts block (600 sec contact)' },
  ];

  for (const { quoted, against, label } of cases) {
    it(`grounds a contact time quoted as "${quoted}" against the ${label}`, () => {
      const result = evaluateRegulatedClaimGrounding({
        draftAnswer: `The surface must remain wet for a ${quoted} contact time.`,
        sources: [against],
      });
      expect(result.categoriesDetected).toContain('contact_time');
      expect(result.ungroundedCategories).not.toContain('contact_time');
    });
  }

  it('still rejects a contact time that matches neither form (no rounding to the nearest minute)', () => {
    for (const fabricated of ['90 seconds', '2 minutes', '30s', '5 minutes']) {
      const result = evaluateRegulatedClaimGrounding({
        draftAnswer: `The surface must remain wet for a ${fabricated} contact time.`,
        sources: [FACTS_BLOCK_LEGACY, LABEL_MINUTES],
      });
      expect(result.ungroundedCategories, fabricated).toContain('contact_time');
    }
  });

  it('does not read a trailing "s" that is not a unit as seconds', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Allow a 5 minute contact time; coverage is 3,200 sq ft/gal.',
      sources: [{ documentId: 'doc-x', title: 'X', documentBody: 'Contact time: 300 s. Coverage 3,200 sq ft/gal.' }],
    });
    expect(result.ungroundedCategories).not.toContain('contact_time');
  });

  it('B0-1000 — a grounded "60 seconds" is served byte-identical and an ungrounded token elsewhere is withheld by sentence, never converted or left printed', () => {
    const draft =
      'GE Fight Bac RTU kills SARS-CoV-2 with a 60 seconds contact time. Some bacteria need a 45 seconds contact time. Source: GE Fight Bac RTU product label [doc:doc-label-minutes].';
    const grounding = evaluateRegulatedClaimGrounding({ draftAnswer: draft, sources: [LABEL_MINUTES, FACTS_BLOCK_CURRENT] });
    expect(grounding.ungroundedDetails.filter((d) => d.category === 'contact_time').map((d) => d.snippet)).toEqual([
      '45 seconds',
    ]);
    const plan = planRegulatedClaimRedaction({
      draftAnswer: draft,
      userMessage: 'How long does GE Fight Bac RTU need to stay wet?',
      grounding: {
        ...grounding,
        // Only the token category is exercised here; the efficacy sentence's grounding is B0-971's concern.
        ungroundedCategories: ['contact_time'],
        ungroundedDetails: grounding.ungroundedDetails.filter((d) => d.category === 'contact_time'),
      },
      productLineLock: null,
      sources: [{ documentKind: 'label' }],
    });
    expect(plan.mode).toBe('token_redaction');
    if (plan.mode === 'decline') return;
    // The whole sentence carrying the ungrounded figure is withheld -- never a marker printed
    // beside the raw number, and never the number left in place alone.
    expect(plan.redactedText).toBe(
      draft.replace(
        'Some bacteria need a 45 seconds contact time.',
        '[one contact/dwell time withheld — not verifiable against a retrieved label]',
      ),
    );
    expect(plan.redactedText).toContain('60 seconds contact time');
    expect(plan.redactedText).not.toContain('45 seconds');
    expect(plan.redactedText).not.toContain('(unable to verify)');
    expect(plan.redactedText).not.toContain('1 minute');
  });
});

/**
 * B0-971 — two Product golden items (run 6d0f3c89) lost grounded efficacy bullets to redaction.
 * Drafts are verbatim from `response_payload.draftAnswer`; source bodies are the retrieved chunks'
 * `rag.document_chunk.chunk_text` verbatim (including the corpus's own mangled "« oz." glyph).
 */
describe('evaluateRegulatedClaimGrounding — bullet-head attribution and abbreviation-safe sentences (B0-971)', () => {
  const REST_STOP_LABEL = {
    documentId: '7117c7a4-2558-473f-9063-4bd25229bbdc',
    title: 'Rest Stop',
    documentBody: [
      'Rest Stop™',
      '*Virucidal • Ready-To-Use Germicide • Cleaner',
      'Streptococcus pyogenes, *Influenza Type A/Brazil Virus, and',
      'Trichophyton mentagrophytes',
      '(Athlete’s Foot Fungus)',
      'READY-TO-USE',
      'EPA REG. NO. 47371-97-4170',
      'n-alkyl (C14 60%, C16 30%, C12 5%, C18 5%)',
      'dimethyl benzyl ammonium chloride ........ 0.09%',
      'Disinfectant • Deodorant',
      'Kills Pseudomonas aeruginosa, Staphylococcus aureus, *HIV-1,',
      'DISINFECTANT 070',
    ].join('\n'),
  };
  const HOSPITAL_DISINFECTANT_PROFILE = {
    documentId: '987d994b-75fb-4f7d-8e3e-4b0dfa15cb04',
    title: 'Hospital disinfectant',
    documentBody: [
      'Product line: CIDE-BET FRESH & CLEAN',
      'Product line ID: 088',
      'Summary: Hospital disinfectant',
      'Description: This easy-to-use foaming germicidal detergent clings, cleans, disinfects and deodorizes in one quick operation.  **Its quaternary formulation features residual activity that controls germs for up to five days after surface is cleaned.  A Hospital Type disinfectant, this product kills a broad range of microorganisms including staph, salmonella and pseudomonas.  Virucidal against HIV-1 (AIDS Virus) and Herpes Simplex 1 & 2.  Effective fungicidal activity against pathogenic fungi, mold and mildew.',
    ].join('\n'),
  };
  const VERSIFECT_EFFICACY = {
    documentId: '0d44ac20-8931-4a91-b0d1-d48d40ecc593',
    title: 'Efficacy Data 3820 VersiFect',
    documentBody:
      '3820 — VersiFect™ — Version null > Virucidal Activity\n| Organism | ATCC/Source | Contact Time |\n| Human Immunodeficiency Virus Type 1, (Strain HTLV-IIIB)(HIV-1) |  | 1 Minute |',
  };
  const FORMULA_315_EFFICACY = {
    documentId: 'f1ab17b1-0a3e-4c96-b6ba-3914855f13d1',
    title: '315 137b1f74 97bd 468d a91c d65f96a3b1af',
    documentBody:
      'Product/Formula: 315 137b1f74 97bd 468d a91c d65f96a3b1af\nVirucidal Efficacy\n| Organism | ATCC | Contact Time | Log Reduction | Percent Reduction |\n| HIV-1 (AIDS Virus) | HTLV-IIIB | 10 Minutes | [ILLEGIBLE] | [ILLEGIBLE] |',
  };
  const FORMULA_311_EFFICACY = {
    documentId: '96bc7189-05e2-4368-bb2d-f7383bc6044b',
    title: '311 2d091f83 7d62 48e9 9b04 2496b3dc7dc1',
    documentBody:
      'Virucidal Efficacy\n| Human Immunodeficiency virus HIV-1 (AIDS) | Clinical Isolate | 1 Minute | [ILLEGIBLE] | [ILLEGIBLE] |',
  };
  const FORMULA_314_EFFICACY = {
    documentId: '71708cba-66f7-4442-9caf-c289b0b5981a',
    title: '314 65808d51 06f5 4c38 8c9a cd69d34837e8',
    documentBody: 'Virucidal Efficacy\n| HIV-1 (AIDS Virus) HTLV-III RF, | NCI | 1 Minute | [ILLEGIBLE] | [ILLEGIBLE] |',
  };

  const CA39CD2E_DRAFT = [
    'Several Betco disinfectants are documented to kill HIV-1 (Human Immunodeficiency Virus Type 1):',
    '',
    '- Rest Stop™: The label explicitly states it kills HIV-1. (EPA Reg. No. 47371-97-4170)',
    '- CIDE-BET FRESH & CLEAN (Hospital disinfectant): The product line profile states it is virucidal against HIV-1 (AIDS Virus) and Herpes Simplex 1 & 2.',
    '- VersiFect™: Efficacy data confirms activity against Human Immunodeficiency Virus Type 1 (HIV-1) with a 1-minute contact time.',
    '- Product/Formula 315: Efficacy data shows activity against HIV-1 (AIDS Virus) with a 10-minute contact time.',
    '- Product/Formula 311: Efficacy data shows activity against Human Immunodeficiency virus HIV-1 (AIDS) with a 1-minute contact time.',
    '- Product/Formula 314: Efficacy data shows activity against HIV-1 (AIDS Virus) HTLV-III RF with a 1-minute contact time.',
    '',
    'Key facts:',
    "- Each product's label or efficacy data confirms HIV-1 as a kill claim.",
    '- Contact times vary: VersiFect™, 311, and 314 show 1-minute contact times; 315 shows 10 minutes.',
    '- Always follow the labeled directions for dilution, application, and contact time for HIV-1 efficacy.',
    '',
    'Confirm the product label in hand for the exact contact time and directions, as formulations and claims may vary by product and revision.',
    '',
    'Source: Rest Stop product label [doc:7117c7a4-2558-473f-9063-4bd25229bbdc]; CIDE-BET FRESH & CLEAN product line profile [doc:987d994b-75fb-4f7d-8e3e-4b0dfa15cb04]; VersiFect efficacy data [doc:0d44ac20-8931-4a91-b0d1-d48d40ecc593]; 311 efficacy data [doc:96bc7189-05e2-4368-bb2d-f7383bc6044b]; 314 efficacy data [doc:71708cba-66f7-4442-9caf-c289b0b5981a]; 315 efficacy data [doc:f1ab17b1-0a3e-4c96-b6ba-3914855f13d1].',
  ].join('\n');
  const CA39CD2E_SOURCES = [
    REST_STOP_LABEL,
    HOSPITAL_DISINFECTANT_PROFILE,
    VERSIFECT_EFFICACY,
    FORMULA_315_EFFICACY,
    FORMULA_311_EFFICACY,
    FORMULA_314_EFFICACY,
  ];

  const FIVE_MINUTE_PROFILE = {
    documentId: 'dace1b56-e3d2-4f5c-b63c-7dafa7d8d76c',
    title: '5 Minute Alkaline Disinfectant',
    documentBody: [
      'Product: 5 Minute Alkaline Disinfectant',
      '- 5-minute dwell time',
      '- Effective yet economical; « oz. per gallon dilution (1:256)',
      '- Efficacy against Norovirus',
      '- Save labor cost with 5-minute dwell time',
      '- Can be used through an auto-scrubber',
    ].join('\n'),
  };
  const NOROVIRUS_GUIDANCE = {
    documentId: '5466397a-41a4-430d-8bb0-0116f4de8da6',
    title: 'Norovirus Outbreaks: Betco® Cleaning and Hand Hygiene Solutions',
    documentBody: [
      'Preventing norovirus requires a multi-faceted approach, including targeted cleaning solutions and strict hand hygiene protocols. Unlike cold and flu viruses, which are easily neutralized by alcohol-based cleaners, norovirus lacks an outer lipid envelope, making it resistant to common disinfectants. It can survive on surfaces for up to two weeks, necessitating the use of powerful norovirus disinfectants.',
      '',
      'To effectively prevent norovirus, the following EPA-registered Betco® disinfectants are recommended for hard surfaces:',
      '',
      '- Quat-Stat™ 5',
      '- Fight Bac™ RTU',
      '- GE Fight Bac™ RTU',
      '- pH7Q Dual',
    ].join('\n'),
  };
  const FIVE_MINUTE_BULLET =
    '- The 5 Minute Alkaline Disinfectant is also labeled as effective against norovirus, with a 5-minute dwell time at a 1:256 dilution (½ oz. per gallon of water), and must remain wet for 5 minutes to achieve disinfection.';
  const B4291663F_DRAFT = [
    'Several Betco disinfectants are EPA-registered and documented as effective against norovirus on hard, nonporous surfaces. There is no documented ranking of "best," but the following products are specifically recommended for norovirus disinfection:',
    '',
    '- **Quat-Stat™ 5**',
    '- **Fight Bac™ RTU**',
    '- **GE Fight Bac™ RTU**',
    '- **pH7Q Dual**',
    '',
    '**Supporting facts:**',
    "- These products are listed in Betco's norovirus outbreak guidance as EPA-registered disinfectants effective against norovirus for hard surfaces.",
    FIVE_MINUTE_BULLET,
    '- Norovirus is highly resistant to many common disinfectants, so it is critical to use a product with a specific norovirus claim and to follow the labeled contact time and dilution exactly.',
    '',
    '**Caveat/confirmation:**',
    '- Always confirm the product label in hand for the exact organism claim, dilution, and contact time, as EPA registrations and label instructions may change.',
    '- For food-contact surfaces, rinse with potable water after disinfection as directed on the label.',
    '',
    'Source: Norovirus Outbreaks: Betco® Cleaning and Hand Hygiene Solutions knowledge document; 5 Minute Alkaline Disinfectant product label [doc:5466397a-41a4-430d-8bb0-0116f4de8da6]; [doc:dace1b56-e3d2-4f5c-b63c-7dafa7d8d76c]',
  ].join('\n');

  it('ca39cd2e: "The label explicitly states it kills HIV-1" / "The product line profile states it is virucidal against HIV-1" are grounded via the bullet-head product ↔ Source-line citation', () => {
    const result = evaluateRegulatedClaimGrounding({ draftAnswer: CA39CD2E_DRAFT, sources: CA39CD2E_SOURCES });
    expect(result.categoriesDetected).toEqual(expect.arrayContaining(['epa_registration', 'contact_time', 'efficacy_claim']));
    expect(result.ungroundedDetails).toEqual([]);
    expect(result.ungroundedCategories).toEqual([]);
    expect(result.keyTermGroundedCategories).toContain('efficacy_claim');
  });

  it('4291663f: the 5 Minute Alkaline Disinfectant norovirus bullet is grounded by its Source-line citation, with its dilution and contact time intact', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: B4291663F_DRAFT,
      sources: [FIVE_MINUTE_PROFILE, NOROVIRUS_GUIDANCE],
    });
    expect(result.categoriesDetected).toEqual(expect.arrayContaining(['dilution_ratio', 'contact_time', 'efficacy_claim']));
    expect(result.ungroundedDetails).toEqual([]);
    expect(result.ungroundedCategories).toEqual([]);
  });

  it('a genuinely unsourced claim in the same bullet shape is still redacted: the attributed source never mentions the organism', () => {
    const draft = [
      '- Rest Stop™: The label explicitly states it kills Ebola virus. (EPA Reg. No. 47371-97-4170)',
      '',
      'Source: Rest Stop product label [doc:7117c7a4-2558-473f-9063-4bd25229bbdc].',
    ].join('\n');
    const result = evaluateRegulatedClaimGrounding({ draftAnswer: draft, sources: [REST_STOP_LABEL] });
    expect(result.ungroundedCategories).toContain('efficacy_claim');
    // The EPA token on the same bullet is real and stays grounded.
    expect(result.ungroundedCategories).not.toContain('epa_registration');
  });

  it('a bullet naming a product that no retrieved source title matches, with no citation, is still redacted', () => {
    const draft = '- Quat-Stat™ 5: The label explicitly states it kills HIV-1.';
    const result = evaluateRegulatedClaimGrounding({ draftAnswer: draft, sources: [REST_STOP_LABEL] });
    expect(result.ungroundedCategories).toContain('efficacy_claim');
  });

  it('the bullet-head channel needs the named source to be cited somewhere OR the sentence to attribute a source kind', () => {
    // Named + cited on the Source line, no "the label states" phrase → attributed.
    const cited = evaluateRegulatedClaimGrounding({
      draftAnswer: '- Rest Stop™ is labeled to kill HIV-1 on hard surfaces.\n\nSource: [doc:7117c7a4-2558-473f-9063-4bd25229bbdc]',
      sources: [REST_STOP_LABEL],
    });
    expect(cited.ungroundedCategories).not.toContain('efficacy_claim');
    // Named + "the label states", no citation anywhere → attributed.
    const asserted = evaluateRegulatedClaimGrounding({
      draftAnswer: '- Rest Stop™: The label states it kills HIV-1.',
      sources: [REST_STOP_LABEL],
    });
    expect(asserted.ungroundedCategories).not.toContain('efficacy_claim');
    // Named only, neither → NOT attributed.
    const bare = evaluateRegulatedClaimGrounding({
      draftAnswer: '- Rest Stop™ is labeled to kill HIV-1 on hard surfaces.',
      sources: [REST_STOP_LABEL],
    });
    expect(bare.ungroundedCategories).toContain('efficacy_claim');
  });

  it('never splits a sentence after "Reg." / "No." / "oz." / "fl." / "min." / "vs.", so a withheld bullet leaves no orphan fragment', () => {
    const bullet = '- Quat-Stat™ 5: The label explicitly states it kills Ebola virus. (EPA Reg. No. 47371-97-4170)';
    const draft = [
      'Several Betco disinfectants are documented for hard-surface disinfection, each with its own registration.',
      bullet,
      '- Dilute at 2 oz. per gallon (0.5 fl. oz. per quart); allow 10 min. dwell vs. the 5 min. many labels require.',
      '',
      'Source: Rest Stop product label [doc:7117c7a4-2558-473f-9063-4bd25229bbdc].',
    ].join('\n');
    const grounding = evaluateRegulatedClaimGrounding({ draftAnswer: draft, sources: [REST_STOP_LABEL] });
    const efficacySnippets = grounding.ungroundedDetails.filter((d) => d.category === 'efficacy_claim').map((d) => d.snippet);
    expect(efficacySnippets).toEqual([bullet]);
    for (const snippet of grounding.ungroundedDetails.map((d) => d.snippet)) {
      expect(snippet, snippet).not.toMatch(/(?:Reg|No|oz|fl|min|vs)\.$/);
      expect(snippet, snippet).not.toMatch(/^(?:No\.|\d{4,}-)/);
    }

    const plan = planRegulatedClaimRedaction({
      draftAnswer: draft,
      userMessage: 'Which of your disinfectants kill Ebola?',
      grounding: {
        categoriesDetected: grounding.categoriesDetected,
        ungroundedCategories: ['efficacy_claim'],
        ungroundedDetails: grounding.ungroundedDetails.filter((d) => d.category === 'efficacy_claim'),
        keyTermGroundedCategories: [],
      },
      productLineLock: null,
      sources: [{ documentKind: 'label' }],
    });
    expect(plan.mode).toBe('sentence_redaction');
    if (plan.mode === 'decline') return;
    expect(plan.redactedText).not.toContain('47371-97-4170');
    expect(plan.redactedText).not.toContain('No. ');
    expect(plan.redactedText).toContain('[one efficacy claim withheld — not verifiable against a retrieved label]');
    expect(plan.redactedText).toContain('2 oz. per gallon (0.5 fl. oz. per quart); allow 10 min. dwell vs. the 5 min.');
  });

  it('two consecutive withheld bullets collapse into one pluralised marker', () => {
    const first = '- Quat-Stat™ 5: The label explicitly states it kills Ebola virus.';
    const second = '- pH7Q Dual: The label explicitly states it kills Marburg virus.';
    const draft = [
      'Several Betco disinfectants are documented for hard-surface disinfection; confirm the label in hand for the exact organism claim before use.',
      first,
      second,
      '- Rest Stop™: The label explicitly states it kills HIV-1.',
      '',
      'Source: Rest Stop product label [doc:7117c7a4-2558-473f-9063-4bd25229bbdc].',
    ].join('\n');
    const grounding = evaluateRegulatedClaimGrounding({ draftAnswer: draft, sources: [REST_STOP_LABEL] });
    expect(grounding.ungroundedDetails.map((d) => d.snippet)).toEqual([first, second]);
    const plan = planRegulatedClaimRedaction({
      draftAnswer: draft,
      userMessage: 'Which of your disinfectants kill Ebola?',
      grounding,
      productLineLock: null,
      sources: [{ documentKind: 'label' }],
    });
    expect(plan.mode).toBe('sentence_redaction');
    if (plan.mode === 'decline') return;
    expect(plan.redactedText).toContain('[two efficacy claims withheld — not verifiable against a retrieved label]');
    expect(plan.redactedText).not.toContain('[one efficacy claim withheld');
    expect(plan.redactedText).toContain('- Rest Stop™: The label explicitly states it kills HIV-1.');
  });
});

/**
 * B0-923 — hazard value-term grounding. Every "grounds" draft below is a live `ungroundedDetails`
 * snippet (app 6.12.0/7.0.0) that declined a whole answer although each hazard value in it is
 * printed on the product's own label. Fixture bodies are excerpts of the live documents.
 */
const SPEEDEX_LABEL_SOURCE = {
  documentId: 'c7d2e59f-7945-4f3f-aae6-9b5611fef7a7',
  title: 'Speedex Concentrate',
  isLockedProductLineSource: true,
  documentBody: [
    'DANGER! CAUSES SEVERE SKIN BURNS AND EYE DAMAGE. MAY CAUSE AN ALLERGIC SKIN REACTION.',
    'SKIN CORROSION - Category 1. SERIOUS EYE DAMAGE - Category 1. Signal word: Danger. H314 + H317',
    'Recommended: splash',
    'goggles. Wear protective',
    'Chemical resistant gloves.',
    'Wash hands thoroughly after handling.',
  ].join('\n'),
};

const PUSH_SDS_SOURCE = {
  documentId: 'b0e2d441-a7cb-4bee-9c6e-01aee328edb8',
  title: 'Push (Mint) M000133',
  isLockedProductLineSource: true,
  documentBody: [
    'SECTION 2: Hazards identification',
    'Classification of the substance or mixture: Not classified.',
    'Signal word: No signal word.',
    'Hazard statements: No known significant effects or critical hazards.',
  ].join('\n'),
};

describe('evaluateRegulatedClaimGrounding — B0-923 hazard value-term grounding', () => {
  it('grounds framed PPE + hazard prose whose every value term is on the locked product label', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        '- Always wear chemical-resistant gloves and splash goggles when handling and using this product, as it can cause severe skin burns and eye damage (SDS Section 2).',
      sources: [SPEEDEX_LABEL_SOURCE],
    });
    expect(result.categoriesDetected).toContain('hazard');
    expect(result.ungroundedCategories).not.toContain('hazard');
    expect(result.keyTermGroundedCategories).toContain('hazard');
  });

  it('grounds a GHS class / category / signal word / H-code transcription', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        '- **PPE:** Speedex Concentrate is classified **Skin Corrosion Category 1 / Serious Eye Damage Category 1, Signal word Danger, H314**.',
      sources: [SPEEDEX_LABEL_SOURCE],
    });
    expect(result.ungroundedCategories).not.toContain('hazard');
  });

  it('grounds a negative classification only against a source that prints it negated', () => {
    const draftAnswer =
      '- Product is not classified as hazardous under the OSHA Hazard Communication Standard; there is no signal word (SDS Section 2).';
    expect(
      evaluateRegulatedClaimGrounding({ draftAnswer, sources: [PUSH_SDS_SOURCE] }).ungroundedCategories,
    ).not.toContain('hazard');
    expect(
      evaluateRegulatedClaimGrounding({ draftAnswer, sources: [SPEEDEX_LABEL_SOURCE] }).ungroundedCategories,
    ).toContain('hazard');
  });

  it('still declines a value term the attributed document never prints', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Always wear a respirator and splash goggles with this product, as it causes severe skin burns.',
      sources: [SPEEDEX_LABEL_SOURCE],
    });
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('still declines when the source states the opposite polarity', () => {
    const nonFlammable = {
      documentId: 'doc-nf',
      title: 'Test Cleaner',
      isLockedProductLineSource: true,
      documentBody: 'Non-flammable. Not corrosive. Keep out of reach of children.',
    };
    expect(
      evaluateRegulatedClaimGrounding({
        draftAnswer: 'This product is flammable, so store it away from heat.',
        sources: [nonFlammable],
      }).ungroundedCategories,
    ).toContain('hazard');
    expect(
      evaluateRegulatedClaimGrounding({
        draftAnswer: 'This product is corrosive to skin, so wear gloves.',
        sources: [nonFlammable],
      }).ungroundedCategories,
    ).toContain('hazard');
  });

  it('still declines when no source is attributed to the product (not locked, not cited, not named)', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        '- Always wear chemical-resistant gloves and splash goggles when handling this product, as it can cause severe skin burns and eye damage.',
      sources: [{ ...SPEEDEX_LABEL_SOURCE, isLockedProductLineSource: false }],
    });
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('never lets first_aid take the value-term path', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'If in eyes, flush with water for 30 minutes and apply ointment.',
      sources: [SPEEDEX_LABEL_SOURCE],
    });
    expect(result.ungroundedCategories).toContain('first_aid');
  });
});

describe('evaluateRegulatedClaimGrounding — B0-923 generic chemistry-class prose', () => {
  it('does not flag "Some solvent-based products are flammable"', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: '- Flammability: Some solvent-based products are flammable, affecting storage and handling.',
      sources: [],
    });
    expect(result.categoriesDetected).not.toContain('hazard');
  });

  it('does not flag an anaphoric continuation of a sentence that named the chemistry class', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'Solvent-based finishes offer strong durability and a traditional amber look. Some are flammable, affecting storage and handling.',
      sources: [],
    });
    expect(result.categoriesDetected).not.toContain('hazard');
  });

  it('still flags an anaphoric continuation carrying a GHS value token', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'Solvent-based finishes offer strong durability. Some are flammable liquids, signal word Danger, H226.',
      sources: [],
    });
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('still flags a product-specific hazard sentence that follows a chemistry-class sentence', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Solvent-based finishes are durable. Marathane 45 is combustible and needs a respirator.',
      sources: [],
    });
    expect(result.ungroundedCategories).toContain('hazard');
  });
});

describe('evaluateRegulatedClaimGrounding — B0-923 attribution refinements (historical replay)', () => {
  const MARATHANE_LABEL = {
    documentId: 'doc-marathane-45',
    title: 'Marathane 45',
    documentBody: 'WARNING: COMBUSTIBLE. Always use a respirator when applying this product. 480 g/L VOC.',
  };
  const OTHER_FINISH = {
    documentId: 'doc-other',
    title: 'Players Choice One',
    documentBody: 'Waterbased. Low odor. Non-flammable.',
  };

  it('attributes a sentence that names a source by its full title', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        'For example, the Marathane 45 wood-gym-floor label labels the product **“COMBUSTIBLE,”** and requires a respirator during application.',
      sources: [OTHER_FINISH, MARATHANE_LABEL],
    });
    expect(result.ungroundedCategories).not.toContain('hazard');
  });

  it('does not let a named title ground a value only another product prints', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Players Choice One is combustible and requires a respirator.',
      sources: [OTHER_FINISH, MARATHANE_LABEL],
    });
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('grounds across the locked product line documents when "per the X SDS" attributes the label instead', () => {
    const label = { ...SPEEDEX_LABEL_SOURCE, documentBody: 'Speedex Concentrate. Heavy duty degreaser. Recommended: splash goggles.' };
    const dilutedSds = {
      documentId: 'doc-528-dil',
      title: '528 DIL MXE',
      isLockedProductLineSource: true,
      documentBody: 'SKIN CORROSION - Category 1. Signal word: Danger. H314 - Causes severe skin burns and eye damage.',
    };
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer:
        '- **PPE:** Speedex Concentrate is classified **Skin Corrosion Category 1, Signal word Danger, H314**, so wear splash goggles — per the Speedex Concentrate SDS.',
      sources: [label, dilutedSds],
    });
    expect(result.ungroundedCategories).not.toContain('hazard');
  });

  it('does not pool values across documents that are NOT the locked product line', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'This product is combustible and causes severe skin burns.',
      sources: [
        { ...MARATHANE_LABEL, isLockedProductLineSource: false },
        { ...SPEEDEX_LABEL_SOURCE, isLockedProductLineSource: false },
      ],
    });
    expect(result.ungroundedCategories).toContain('hazard');
  });

  it('lets "Some are flammable" reach a chemistry header two sentences back through product-free prose', () => {
    const draftAnswer = [
      '**Solvent-Based (Oil-Modified) Finishes:**',
      '- Higher VOCs: These finishes can emit more VOCs and harmful chemicals, leading to stronger odors and requiring more ventilation. Some are flammable, affecting storage and handling.',
    ].join('\n');
    expect(evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] }).categoriesDetected).not.toContain('hazard');
  });

  it('does not reach two sentences back through a sentence that names a product', () => {
    const draftAnswer =
      'Solvent-based finishes are durable. Marathane 45 is a classic choice. Some are flammable, affecting storage.';
    expect(evaluateRegulatedClaimGrounding({ draftAnswer, sources: [] }).ungroundedCategories).toContain('hazard');
  });
});

describe('evaluateRegulatedClaimGrounding — B0-1131 efficacy claims across the locked product line', () => {
  const AF79_LABEL = {
    documentId: 'doc-af79-label',
    title: 'AF 79',
    isLockedProductLineSource: true,
    documentBody: 'Acid Free Bathroom Cleaner. Disinfects hard non-porous surfaces.',
  };
  const AF79_EFFICACY = {
    documentId: 'doc-af79-efficacy',
    title: 'af79 efficacy sheet',
    isLockedProductLineSource: true,
    documentBody: 'BACTERICIDAL: Pseudomonas aeruginosa, Staphylococcus aureus. Contact time: 1 minute.',
  };
  const OTHER_PRODUCT = {
    documentId: 'doc-sanibet',
    title: 'Sanibet RTU',
    documentBody: 'Kills Norovirus. BACTERICIDAL: Salmonella enterica.',
  };

  it('grounds an organism bullet in one of several locked documents (live ROW-08)', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'AF79 organisms:\n- Pseudomonas aeruginosa — bactericidal',
      sources: [AF79_LABEL, AF79_EFFICACY],
    });
    expect(result.ungroundedCategories).not.toContain('efficacy_claim');
  });

  it('still fails an organism no locked document lists', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'AF79 organisms:\n- Mycobacterium tuberculosis — tuberculocidal',
      sources: [AF79_LABEL, AF79_EFFICACY],
    });
    expect(result.ungroundedCategories).toContain('efficacy_claim');
  });

  it('never grounds a claim attributed to another product on the locked product documents', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'Per the Sanibet RTU label, it kills Pseudomonas aeruginosa.',
      sources: [AF79_LABEL, AF79_EFFICACY, OTHER_PRODUCT],
    });
    expect(result.ungroundedCategories).toContain('efficacy_claim');
  });
});

describe('evaluateRegulatedClaimGrounding — B0-1131 every organism must be in the document', () => {
  const GE_FIGHT_BAC_LABEL = {
    documentId: 'doc-ge-fight-bac',
    title: 'GE Fight Bac RTU',
    isLockedProductLineSource: true,
    documentBody:
      'FOR SOFT SURFACE SANITIZATION: Preclean. Spray GE Fight Bac 6-8 inches from soft surface until wet. Let stand for 60 seconds. Allow to air dry. Effective against Klebsiella aerogenes and Staphylococcus aureus.',
  };

  it('grounds a paraphrase naming only organisms the document lists', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'GE Fight Bac RTU can sanitize soft surfaces.\n- It is effective against Klebsiella aerogenes and Staphylococcus aureus on soft surfaces.',
      sources: [GE_FIGHT_BAC_LABEL],
    });
    expect(result.ungroundedCategories).not.toContain('efficacy_claim');
  });

  it('fails when a second organism is not in the document (was: only the first was checked)', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'GE Fight Bac RTU can sanitize soft surfaces.\n- It is effective against Klebsiella aerogenes and Candida auris on soft surfaces.',
      sources: [GE_FIGHT_BAC_LABEL],
    });
    expect(result.ungroundedCategories).toContain('efficacy_claim');
  });

  it('fails a species swap on the same genus', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: 'GE Fight Bac RTU can sanitize soft surfaces.\n- It is effective against Klebsiella pneumoniae on soft surfaces.',
      sources: [GE_FIGHT_BAC_LABEL],
    });
    expect(result.ungroundedCategories).toContain('efficacy_claim');
  });
});
