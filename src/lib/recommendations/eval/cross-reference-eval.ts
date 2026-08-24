import {
  groundCompetitorProduct,
  type CompetitorGroundingDeps,
} from '~/lib/recommendations/competitor-grounding';
import {
  evaluateRecommendationGate,
  type ChemistryClass,
} from '~/lib/recommendations/recommendation-gate';

/**
 * REC-8 — Regression eval for competitor → Betco recommendations, with category-match scoring.
 *
 * This is the HEADLESS decision-chain eval: for each golden pair it grounds the competitor
 * (deterministically, from supplied evidence text — no live web/LLM), checks whether the
 * grounded chemistry class matches the expected class, and confirms the category-consistency
 * gate approves the intended Betco product. It intentionally does NOT exercise live retrieval
 * of the Betco catalog (REC-2/REC-3 are data-gated) — the DB-backed admin harness eval set
 * (`tests`/`test_items`) is the follow-on that adds live-run + dashboard scoring.
 */

export type CrossReferenceEvalCase = {
  id: string;
  competitor: { brand?: string | null; productName: string };
  /** Grounded chemistry class the competitor should resolve to. */
  expectedChemistryClass: ChemistryClass;
  /** The Betco product the recommendation should land on (documented for the live eval). */
  expectedBetcoProduct: string;
  /** Deterministic evidence blob standing in for a web/SDS hit (keeps the eval offline). */
  groundingText: string;
  /** Chemistry class of the intended Betco recommendation, for scoring the consistency gate. */
  recommendedChemistryClass: ChemistryClass;
};

export type CrossReferenceEvalItemResult = {
  id: string;
  expectedBetcoProduct: string;
  grounded: boolean;
  groundedChemistryClass: ChemistryClass | null;
  categoryMatch: boolean;
  gateApproved: boolean;
  passed: boolean;
};

export type CrossReferenceEvalReport = {
  total: number;
  passed: number;
  categoryMatchAccuracy: number;
  items: CrossReferenceEvalItemResult[];
};

/** Golden set. Extend as new competitor→Betco pairs are confirmed. */
export const CROSS_REFERENCE_GOLDEN_SET: CrossReferenceEvalCase[] = [
  {
    id: 'bnc-15-triforce',
    competitor: { brand: 'Spartan Chemical', productName: 'BNC-15' },
    expectedChemistryClass: 'quat',
    expectedBetcoProduct: 'Triforce (#333)',
    groundingText:
      'BNC-15 is a one-step quaternary disinfectant cleaner with a 3-minute contact ' +
      'time. EPA Reg. No. 6836-348. Use at 1 oz/gal.',
    recommendedChemistryClass: 'quat',
  },
  {
    id: 'oxivir-peroxide',
    competitor: { brand: 'Diversey', productName: 'Oxivir Five 16' },
    expectedChemistryClass: 'peroxide',
    expectedBetcoProduct: 'Green Earth Peroxide Cleaner',
    groundingText:
      'Oxivir Five 16 is a hydrogen peroxide based cleaner disinfectant concentrate.',
    recommendedChemistryClass: 'peroxide',
  },
  {
    id: 'clorox-bleach-hypochlorite',
    competitor: { brand: 'Clorox', productName: 'Germicidal Bleach' },
    expectedChemistryClass: 'hypochlorite',
    expectedBetcoProduct: 'Betco Sodium Hypochlorite Disinfectant',
    groundingText:
      'Clorox Germicidal Bleach is a sodium hypochlorite disinfectant for hard surfaces.',
    recommendedChemistryClass: 'hypochlorite',
  },
];

function offlineDeps(groundingText: string): CompetitorGroundingDeps {
  return {
    lookupInternal: async () => null,
    fetchWeb: async () => ({ text: groundingText, citations: [] }),
  };
}

export async function runCrossReferenceEval(
  cases: CrossReferenceEvalCase[] = CROSS_REFERENCE_GOLDEN_SET,
  deps?: { ground?: typeof groundCompetitorProduct },
): Promise<CrossReferenceEvalReport> {
  const ground = deps?.ground ?? groundCompetitorProduct;
  const items: CrossReferenceEvalItemResult[] = [];

  for (const testCase of cases) {
    const grounding = await ground(
      testCase.competitor,
      offlineDeps(testCase.groundingText),
    );
    const grounded = grounding.status === 'grounded';
    const groundedChemistryClass = grounded
      ? grounding.spec.chemistryClass
      : null;
    const categoryMatch =
      grounded && groundedChemistryClass === testCase.expectedChemistryClass;

    const gate = await evaluateRecommendationGate({
      baseConfidence: 0.9,
      topSimilarity: 0.85,
      competitorChemistryClass: groundedChemistryClass,
      recommendedChemistryClass: testCase.recommendedChemistryClass,
    });

    items.push({
      id: testCase.id,
      expectedBetcoProduct: testCase.expectedBetcoProduct,
      grounded,
      groundedChemistryClass,
      categoryMatch,
      gateApproved: gate.approved,
      passed: categoryMatch && gate.approved,
    });
  }

  const passed = items.filter((i) => i.passed).length;
  return {
    total: items.length,
    passed,
    categoryMatchAccuracy: items.length > 0 ? passed / items.length : 0,
    items,
  };
}
