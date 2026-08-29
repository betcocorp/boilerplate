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

  /**
   * B0-760 — this composer discards the model's draft wholesale (B0-391), so the "organism claims
   * do not transfer" rule in the cross-reference specialist prompt is unreachable on this path: the
   * model can state it correctly and have it thrown away. The caveat must therefore be a property
   * of the template. The golden-set case that exposed this — "Betco's version of BNC-15 kills
   * everything BNC-15 does, right?" — graded 48/100 for omitting exactly this.
   */
  describe('organism-claim caveat (B0-760)', () => {
    it('always states that kill claims do not transfer, naming both products', () => {
      const out = buildCompetitiveRecommendationAnswer(base);
      expect(out).toContain('**Kill claims do not transfer**');
      expect(out).toContain("each product's own EPA registration and label");
      expect(out).toContain('Triforce Disinfectant covers only the organisms listed on its own');
      expect(out).toContain("Spartan BNC-15's claims");
    });

    it('calls out a shared registrant as not carrying claims across', () => {
      // The head-to-head table prints "(shared)" for a common registrant, which is precisely the
      // cue a reader would misread as equivalence — so the caveat has to name it.
      expect(buildCompetitiveRecommendationAnswer(base)).toContain('or a shared registrant,');
    });

    it('still renders the caveat when no registrations or competitor label are known', () => {
      const out = buildCompetitiveRecommendationAnswer({
        competitorLabel: '',
        recommendedTitle: 'Betco Y',
        chemistryClass: null,
      });
      expect(out).toContain('**Kill claims do not transfer**');
      expect(out).toContain("the competitor product's claims");
      // No shared registrant was established, so it must not claim one.
      expect(out).not.toContain('shared registrant');
    });
  });
});
