import { describe, expect, it } from 'vitest';

import { evaluateRegulatedClaimGrounding } from '~/lib/workflows/product-support/validator';
import {
  buildDecisiveAssertions,
  coverageEvidenceSummary,
  coverageRevisionIssues,
  evaluateAnswerCoverage,
  selectCoverageRevision,
  type CoverageSource,
} from '~/lib/workflows/product-support/decisive-assertion-coverage';

const speedexLabel: CoverageSource = {
  documentId: '25cc0591-bd44-4f39-869a-40d9b7fe0060',
  chunkId: '1c7b2507-5cff-442f-a5e2-4f8558ad0d9c',
  documentBody:
    'Dilute 2 oz./gal. or 16 mL/L (1:64) with water. For heavy soil dilute 6 oz./gal. or 50 mL/L (1:20) with water.',
  documentKind: 'label',
  selectedSectionTypes: ['directions', 'dilution'],
  documentBodyChunkIds: ['1c7b2507-5cff-442f-a5e2-4f8558ad0d9c'],
};

const ph7qLabel: CoverageSource = {
  documentId: '46539a45-f6ae-49e5-a7a0-50638e18874f',
  chunkId: 'fecf2271-eae3-41f1-95e3-2bbb32f5ecb0',
  documentBody:
    'DILUTION: 1:64 (2 ounces per gallon of water). Apply use-solution to hard, nonporous surfaces and allow to remain on surface for a minimum of 10 minutes.',
  documentKind: 'label',
  selectedSectionTypes: ['directions', 'dilution', 'epa_claims'],
};

const geFightBacLabel: CoverageSource = {
  documentId: '3d46dbf6-76fe-41a1-8c62-5dfc09c7e298',
  chunkId: '4aca0d50-ebee-4aef-9127-d850a2ff99d7',
  documentBody: [
    'FOR SOFT SURFACE SANITIZATION: Preclean.',
    'Spray GE Fight Bac 6-8 inches from soft surface until wet.',
    'Let stand for 60 seconds.',
    'Allow to air dry.',
    'Effective against Klebsiella aerogenes and Staphylococcus aureus.',
  ].join(' '),
  documentKind: 'label',
  selectedSectionTypes: ['surfaces', 'directions'],
  documentBodyChunkIds: ['4aca0d50-ebee-4aef-9127-d850a2ff99d7'],
};

const speedexSds: CoverageSource = {
  documentId: '8ad8eca0-1655-4a58-acda-9ddf5144aca5',
  chunkId: 'fa44b9d7-e56d-43c8-bdd1-a85329d5d2a6',
  documentBody: [
    'SKIN CORROSION Category 1 SERIOUS EYE DAMAGE Category 1',
    'Signal word\nHazard statements\n: Danger',
    'Chemical-resistant, impervious gloves complying with an approved standard should be worn.',
    'Eye or face protection: Recommended: splash goggles.',
  ].join('\n'),
  documentKind: 'sds',
  selectedSectionTypes: ['hazard', 'exposure_ppe'],
};

const sureBetHivLabel: CoverageSource = {
  documentId: '610c5971-c643-44fa-a47a-c7adec8953c3',
  chunkId: '70de4a4a-7a52-4592-a3c5-8c8000a6dbbf',
  documentBody:
    'SPECIAL INSTRUCTIONS FOR CLEANING AND DECONTAMINATION AGAINST HIV-1 ON SURFACES/OBJECTS SOILED WITH BLOOD/BODY FLUIDS: Personal Protection: Clean-up should always be done wearing protective latex gloves, gowns, masks and eye protection. Cleaning Procedure: Blood and other bodily fluids must be thoroughly cleaned before application.',
  documentKind: 'label',
  selectedSectionTypes: ['directions'],
  documentBodyChunkIds: ['70de4a4a-7a52-4592-a3c5-8c8000a6dbbf'],
};

const af79Label: CoverageSource = {
  documentId: 'a0d9b2e7-5551-41c2-9c8b-359fc8333fac',
  chunkId: 'faf85622-998f-473c-83f7-83e4d04af206',
  documentBody:
    'Food contact surfaces must be rinsed with potable water after disinfection. Do not use on utensils, glassware and dishes.',
  documentKind: 'label',
  selectedSectionTypes: ['directions'],
  documentBodyChunkIds: ['faf85622-998f-473c-83f7-83e4d04af206'],
};

