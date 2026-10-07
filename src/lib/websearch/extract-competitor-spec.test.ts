import { describe, expect, it } from 'vitest';

import {
  competitorSpecSchema,
  extractCompetitorSpec,
} from '~/lib/websearch/extract-competitor-spec';

describe('extractCompetitorSpec', () => {
  it('extracts a quat disinfectant spec (BNC-15-style text)', () => {
    const text =
      'BNC-15 is a one-step quaternary disinfectant cleaner with a 3-minute contact ' +
      'time. EPA Reg. No. 6836-348. Use at 1 oz/gal.';
    const spec = extractCompetitorSpec(text);

    expect(spec.chemistryClass).toBe('quat');
    expect(spec.epaRegistration).toBe('6836-348');
    expect(spec.contactTimeSeconds).toBe(180);
    expect(spec.dilutionOzPerGal).toBe(1);
    expect(competitorSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('extracts a more-dilute quat (Triforce-style text) with seconds contact time', () => {
    const text =
      'Betco Triforce is a one-step quat concentrate. Disinfects at 0.5 oz/gal ' +
      '(1:256). 60-second kill for HIV-1. EPA Registration # 6836-349.';
    const spec = extractCompetitorSpec(text);

    expect(spec.chemistryClass).toBe('quat');
    expect(spec.epaRegistration).toBe('6836-349');
    expect(spec.contactTimeSeconds).toBe(60);
    expect(spec.dilutionOzPerGal).toBe(0.5);
  });

  it('classifies peroxide chemistry and returns nulls for absent fields', () => {
    const spec = extractCompetitorSpec('A hydrogen peroxide based cleaner for hard surfaces.');
    expect(spec.chemistryClass).toBe('peroxide');
    expect(spec.epaRegistration).toBeNull();
    expect(spec.contactTimeSeconds).toBeNull();
    expect(spec.dilutionOzPerGal).toBeNull();
  });

  it('returns all-nulls for empty input', () => {
    expect(extractCompetitorSpec('')).toEqual({
      chemistryClass: null,
      epaRegistration: null,
      contactTimeSeconds: null,
      dilutionOzPerGal: null,
    });
  });
});
