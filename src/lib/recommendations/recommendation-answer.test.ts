import { describe, expect, it } from 'vitest';

import { buildCompetitiveRecommendationAnswer } from '~/lib/recommendations/recommendation-answer';

describe('buildCompetitiveRecommendationAnswer', () => {
  const base = {
    competitorLabel: 'Spartan BNC-15',
    recommendedTitle: 'Triforce Disinfectant',
    chemistryClass: 'quat',
    competitorEpa: '6836-348',
    betcoEpa: '6836-349',
    rationale:
      'Same third-party manufacturer (EPA registrant 6836): BNC-15 (6836-348) and Triforce (6836-349) are equivalent one-step quats.',
  };

  it('leads with the product, explains why, and shows the shared registrant', () => {
    const out = buildCompetitiveRecommendationAnswer(base);
    expect(out).toContain('Comparable Betco product: **Triforce Disinfectant**');
    expect(out).toContain('**Why this is the match**');
    expect(out).toContain('| EPA registration | 6836-348 | 6836-349 |');
    expect(out).toContain('| EPA registrant | 6836 | 6836 (shared) |');
  });

  it('shows alternatives only when at least two exist', () => {
    const none = buildCompetitiveRecommendationAnswer({ ...base, alternatives: [{ name: 'Quat-Stat 5' }] });
    expect(none).not.toContain('Other Betco options');
    const two = buildCompetitiveRecommendationAnswer({
      ...base,
      alternatives: [{ name: 'Quat-Stat 5' }, { name: 'Quat-Stat SC' }, { name: 'Extra' }],
    });
    expect(two).toContain('**Other Betco options**');
    expect(two).toContain('- Quat-Stat 5 — same quat disinfectant chemistry');
    expect(two).toContain('- Quat-Stat SC — same quat disinfectant chemistry');
    expect(two).not.toContain('- Extra'); // capped at 2
  });

  it('renders Not established rather than inventing missing specs', () => {
    const out = buildCompetitiveRecommendationAnswer({
      competitorLabel: 'Acme X',
      recommendedTitle: 'Betco Y',
      chemistryClass: 'quat',
    });
    expect(out).toContain('| EPA registration | Not established | Not established |');
    expect(out).not.toContain('(shared)');
  });
});
