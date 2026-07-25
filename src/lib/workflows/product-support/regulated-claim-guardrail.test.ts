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
