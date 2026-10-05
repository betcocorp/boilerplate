import { describe, expect, it } from 'vitest';

import { resolvePassageIntent } from '~/lib/retrieval/passage-intent';

describe('resolvePassageIntent', () => {
  it('maps dilution/contact-time intent to label directions and dilution sections', () => {
    expect(
      resolvePassageIntent(
        'What dilution ratio does pH7Q use?',
        'organism_contact_time',
      ),
    ).toEqual({
      key: 'organism_contact_time',
      sdsSectionTypes: ['organism_contact_time'],
      labelSectionTypes: ['directions', 'dilution', 'epa_claims'],
    });
  });

  it('combines label directions and hazards for PPE intent', () => {
    expect(resolvePassageIntent('What PPE do I need?', 'exposure_ppe')).toEqual({
      key: 'exposure_ppe',
      sdsSectionTypes: ['hazard', 'exposure_ppe'],
      labelSectionTypes: ['directions', 'hazards'],
    });
  });

  it('does not rank label text as a substitute for SDS physical properties', () => {
    expect(resolvePassageIntent('What is the pH?', 'physical_properties')).toEqual({
      key: 'physical_properties',
      sdsSectionTypes: ['physical_properties'],
      labelSectionTypes: [],
    });
  });

  it('recognizes soft-surface label directions without forcing an SDS section', () => {
    expect(
      resolvePassageIntent(
        'Can I sanitize upholstery, curtains, or a wrestling mat?',
        null,
      ),
    ).toEqual({
      key: 'soft_surface_sanitization',
      sdsSectionTypes: [],
      labelSectionTypes: ['surfaces', 'directions'],
    });
  });

  it('does not force passage hydration for an unrelated broad query', () => {
    expect(resolvePassageIntent('Tell me about this product', null)).toBeNull();
  });
});