describe('decisive assertion coverage', () => {
  it('requires both Speedex printed rates and rejects the derived 6.4 oz value', () => {
    const requirements = buildDecisiveAssertions({
      query:
        'What is the proper dilution ratio for Speedex Concentrate when cleaning heavy equipment with grease and oil?',
      sources: [speedexLabel],
    });

    expect(requirements.map((requirement) => requirement.id)).toEqual([
      `dilution:${speedexLabel.documentId}:general-1-64`,
      `dilution:${speedexLabel.documentId}:heavy-1-20`,
      'policy:do-not-exceed-labeled-rate',
      'policy:do-not-transfer-between-variants',
    ]);

    const incomplete = evaluateAnswerCoverage({
      draftAnswer: 'Use 6.4 oz/gal (1:20) for heavy soil.',
      requirements,
    });
    expect(incomplete.status).toBe('revision_required');
    expect(incomplete.conflictingAssertionIds).toEqual([
      `dilution:${speedexLabel.documentId}:heavy-1-20`,
    ]);

    const complete = evaluateAnswerCoverage({
      draftAnswer:
        'The label gives 2 oz./gal. or 16 mL/L (1:64) for general cleaning and 6 oz./gal. or 50 mL/L (1:20) for heavy soil. Do not mix stronger than the label. Treat each named variant as a separate product.',
      requirements,
    });
    expect(complete.status).toBe('complete');
  });

  it('tells a dilution repair to remove optional hazard claims before validation', () => {
    const requirements = buildDecisiveAssertions({
      query: 'What dilution should I use for heavy grease?',
      sources: [speedexLabel],
    });
    const result = evaluateAnswerCoverage({
      draftAnswer: 'Use 6.4 oz/gal. Speedex is DANGER and corrosive; wear gloves and goggles.',
      requirements,
    });

    expect(coverageRevisionIssues(result, 'Speedex is DANGER; wear gloves.')).toContainEqual(
      expect.stringContaining('Remove every optional hazard and PPE sentence'),
    );
  });

  it('does not treat diluted-solution storage questions as dilution-rate coverage', () => {
    expect(
      buildDecisiveAssertions({
        query: 'How long can diluted pH7Q solution be stored or reused before it must be remade?',
        sources: [ph7qLabel],
      }),
    ).toEqual([]);
  });

  it('keeps the original draft when a coverage revision remains incomplete', () => {
    const requirements = buildDecisiveAssertions({
      query: 'What dilution should I use for heavy grease?',
      sources: [speedexLabel],
    });
    const originalDraft =
      'Prepare fresh solution daily. The retrieved directions do not support a storage period.';
    const selection = selectCoverageRevision({
      originalDraft,
      revisionCandidate: 'Use 6 oz./gal. (1:20) for heavy soil.',
      requirements,
    });

    expect(selection.coverage.status).toBe('revision_failed');
    expect(selection.adopted).toBe(false);
    expect(selection.draftAnswer).toBe(originalDraft);
  });

  it('adopts a revision that covers all retrieved evidence even if a workflow policy phrase is missing', () => {
    const requirements = buildDecisiveAssertions({
      query: 'What dilution should I use for heavy grease?',
      sources: [speedexLabel],
    });
    const revisionCandidate =
      'Use 2 oz./gal. or 16 mL/L (1:64) for general cleaning and 6 oz./gal. or 50 mL/L (1:20) for heavy soil. Treat each named variant as a separate product.';
    const selection = selectCoverageRevision({
      originalDraft: 'Use 6.4 oz/gal.',
      revisionCandidate,
      requirements,
    });

    expect(selection.coverage.status).toBe('revision_failed');
    expect(selection.coverage.missingAssertionIds).toEqual(['policy:do-not-exceed-labeled-rate']);
    expect(selection.adopted).toBe(true);
    expect(selection.draftAnswer).toBe(revisionCandidate);
  });

  it('uses visible verified facts and efficacy evidence when a label is not selected', () => {
    const requirements = buildDecisiveAssertions({
      query: 'What dilution ratio does pH7Q use?',
      sources: [
        {
          documentId: 'verified-facts',
          chunkId: 'verified-facts',
          documentBody: '## Verified Product Facts\n- **Dilution:** 1:64 (2 oz/gal)',
          documentKind: 'facts',
        },
        {
          documentId: '719fddff-bc0b-4058-ac54-960058e2358f',
          chunkId: '719fddff-bc0b-4058-ac54-960058e2358f',
          documentBody:
            '316 — pH7Q — Version null > Bactericidal Efficacy\n| Organism | Contact Time |\n| Example | 10 Minutes |',
          documentKind: 'efficacy',
        },
      ],
    });

    expect(requirements.map((requirement) => requirement.category)).toEqual([
      'dilution_rate',
      'contact_time',
      'use_constraint',
      'use_constraint',
    ]);
  });

  it('requires the pH7Q dilution and ten-minute general-disinfection time', () => {
    const requirements = buildDecisiveAssertions({
      query: 'What dilution and contact time should I use to disinfect with pH7Q?',
      sources: [ph7qLabel],
    });
    const result = evaluateAnswerCoverage({
      draftAnswer: 'Use pH7Q at 1:64, or 2 ounces per gallon.',
      requirements,
    });

    expect(requirements.some((requirement) => requirement.category === 'contact_time')).toBe(true);
    expect(result.missingAssertionIds).toContain(
      `contact-time:${ph7qLabel.documentId}:general-disinfection-10m`,
    );
  });

  it('requires Speedex hazard classification and PPE together', () => {
    const requirements = buildDecisiveAssertions({
      query: 'What PPE do I need when using Speedex Concentrate?',
      sources: [speedexSds],
    });
    const result = evaluateAnswerCoverage({
      draftAnswer: 'Wear chemical-resistant gloves and splash goggles.',
      requirements,
    });

    expect(result.missingAssertionIds).toEqual(
      expect.arrayContaining([
        `hazard:${speedexSds.documentId}:danger`,
        `hazard:${speedexSds.documentId}:corrosive`,
        'policy:use-current-product-document',
      ]),
    );
  });

  it('only marks hazard coverage complete when the long SDS assertions remain quoted', () => {
    const requirements = buildDecisiveAssertions({
      query: 'What PPE do I need when using Speedex Concentrate?',
      sources: [speedexSds],
    });
    const result = evaluateAnswerCoverage({
      draftAnswer: [
        'The current SDS states:',
        '"SKIN CORROSION Category 1 SERIOUS EYE DAMAGE Category 1"',
        '"Signal word Hazard statements : Danger"',
        'Wear chemical-resistant gloves and splash goggles.',
      ].join('\n'),
      requirements,
    });

    expect(result.status).toBe('complete');
  });

  it('adds the current-label-and-SDS policy when a grounded PPE revision omits it', () => {
    const requirements = buildDecisiveAssertions({
      query: 'What PPE do I need when using Speedex Concentrate?',
      sources: [speedexSds],
    });
    const revisionCandidate = [
      '"SKIN CORROSION Category 1 SERIOUS EYE DAMAGE Category 1"',
      '"Signal word Hazard statements : Danger"',
      'Wear chemical-resistant gloves and splash goggles.',
    ].join('\n');
    const selection = selectCoverageRevision({
      originalDraft: 'Wear chemical-resistant gloves and splash goggles.',
      revisionCandidate,
      requirements,
    });

    expect(selection.coverage.status).toBe('complete');
    expect(selection.adopted).toBe(true);
    expect(selection.draftAnswer).toContain(
      'PPE requirements are product-specific and must come from the current label and SDS for the product in hand.',
    );
  });

  it('keeps exact quoted hazard assertions grounded for the regulated-claim guardrail', () => {
    const result = evaluateRegulatedClaimGrounding({
      draftAnswer: [
        'The current Speedex SDS Section 2 states:',
        '"SKIN CORROSION Category 1 SERIOUS EYE DAMAGE Category 1"',
        '"Signal word Hazard statements : Danger"',
        'Wear chemical-resistant gloves and splash goggles.',
      ].join('\n'),
      sources: [
        {
          documentId: speedexSds.documentId,
          title: 'Speedex Concentrate SDS',
          documentBody: speedexSds.documentBody,
        },
      ],
    });

    expect(result.ungroundedCategories).not.toContain('hazard');
  });

  it('builds revision evidence only from extracted quotes and approved policies', () => {
    const requirements = buildDecisiveAssertions({
      query: 'What PPE do I need?',
      sources: [speedexSds],
    });
    const summary = coverageEvidenceSummary(requirements);

    expect(summary).toContain('Signal word Hazard statements : Danger');
    expect(summary).toContain('policy:use-current-product-document');
  });

  it('requires label-grounded cleanup PPE for an HIV-1 claims question', () => {
    const requirements = buildDecisiveAssertions({
      query: 'Which Betco disinfectants carry an HIV-1 claim, and what contact time applies?',
      sources: [sureBetHivLabel],
    });
    const result = evaluateAnswerCoverage({
      draftAnswer:
        'Several Betco disinfectants carry an HIV-1 claim. Each claim has its own dilution and contact time.',
      requirements,
    });

    expect(requirements).toHaveLength(1);
    expect(requirements[0]).toMatchObject({
      id: `hiv-cleanup:${sureBetHivLabel.documentId}:ppe`,
      category: 'ppe',
      authority: 'label',
      sourceDocumentId: sureBetHivLabel.documentId,
      sourceChunkIds: sureBetHivLabel.documentBodyChunkIds,
    });
    expect(result.status).toBe('revision_required');
    expect(result.missingAssertionIds).toEqual([
      `hiv-cleanup:${sureBetHivLabel.documentId}:ppe`,
    ]);
  });

  it('preserves the original HIV-1 product list while adding the exact cleanup PPE quote', () => {
    const requirements = buildDecisiveAssertions({
      query: 'Which Betco disinfectants carry an HIV-1 claim, and what contact time applies?',
      sources: [sureBetHivLabel],
    });
    const originalDraft =
      'pH7Q has a four-minute HIV-1 contact time. Triforce has a one-minute HIV-1 contact time.';
    const selection = selectCoverageRevision({
      originalDraft,
      revisionCandidate:
        'Wear protective latex gloves, gowns, masks and eye protection.',
      requirements,
    });

    expect(selection.coverage.status).toBe('complete');
    expect(selection.adopted).toBe(true);
    expect(selection.draftAnswer).toContain(originalDraft);
    expect(selection.draftAnswer).toContain(
      '"Clean-up should always be done wearing protective latex gloves, gowns, masks and eye protection."',
    );
    expect(selection.draftAnswer).toContain(`[doc:${sureBetHivLabel.documentId}]`);
  });

  it('keeps the appended HIV-1 cleanup PPE quote grounded for the validator', () => {
    const requirements = buildDecisiveAssertions({
      query: 'Which Betco disinfectants carry an HIV-1 claim, and what contact time applies?',
      sources: [sureBetHivLabel],
    });
    const selection = selectCoverageRevision({
      originalDraft: 'Triforce has a one-minute HIV-1 contact time.',
      revisionCandidate: 'Protective gloves, gowns, masks and eye protection are required.',
      requirements,
    });
    const grounding = evaluateRegulatedClaimGrounding({
      draftAnswer: selection.draftAnswer,
      sources: [
        {
          documentId: sureBetHivLabel.documentId,
          title: 'Sure Bet II label',
          documentBody: sureBetHivLabel.documentBody,
        },
      ],
    });

    expect(grounding.ungroundedCategories).not.toContain('hazard');
  });

  it('does not infer HIV-1 cleanup PPE from efficacy-only evidence', () => {
    const requirements = buildDecisiveAssertions({
      query: 'Which products carry an HIV-1 claim?',
      sources: [
        {
          ...sureBetHivLabel,
          documentKind: 'efficacy',
        },
      ],
    });

    expect(requirements).toEqual([]);
  });

  it('requires AF79 rinse evidence and product-specific no-rinse policies together', () => {
    const requirements = buildDecisiveAssertions({
      query: 'Do I have to rinse food-contact surfaces after disinfecting them with AF79?',
      sources: [af79Label],
    });
    const result = evaluateAnswerCoverage({
      draftAnswer:
        'Food-contact surfaces must be rinsed with potable water after disinfection.',
      requirements,
    });

    expect(requirements.map((requirement) => requirement.id)).toEqual([
      `food-contact:${af79Label.documentId}:potable-rinse`,
      'policy:no-rinse-claim-must-be-on-specific-product-label',
      'policy:do-not-infer-no-rinse-from-product-name',
    ]);
    expect(result.status).toBe('revision_required');
    expect(result.missingAssertionIds).toEqual([
      'policy:no-rinse-claim-must-be-on-specific-product-label',
      'policy:do-not-infer-no-rinse-from-product-name',
    ]);
  });

  it('preserves the AF79 answer while adding both missing no-rinse policies', () => {
    const requirements = buildDecisiveAssertions({
      query: 'Do I have to rinse food-contact surfaces after disinfecting them with AF79?',
      sources: [af79Label],
    });
    const originalDraft =
      'Yes. Food-contact surfaces must be rinsed with potable water after disinfection.';
    const selection = selectCoverageRevision({
      originalDraft,
      revisionCandidate:
        'A no-rinse claim must appear on the product label. Do not infer it from the product name.',
      requirements,
    });

    expect(selection.coverage.status).toBe('complete');
    expect(selection.adopted).toBe(true);
    expect(selection.draftAnswer).toContain(originalDraft);
    expect(selection.draftAnswer).toContain(
      'A no-rinse food-contact claim must be printed on the current label of that specific product.',
    );
    expect(selection.draftAnswer).toContain(
      'Do not infer a no-rinse food-contact claim from the product name or from use in kitchens or food-handling areas.',
    );
  });

  it('adds the exact AF79 rinse quote when the original answer omits it', () => {
    const requirements = buildDecisiveAssertions({
      query: 'Is AF79 a no-rinse product for food-contact surfaces?',
      sources: [af79Label],
    });
    const selection = selectCoverageRevision({
      originalDraft: 'Check the label before using AF79.',
      revisionCandidate: 'Rinse after use.',
      requirements,
    });

    expect(selection.coverage.status).toBe('complete');
    expect(selection.draftAnswer).toContain(
      '"Food contact surfaces must be rinsed with potable water after disinfection. Do not use on utensils, glassware and dishes."',
    );
    expect(selection.draftAnswer).toContain(`[doc:${af79Label.documentId}]`);
  });

  it('keeps the AF79 rinse repair clear of validator redaction', () => {
    const requirements = buildDecisiveAssertions({
      query: 'Do I have to rinse food-contact surfaces after disinfecting them with AF79?',
      sources: [af79Label],
    });
    const selection = selectCoverageRevision({
      originalDraft:
        'Food-contact surfaces must be rinsed with potable water after disinfection.',
      revisionCandidate: 'Follow the product label.',
      requirements,
    });
    const grounding = evaluateRegulatedClaimGrounding({
      draftAnswer: selection.draftAnswer,
      sources: [
        {
          documentId: af79Label.documentId,
          title: 'AF79 label',
          documentBody: af79Label.documentBody,
        },
      ],
    });

    expect(grounding.ungroundedCategories).toEqual([]);
  });

  it('does not infer food-contact rinse requirements without a selected label', () => {
    const requirements = buildDecisiveAssertions({
      query: 'Do I have to rinse food-contact surfaces after disinfecting them with AF79?',
      sources: [{ ...af79Label, documentKind: 'sds' }],
    });

    expect(requirements).toEqual([]);
  });

  it('requires the complete soft-surface sanitization scope from the selected label', () => {
    const requirements = buildDecisiveAssertions({
      query: 'Can I use GE Fight Bac RTU to sanitize upholstery, curtains, or a wrestling mat?',
      sources: [geFightBacLabel],
    });

    expect(requirements.map((requirement) => requirement.id)).toEqual([
      `soft-surface:${geFightBacLabel.documentId}:sanitization-scope`,
      `soft-surface:${geFightBacLabel.documentId}:contact-60s`,
      `soft-surface:${geFightBacLabel.documentId}:organisms`,
      'policy:soft-surface-is-sanitization-not-disinfection',
      'policy:soft-surface-organism-list-is-closed',
    ]);

    const incomplete = evaluateAnswerCoverage({
      draftAnswer: 'Use it on upholstery and let it stand for 60 seconds.',
      requirements,
    });
    expect(incomplete.missingAssertionIds).toEqual(
      expect.arrayContaining([
        `soft-surface:${geFightBacLabel.documentId}:organisms`,
        'policy:soft-surface-is-sanitization-not-disinfection',
        'policy:soft-surface-organism-list-is-closed',
      ]),
    );
  });

  it('keeps the ROW-25 organism list validator-grounded as its own exact quote', () => {
    const requirements = buildDecisiveAssertions({
      query: 'Can I use GE Fight Bac RTU to sanitize upholstery?',
      sources: [geFightBacLabel],
    });
    const draftAnswer = [
      'This is a soft-surface sanitization claim, not a disinfection claim.',
      'Keep the surface wet for 60 seconds.',
      '"Effective against Klebsiella aerogenes and Staphylococcus aureus."',
      'The soft-surface claim is limited to only those two named organisms.',
    ].join('\n');

    expect(evaluateAnswerCoverage({ draftAnswer, requirements }).status).toBe('complete');
    const grounding = evaluateRegulatedClaimGrounding({
      draftAnswer,
      sources: [
        {
          documentId: geFightBacLabel.documentId,
          title: 'GE Fight Bac RTU label',
          documentBody: geFightBacLabel.documentBody,
        },
      ],
    });
    expect(grounding.ungroundedCategories).not.toContain('efficacy_claim');
  });

  it('does not activate for unrelated questions', () => {
    expect(
      buildDecisiveAssertions({ query: 'What color is this product?', sources: [speedexLabel] }),
    ).toEqual([]);
  });
});
