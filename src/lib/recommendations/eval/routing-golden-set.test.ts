import { describe, expect, it } from 'vitest';

import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';
import {
  ROUTING_GOLDEN_SET,
  runRoutingGoldenSet,
} from '~/lib/recommendations/eval/routing-golden-set';
import { shouldForceCrossReferenceLookup } from '~/lib/workflows/product-support/run-product-support-workflow';

/**
 * B0-339 — the routing golden set must stay at 100%. Any drop means a cross-reference request is
 * being mislabeled again (and so silently skipping the curated-override path), or the widened
 * cross-reference post-processing has started swallowing ordinary product questions.
 */

const deps = {
  route: routeUserMessageToSme,
  hasCrossReferenceIntent: shouldForceCrossReferenceLookup,
};

describe('routing golden set (B0-339)', () => {
  const report = runRoutingGoldenSet(deps);

  it('routes every case correctly', () => {
    // Name the failures rather than just the count, so a red CI run is actionable on sight.
    const detail = report.failures
      .map(
        (f) =>
          `\n  ${f.id}: expected route=${f.expectedRoute} xref=${f.expectsCrossReferencePostProcessing}, ` +
          `got route=${f.actualRoute} xref=${f.actualCrossReferencePostProcessing}` +
          `\n    ${f.note}`,
      )
      .join('');

    expect(report.failures.length, `${report.failures.length} failing case(s):${detail}`).toBe(0);
    expect(report.passed).toBe(report.total);
    expect(report.routeAccuracy).toBe(1);
    expect(report.postProcessingAccuracy).toBe(1);
  });

  it('covers both sides of the boundary, so 100% is not a vacuous pass', () => {
    const engages = ROUTING_GOLDEN_SET.filter(
      (c) => c.expectsCrossReferencePostProcessing,
    );
    const doesNotEngage = ROUTING_GOLDEN_SET.filter(
      (c) => !c.expectsCrossReferencePostProcessing,
    );

    expect(engages.length).toBeGreaterThanOrEqual(8);
    expect(doesNotEngage.length).toBeGreaterThanOrEqual(8);
    // Every specialist route is represented, so widening cross-reference cannot quietly eat one.
    expect(new Set(ROUTING_GOLDEN_SET.map((c) => c.expectedRoute))).toEqual(
      new Set(['recommendations', 'product', 'floor', 'dilution', 'bathroom', null]),
    );
  });

  it('has a unique id and a stated rationale for every case', () => {
    const ids = ROUTING_GOLDEN_SET.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of ROUTING_GOLDEN_SET) {
      expect(testCase.note.length, testCase.id).toBeGreaterThan(20);
    }
  });

  it('states no regulated values, so the set can never become a source of an unverified claim', () => {
    // Messages may ASK about dilution ratios, contact times and EPA registrations; they must not
    // assert one. Guards against a future contributor pasting label data in as fixture text.
    const regulatedValue =
      /\b\d+(\.\d+)?\s*(oz\/gal|oz per gal|ml\/l|ppm|%)\b|\bEPA\s*(Reg\.?|Registration)?\s*(No\.?|#)\s*\d|\b\d+\s*-\s*\d+\s*minute\b/i;
    for (const testCase of ROUTING_GOLDEN_SET) {
      expect(regulatedValue.test(testCase.message), testCase.id).toBe(false);
    }
  });
});
