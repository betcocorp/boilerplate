import { describe, expect, it } from 'vitest';

import { evaluateUsageSafetyCoverage } from '~/lib/workflows/product-support/run-product-support-workflow';

/**
 * B0-365 — the usage/safety coverage gate clamps confidence to 0.55 and marks the
 * answer unapproved. It used to scan only `title` + `snippet`, while
 * `search_product_docs` returns full documents ("read documentBody, not just
 * snippet") and the agent answers from that body — so grounded answers were clamped.
 *
 * The gate itself is unchanged: no usage/safety evidence in ANY field still means no
 * coverage. Only the fields it looks at widened.
 */

type CoverageSource = Parameters<typeof evaluateUsageSafetyCoverage>[0][number];

function source(overrides: Partial<CoverageSource> = {}): CoverageSource {
  return {
    title: 'Betco pH7Q Dual Product Sheet',
    snippet: 'A neutral disinfectant cleaner concentrate.',
    documentBody: '',
    documentKind: 'label',
    ...overrides,
  };
}

describe('evaluateUsageSafetyCoverage — evidence in documentBody only', () => {
  it('finds usage and safety evidence that appears only in the document body', () => {
    expect(
      evaluateUsageSafetyCoverage([
        source({
          title: 'Betco pH7Q Dual',
          snippet: 'Neutral disinfectant cleaner concentrate for hard surfaces.',
          documentBody: [
            'Directions for Use: dilute 1/2 oz per gallon of water.',
            'Precautionary statements: wear protective eyewear. Hazard: causes eye irritation.',
          ].join('\n'),
        }),
      ]),
    ).toEqual({ hasUsageEvidence: true, hasSafetyEvidence: true });
  });

  it('still finds usage-only evidence in the body without inventing safety coverage', () => {
    expect(
      evaluateUsageSafetyCoverage([
        source({
          title: 'Betco Fight Bac RTU',
          snippet: 'Ready-to-use product overview.',
          documentBody: 'Application: spray onto the surface and allow to remain wet.',
        }),
      ]),
    ).toEqual({ hasUsageEvidence: true, hasSafetyEvidence: false });
  });

  it('scans at most the first 4,000 chars of a body (signal past the cap is not read)', () => {
    const padded = `${'q'.repeat(4_200)} first aid: rinse with water`;
    expect(
      evaluateUsageSafetyCoverage([
        source({ title: 'Filler', snippet: 'Filler.', documentBody: padded }),
      ]),
    ).toEqual({ hasUsageEvidence: false, hasSafetyEvidence: false });

    expect(
      evaluateUsageSafetyCoverage([
        source({
          title: 'Filler',
          snippet: 'Filler.',
          documentBody: `first aid: rinse with water ${padded}`,
        }),
      ]),
    ).toEqual({ hasUsageEvidence: false, hasSafetyEvidence: true });
  });
});

describe('evaluateUsageSafetyCoverage — genuinely no evidence still reports none', () => {
  it('reports no coverage when title, snippet and body all lack usage/safety text', () => {
    expect(
      evaluateUsageSafetyCoverage([
        source({
          title: 'Betco Corporate Overview',
          snippet: 'Betco is headquartered in Toledo, Ohio.',
          documentBody: 'Founded in 1950. Manufacturing and distribution footprint.',
          documentKind: 'other',
        }),
      ]),
    ).toEqual({ hasUsageEvidence: false, hasSafetyEvidence: false });
  });

  it('reports no coverage for an empty source list', () => {
    expect(evaluateUsageSafetyCoverage([])).toEqual({
      hasUsageEvidence: false,
      hasSafetyEvidence: false,
    });
  });

  it('keeps the documentKind shortcuts (sds ⇒ safety, product_line_profile ⇒ usage)', () => {
    expect(
      evaluateUsageSafetyCoverage([
        source({ title: 'x', snippet: 'y', documentBody: '', documentKind: 'sds' }),
      ]),
    ).toEqual({ hasUsageEvidence: false, hasSafetyEvidence: true });

    expect(
      evaluateUsageSafetyCoverage([
        source({
          title: 'x',
          snippet: 'y',
          documentBody: '',
          documentKind: 'product_line_profile',
        }),
      ]),
    ).toEqual({ hasUsageEvidence: true, hasSafetyEvidence: false });
  });
});
