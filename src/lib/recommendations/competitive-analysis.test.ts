import { describe, expect, it } from 'vitest';

import {
  epaRegistrant,
  formatCompetitiveAnalysis,
  sharedEpaRegistrant,
} from '~/lib/recommendations/competitive-analysis';

describe('epa registrant helpers (REC-3 output-side)', () => {
  it('extracts the registrant prefix and detects a shared registrant', () => {
    expect(epaRegistrant('6836-348')).toBe('6836');
    expect(sharedEpaRegistrant('6836-348', '6836-349')).toBe('6836');
    expect(sharedEpaRegistrant('6836-348', '1234-5')).toBeNull();
    expect(sharedEpaRegistrant('6836-348', null)).toBeNull();
  });
});

describe('formatCompetitiveAnalysis (REC-6)', () => {
  const analysis = formatCompetitiveAnalysis({
    competitor: {
      brand: 'Spartan Chemical',
      productName: 'BNC-15',
      spec: {
        chemistryClass: 'quat',
        epaRegistration: '6836-348',
        contactTimeSeconds: 180,
        dilutionOzPerGal: 1,
      },
      citations: ['https://example.com/bnc-15-sds'],
    },
    recommended: {
      name: 'Triforce (#333)',
      url: 'https://www.betco.com/products/triforce',
      chemistryClass: 'quat',
      epaRegistration: '6836-349',
      contactTimeSeconds: 180,
      dilutionOzPerGal: 0.5,
    },
  });

  it('leads with the linked Betco product and a head-to-head table', () => {
    expect(analysis).toContain(
      'Comparable Betco product: [Triforce (#333)](https://www.betco.com/products/triforce)',
    );
    expect(analysis).toContain('| Attribute | Spartan Chemical BNC-15 | Triforce (#333) |');
    expect(analysis).toContain('| Product type | quat | quat |');
    expect(analysis).toContain('| Dilution | 1 oz/gal | 0.5 oz/gal |');
  });

  it('cites the shared EPA registrant as supporting evidence', () => {
    expect(analysis).toContain('Same EPA registrant (6836)');
    expect(analysis).toContain('6836-348 ↔ 6836-349');
  });

  it('renders an explicit cost-in-use line (0.5 vs 1 oz/gal → ~2× more dilute)', () => {
    expect(analysis).toMatch(/Cost-in-use:.*0\.5 oz\/gal vs 1 oz\/gal.*2×/);
  });

  it('never invents unknown fields — renders "Not established" instead', () => {
    const sparse = formatCompetitiveAnalysis({
      competitor: {
        brand: null,
        productName: 'MysteryClean',
        spec: {
          chemistryClass: 'quat',
          epaRegistration: null,
          contactTimeSeconds: null,
          dilutionOzPerGal: null,
        },
      },
      recommended: { name: 'Betco X', chemistryClass: 'quat' },
    });
    expect(sparse).toContain('| EPA registration | Not established | Not established |');
    expect(sparse).toContain('| Contact time | Not established | Not established |');
    expect(sparse).not.toContain('Same EPA registrant');
    expect(sparse).toContain('comparison unavailable');
  });
});
