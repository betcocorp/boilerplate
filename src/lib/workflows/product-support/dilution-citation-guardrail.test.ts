import { describe, expect, it } from 'vitest';

import { evaluateVerifiedFactsDilutionCitation } from '~/lib/workflows/product-support/validator';

/**
 * B0-699 — a narrower, stricter companion to the `evaluateRegulatedClaimGrounding` verbatim check
 * (`regulated-claim-guardrail.test.ts`): that check only confirms a dilution figure appears
 * SOMEWHERE in the turn's retrieved evidence, which a multi-product `verified-facts` block can
 * satisfy with a REAL row that belongs to a different, unrelated product line than the one
 * actually asked about. This guardrail instead requires the cited figure to match the LOCKED
 * product line's own fact row specifically.
 *
 * Reproduces the live incident: workflow run 61cc4ce9-bc1b-4d08-9b88-bc7d52c7365b answered "What
 * is the dilution ratio in oz per gallon for DAILY DISINFECT?" with "2 oz/gal (1:64)" citing
 * `[doc:verified-facts]` — a genuine `rag.product_line_fact` row (product line
 * 69D2F9A9-86BF-4389-B8B1-DDE4E3FF1967, "Disinfectant"/VersiFect, confidence 0.75), but the
 * product line the broad probe actually locked onto that turn
 * (E5A06FEB-AABC-4BE1-B59D-6B45C68D2F21, "Sen Emerging Storm Con") has its own dilution on file as
 * "1:20" — never "1:64". The real "Daily Disinfectant" product lines
 * (EE1A5D28-A960-4894-A5CE-9CB4CD127A66 / 2621547A-08D8-4833-89C1-AB467ECA4F68) carry
 * `dilution_display: '1:256'`, `dilution_oz_per_gal: null` — also never "1:64".
 */

const DAILY_DISINFECT_ANSWER =
  'The dilution ratio for DAILY DISINFECT is 2 oz per gallon of water (1:64 dilution) for general disinfection, as stated in the verified product facts [doc:verified-facts], [doc:ebbaf3bd-b87a-45f5-99bc-a92742bef8ef].';

describe('evaluateVerifiedFactsDilutionCitation', () => {
  it('not applicable when the draft never cites [doc:verified-facts]', () => {
    const result = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: 'The dilution ratio is 2 oz/gal [doc:abc-123].',
      lockedFacts: { dilutionDisplay: '1:64', dilutionOzPerGal: 2 },
    });
    expect(result.applicable).toBe(false);
    expect(result.grounded).toBe(true);
  });

  it('not applicable when the draft cites verified-facts but asserts no dilution figure', () => {
    const result = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: 'This product has an EPA registration on file [doc:verified-facts].',
      lockedFacts: { dilutionDisplay: '1:256', dilutionOzPerGal: null },
    });
    expect(result.applicable).toBe(false);
  });

  it('B0-699: rejects the live incident — cited "1:64 (2 oz/gal)" does not match the locked product line\'s own "1:20"', () => {
    const result = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: DAILY_DISINFECT_ANSWER,
      // The turn's ACTUAL locked product line (E5A06FEB, "Sen Emerging Storm Con") — its own
      // dilution fact, never the unrelated "Disinfectant"/VersiFect row the draft actually quoted.
      lockedFacts: { dilutionDisplay: '1:20', dilutionOzPerGal: null },
    });
    expect(result.applicable).toBe(true);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedTokens.length).toBeGreaterThan(0);
  });

  it('B0-699: rejects when the "Daily Disinfectant" product\'s own real facts are checked (1:256, never 1:64)', () => {
    const result = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: DAILY_DISINFECT_ANSWER,
      lockedFacts: { dilutionDisplay: '1:256', dilutionOzPerGal: null },
    });
    expect(result.applicable).toBe(true);
    expect(result.grounded).toBe(false);
  });

  it('B0-699: rejects when there is no locked product line at all to verify against', () => {
    const result = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: DAILY_DISINFECT_ANSWER,
      lockedFacts: null,
    });
    expect(result.applicable).toBe(true);
    expect(result.grounded).toBe(false);
  });

  it('grounded when the cited figure matches the locked line\'s own dilution_display exactly', () => {
    const result = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: 'Use a 1:64 dilution for this product [doc:verified-facts].',
      lockedFacts: { dilutionDisplay: '1:64', dilutionOzPerGal: 2 },
    });
    expect(result.applicable).toBe(true);
    expect(result.grounded).toBe(true);
    expect(result.ungroundedTokens).toEqual([]);
  });

  it('grounded when the cited figure matches the locked line\'s own oz/gal value in a different spelling', () => {
    const result = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: 'Dilute at 2 oz per gallon [doc:verified-facts].',
      lockedFacts: { dilutionDisplay: null, dilutionOzPerGal: 2 },
    });
    expect(result.applicable).toBe(true);
    expect(result.grounded).toBe(true);
  });

  it('grounded on the per-product batch citation form [doc:verified-facts:<productLineKey>]', () => {
    const result = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: 'Dilute at 1:256 [doc:verified-facts:2621547A-08D8-4833-89C1-AB467ECA4F68].',
      lockedFacts: { dilutionDisplay: '1:256', dilutionOzPerGal: null },
    });
    expect(result.applicable).toBe(true);
    expect(result.grounded).toBe(true);
  });
});
