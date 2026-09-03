import { describe, expect, it } from 'vitest';

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
