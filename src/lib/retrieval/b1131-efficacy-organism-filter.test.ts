import { describe, expect, it } from 'vitest';

import { getEfficacyDataInputSchema } from '~/lib/tools/tool-schemas';

/**
 * B0-1131 — `get_efficacy_data` received `category: ""` next to a productName and 400'd the whole
 * call (live ROW-09/23 runs), so no verified efficacy facts reached the turn.
 */
describe('getEfficacyDataInputSchema — B0-1131 blank category', () => {
  it('accepts a blank category alongside a product and treats it as absent', () => {
    const parsed = getEfficacyDataInputSchema.safeParse({ productName: 'Quat-Stat 5', category: '', organism: 'SARS-CoV-2' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.productId).toBe('Quat-Stat 5');
    expect(parsed.data.category?.trim() || undefined).toBeUndefined();
  });

  it('still rejects a call with no product, productIds or category at all', () => {
    expect(getEfficacyDataInputSchema.safeParse({ category: '  ' }).success).toBe(false);
  });
});
