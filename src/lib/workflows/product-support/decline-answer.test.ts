import { describe, expect, it } from 'vitest';

import { isDeclineAnswer } from '~/lib/workflows/product-support/run-product-support-workflow';

describe('isDeclineAnswer — guards the cross-reference headline against declines', () => {
  it('detects the recommendations agent sub-threshold decline', () => {
    expect(
      isDeclineAnswer(
        "I'm sorry, but I don't have enough information to provide that answer. Please contact a Betco sales representative directly.",
      ),
    ).toBe(true);
  });

  it('detects the product agent low-confidence decline', () => {
    expect(
      isDeclineAnswer(
        "I don't have enough verified information to answer that accurately.",
      ),
    ).toBe(true);
  });

  it('does not flag a genuine recommendation answer', () => {
    expect(
      isDeclineAnswer(
        'Comparable Betco product: Triforce (#333). It is a one-step quat disinfectant matching the 3-minute contact time.',
      ),
    ).toBe(false);
  });
});
