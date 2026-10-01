import { describe, expect, it, vi } from 'vitest';

import {
  groundCompetitorProduct,
  type CompetitorGroundingDeps,
} from '~/lib/recommendations/competitor-grounding';

const QUAT_WEB_TEXT =
  'BNC-15 is a one-step quaternary disinfectant cleaner with a 3-minute contact ' +
  'time. EPA Reg. No. 6836-348. Use at 1 oz/gal.';

describe('groundCompetitorProduct (REC-1)', () => {
  it('grounds a competitor to a structured spec via the web fallback (BNC-15 → quat)', async () => {
    const lookupInternal = vi.fn<CompetitorGroundingDeps['lookupInternal']>(
      async () => null,
    );
    const fetchWeb = vi.fn<CompetitorGroundingDeps['fetchWeb']>(async () => ({
      text: QUAT_WEB_TEXT,
      citations: ['https://example.com/bnc-15-sds'],
    }));

    const result = await groundCompetitorProduct(
      { brand: 'Spartan Chemical', productName: 'BNC-15' },
      { lookupInternal, fetchWeb },
    );

    expect(result.status).toBe('grounded');
    if (result.status !== 'grounded') return;
    expect(result.source).toBe('web');
    expect(result.spec.chemistryClass).toBe('quat');
    expect(result.spec.epaRegistration).toBe('6836-348');
    expect(result.spec.contactTimeSeconds).toBe(180);
    expect(result.citations).toEqual(['https://example.com/bnc-15-sds']);
    expect(lookupInternal).toHaveBeenCalledOnce();
  });

  it('prefers the internal cross-reference and does not hit the web when internal grounds it', async () => {
    const fetchWeb = vi.fn<CompetitorGroundingDeps['fetchWeb']>(async () => ({
      text: 'should not be used',
      citations: [],
    }));

    const result = await groundCompetitorProduct(
      { brand: 'Spartan', productName: 'BNC-15' },
      {
        lookupInternal: async () => ({
          text: 'One-step quat disinfectant cleaner, EPA Reg. 6836-348.',
        }),
        fetchWeb,
      },
    );

    expect(result.status).toBe('grounded');
    if (result.status !== 'grounded') return;
    expect(result.source).toBe('internal');
    expect(result.spec.chemistryClass).toBe('quat');
    expect(result.citations).toEqual([]);
    expect(fetchWeb).not.toHaveBeenCalled();
  });

  it('returns an explicit unresolved state (no fabricated spec) when nothing grounds it', async () => {
    const result = await groundCompetitorProduct(
      { brand: 'Acme', productName: 'MysteryClean 9000' },
      {
        lookupInternal: async () => null,
        fetchWeb: async () => ({
          text: 'A great general-purpose cleaning product for facilities.',
          citations: [],
        }),
      },
    );

    expect(result.status).toBe('unresolved');
    if (result.status !== 'unresolved') return;
    expect(result.attempted).toEqual(['internal', 'web']);
    expect(result).not.toHaveProperty('spec');
    expect(result.reason).toMatch(/refusing to guess/i);
  });

  it('falls through cleanly when a source throws (never crashes grounding)', async () => {
    const result = await groundCompetitorProduct(
      { productName: 'BNC-15' },
      {
        lookupInternal: async () => {
          throw new Error('legacy db unreachable');
        },
        fetchWeb: async () => ({ text: QUAT_WEB_TEXT, citations: [] }),
      },
    );

    expect(result.status).toBe('grounded');
    if (result.status !== 'grounded') return;
    expect(result.source).toBe('web');
    expect(result.brand).toBeNull();
  });

  it('is unresolved for an empty product name without attempting any source', async () => {
    const lookupInternal = vi.fn<CompetitorGroundingDeps['lookupInternal']>(
      async () => null,
    );
    const result = await groundCompetitorProduct(
      { productName: '   ' },
      { lookupInternal, fetchWeb: async () => null },
    );

    expect(result.status).toBe('unresolved');
    if (result.status !== 'unresolved') return;
    expect(result.attempted).toEqual([]);
    expect(lookupInternal).not.toHaveBeenCalled();
  });
});
