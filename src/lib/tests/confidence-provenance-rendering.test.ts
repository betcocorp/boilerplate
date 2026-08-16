import { describe, expect, it } from 'vitest';

import { extractItemConfidenceProvenance } from '~/lib/tests/response-payload';
import { formatItemSimilarityConfidenceLabel } from '~/lib/tests/format';

/**
 * B0-492 AC — "no confidence number renders anywhere without its provenance label". These cover
 * the shared read/format path used by the run-detail table AND the CSV `sim_conf` export column
 * (`~/app/(authenticated)/admin/tests/[testId]/runs/[runId]/page.tsx` sources both from
 * `formatItemSimilarityConfidenceLabel`).
 */

describe('extractItemConfidenceProvenance (B0-492)', () => {
  it('reads a valid provenance off the payload', () => {
    expect(extractItemConfidenceProvenance({ confidenceProvenance: 'validator_judged' })).toBe(
      'validator_judged',
    );
  });

  it('resolves a missing field to "unknown", never a judgment class', () => {
    expect(extractItemConfidenceProvenance({ confidence: 0.9 })).toBe('unknown');
    expect(extractItemConfidenceProvenance(null)).toBe('unknown');
    expect(extractItemConfidenceProvenance('not an object')).toBe('unknown');
  });

  it('resolves an invalid/unrecognized value to "unknown" rather than passing it through', () => {
    expect(extractItemConfidenceProvenance({ confidenceProvenance: 'made_up_value' })).toBe(
      'unknown',
    );
  });
});

describe('formatItemSimilarityConfidenceLabel (B0-492)', () => {
  it('appends the provenance label alongside the confidence number', () => {
    const label = formatItemSimilarityConfidenceLabel({
      sources: [{ similarity: 0.873 }],
      confidence: 0.9,
      confidenceProvenance: 'validator_bypassed_heuristic',
    });
    expect(label).toBe('87.3% / 0.90 (validator_bypassed_heuristic)');
  });

  it('labels a historical payload missing the field as "unknown", not silently omitted', () => {
    const label = formatItemSimilarityConfidenceLabel({
      sources: [{ similarity: 0.5 }],
      confidence: 0.6,
    });
    expect(label).toBe('50.0% / 0.60 (unknown)');
  });

  it('still returns "n/a" when there is nothing to show at all', () => {
    expect(formatItemSimilarityConfidenceLabel({})).toBe('n/a');
  });

  it('renders similarity-only without a dangling provenance label', () => {
    const label = formatItemSimilarityConfidenceLabel({ sources: [{ similarity: 0.4 }] });
    expect(label).toBe('40.0%');
    expect(label).not.toContain('(');
  });
});
