import { describe, expect, it, vi } from 'vitest';

import {
  CROSS_REFERENCE_GOLDEN_SET,
  runCrossReferenceEval,
} from '~/lib/recommendations/eval/cross-reference-eval';

// B0-756 — BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING now defaults to bypassed (true) in
// production pending a scorer fix, but this eval specifically regression-tests the
// category-mismatch rejection (the original BNC-15 bug) with gating active, independent of the
// live default — mock it deterministically rather than depending on a real Supabase read.
vi.mock('~/lib/settings/settings-service', () => ({
  getBooleanSetting: vi.fn(async (key: string, fallback: boolean) =>
    key === 'BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING' ? false : fallback,
  ),
  getStringSetting: vi.fn(async (_key: string, fallback: string) => fallback),
  getNumberSetting: vi.fn(async (_key: string, fallback: number) => fallback),
}));

describe('cross-reference regression eval (REC-8)', () => {
  it('passes the golden set at 100% category-match accuracy (incl. BNC-15 → Triforce #333)', async () => {
    const report = await runCrossReferenceEval();

    expect(report.total).toBe(CROSS_REFERENCE_GOLDEN_SET.length);
    expect(report.categoryMatchAccuracy).toBe(1);

    const bnc15 = report.items.find((i) => i.id === 'bnc-15-triforce');
    expect(bnc15?.passed).toBe(true);
    expect(bnc15?.groundedChemistryClass).toBe('quat');
    expect(bnc15?.expectedBetcoProduct).toBe('Triforce (#333)');
  });

  it('fails an item that cannot be grounded (scorer penalizes missing grounding)', async () => {
    const report = await runCrossReferenceEval([
      {
        id: 'ungroundable',
        competitor: { brand: 'Acme', productName: 'MysteryClean' },
        expectedChemistryClass: 'quat',
        expectedBetcoProduct: 'Betco X',
        groundingText: 'A general-purpose cleaner with no chemistry cues.',
        recommendedChemistryClass: 'quat',
      },
    ]);

    expect(report.categoryMatchAccuracy).toBe(0);
    expect(report.items[0]?.grounded).toBe(false);
    expect(report.items[0]?.passed).toBe(false);
  });

  it('fails an item where the recommended chemistry class mismatches the competitor (the BNC-15 bug)', async () => {
    const report = await runCrossReferenceEval([
      {
        id: 'wrong-class',
        competitor: { brand: 'Spartan', productName: 'BNC-15' },
        expectedChemistryClass: 'quat',
        expectedBetcoProduct: 'Green Earth Peroxide Cleaner',
        groundingText: 'BNC-15 one-step quaternary disinfectant, EPA Reg 6836-348.',
        recommendedChemistryClass: 'peroxide',
      },
    ]);

    expect(report.items[0]?.categoryMatch).toBe(true); // competitor grounded correctly as quat
    expect(report.items[0]?.gateApproved).toBe(false); // but a peroxide recommendation is rejected
    expect(report.items[0]?.passed).toBe(false);
  });
});
