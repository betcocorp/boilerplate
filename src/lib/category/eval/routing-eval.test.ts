import { describe, expect, it } from 'vitest';

import { ROUTING_EVAL_DATASET } from '~/lib/category/eval/routing-eval-dataset';
import { ROUTING_EVAL_TAXONOMY } from '~/lib/category/eval/routing-eval-taxonomy';
import { evaluateRouting, sweepRoutingThresholds } from '~/lib/category/eval/routing-eval';

const DEFAULT_THRESHOLD = 0.8; // matches BEX_CATEGORY_ROUTE_MIN_CONFIDENCE default

describe('category routing eval (B0-32)', () => {
  it('reports a precision/recall sweep across thresholds', () => {
    const sweep = sweepRoutingThresholds(
      ROUTING_EVAL_DATASET,
      ROUTING_EVAL_TAXONOMY,
      [0.7, 0.75, 0.8, 0.9, 0.95, 1.0],
    );
    // Surfaced in CI output for tuning; every row covers the whole labeled set.
    for (const m of sweep) {
      process.stdout.write(
        `[routing-eval] thr=${m.threshold} P=${m.precision} R=${m.recall} F1=${m.f1} ` +
          `TP=${m.truePositives} FP=${m.falsePositives} FN=${m.falseNegatives} TN=${m.trueNegatives}\n`,
      );
    }
    expect(sweep).toHaveLength(6);
    for (const m of sweep) {
      expect(m.total).toBe(ROUTING_EVAL_DATASET.length);
    }
  });

  it('meets precision/recall floors at the default threshold (regressions fail here)', () => {
    // Current @0.8: precision 0.938, recall 1.0, F1 0.968. Floors sit just below, so a real
    // routing regression trips the build while normal variance does not.
    const m = evaluateRouting(ROUTING_EVAL_DATASET, ROUTING_EVAL_TAXONOMY, DEFAULT_THRESHOLD);
    expect(m.recall).toBeGreaterThanOrEqual(0.9);
    expect(m.precision).toBeGreaterThanOrEqual(0.85);
    expect(m.f1).toBeGreaterThanOrEqual(0.9);
  });

  it('recall is monotonically non-increasing as the threshold rises', () => {
    const sweep = sweepRoutingThresholds(ROUTING_EVAL_DATASET, ROUTING_EVAL_TAXONOMY, [0.7, 0.8, 0.9, 1.0]);
    for (let i = 1; i < sweep.length; i += 1) {
      expect(sweep[i].recall).toBeLessThanOrEqual(sweep[i - 1].recall);
    }
  });
});
