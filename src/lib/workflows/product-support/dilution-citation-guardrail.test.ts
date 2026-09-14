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

/**
 * B0-987 — a multi-product answer cites each product's OWN batch row (`[doc:verified-facts:<key>]`,
 * B0-549) and, on a `skipped_ambiguous` turn, locks nothing. The pre-B0-987 check compared every
 * figure against the LOCKED row only, so with no lock `groundedStrings` was empty and every batch
 * citation was ungrounded by construction (39ef58b3, "What should I use for greasy kitchen
 * floors?": `citedTokens ["2 oz/gal","1:16","1:64"]`, `lockedProductLineKey: null`, rejected).
 * Each figure is now checked against the row of the citation it is attached to — inline on its
 * line, or labelled with its bullet's product on the `Sources:` line — and only an unattached
 * figure falls back to the locked line.
 */
describe('evaluateVerifiedFactsDilutionCitation — B0-987 per-citation rows', () => {
  const CITRUS_KITCHEN = { dilutionDisplay: '1:16', dilutionOzPerGal: null };
  const CITRUS_CHISEL = { dilutionDisplay: '1:64', dilutionOzPerGal: 2 };

  it('two products, two inline citations, two different dilutions, no lock → passed', () => {
    const result = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: [
        '- **Citrus Kitchen Degreaser**: Dilution is 1:16 [doc:verified-facts:113104].',
        '- **Citrus Chisel**: Dilution is 1:64 (2 oz/gal) [doc:verified-facts:16704].',
      ].join('\n'),
      lockedFacts: null,
      citedFacts: new Map([
        ['113104', CITRUS_KITCHEN],
        ['16704', CITRUS_CHISEL],
      ]),
    });
    expect(result.applicable).toBe(true);
    expect(result.citedProductLineKeys).toEqual(['113104', '16704']);
    expect(result.ungroundedTokens).toEqual([]);
    expect(result.grounded).toBe(true);
  });

  it('grounds bullets whose citation sits on the trailing Sources: line, labelled with the bullet\'s product (39ef58b3 shape)', () => {
    const result = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: [
        'Here are the main Betco degreasers for greasy kitchen floors, with their verified dilution ratios and coverage from structured product facts:',
        '',
        '- **Kitchen Cleaner & Degreaser**: Coverage is 3,200 sq ft/gal. No verified dilution ratio is on file.',
        '- **Citrus Kitchen Degreaser**: Dilution is 1:16. Coverage is 3,200 sq ft/gal.',
        '- **Heavy Duty Cleaner/Degreaser (RTU)**: Ready to use (no dilution required). Coverage is 3,200 sq ft/gal.',
        '- **Citrus Chisel**: Dilution is 1:64 (2 oz/gal). Coverage is 500 sq ft/gal.',
        '',
        'Sources: Verified Product Facts (structured) — Kitchen Cleaner & Degreaser [doc:verified-facts:4C89E0DF-C964-408C-9328-D1E7B2102A25]; Citrus Kitchen Degreaser [doc:verified-facts:113104]; Heavy Duty Cleaner/Degreaser [doc:verified-facts:0E3DC4A7-26D9-42A7-A5BC-D1B4026E7229]; Citrus Chisel [doc:verified-facts:16704].',
      ].join('\n'),
      lockedFacts: null,
      citedFacts: new Map([
        ['4C89E0DF-C964-408C-9328-D1E7B2102A25', { dilutionDisplay: null, dilutionOzPerGal: null }],
        ['113104', CITRUS_KITCHEN],
        ['0E3DC4A7-26D9-42A7-A5BC-D1B4026E7229', { dilutionDisplay: 'Ready to use', dilutionOzPerGal: null }],
        ['16704', CITRUS_CHISEL],
      ]),
    });
    expect(result.applicable).toBe(true);
    expect(result.citedTokens).toEqual(['2 oz/gal', '1:16', '1:64']);
    expect(result.grounded).toBe(true);
  });

  it('still rejects a figure that does not match the row of the citation it is attached to (the row is real, the product is wrong)', () => {
    const result = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: [
        '- **Citrus Kitchen Degreaser**: Dilution is 1:64 (2 oz/gal) [doc:verified-facts:113104].',
        '- **Citrus Chisel**: Dilution is 1:64 (2 oz/gal) [doc:verified-facts:16704].',
      ].join('\n'),
      lockedFacts: null,
      citedFacts: new Map([
        ['113104', CITRUS_KITCHEN],
        ['16704', CITRUS_CHISEL],
      ]),
    });
    expect(result.grounded).toBe(false);
    // Reported once each; the first bullet's figures are the ungrounded ones.
    expect(result.ungroundedTokens).toEqual(['2 oz/gal', '1:64']);
  });

  it('a cited row with NO dilution on file grounds nothing for that bullet', () => {
    const result = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: '- **Kitchen Cleaner & Degreaser**: Dilution is 1:16 [doc:verified-facts:4C89E0DF-C964-408C-9328-D1E7B2102A25].',
      lockedFacts: { dilutionDisplay: '1:16', dilutionOzPerGal: null },
      citedFacts: new Map([
        ['4C89E0DF-C964-408C-9328-D1E7B2102A25', { dilutionDisplay: null, dilutionOzPerGal: null }],
      ]),
    });
    expect(result.grounded).toBe(false);
  });

  it('a figure attached to no citation still falls back to the locked line (and is rejected with no lock)', () => {
    const draftAnswer = 'Dilute at 1:256 for daily disinfection [doc:verified-facts]. Citrus Chisel is 1:64 [doc:verified-facts:16704].';
    const citedFacts = new Map([['16704', CITRUS_CHISEL]]);
    expect(
      evaluateVerifiedFactsDilutionCitation({
        draftAnswer,
        lockedFacts: { dilutionDisplay: '1:256', dilutionOzPerGal: null },
        citedFacts,
      }).grounded,
    ).toBe(true);
    const noLock = evaluateVerifiedFactsDilutionCitation({ draftAnswer, lockedFacts: null, citedFacts });
    expect(noLock.grounded).toBe(false);
    expect(noLock.ungroundedTokens).toEqual(['1:256']);
  });

  it('single-product locked behaviour is unchanged: the B0-699 incident is still rejected and a matching locked figure still passes', () => {
    const rejected = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: DAILY_DISINFECT_ANSWER,
      lockedFacts: { dilutionDisplay: '1:20', dilutionOzPerGal: null },
      citedFacts: new Map(),
    });
    expect(rejected.grounded).toBe(false);

    const passed = evaluateVerifiedFactsDilutionCitation({
      draftAnswer: 'Use a 1:64 dilution for this product [doc:verified-facts].',
      lockedFacts: { dilutionDisplay: '1:64', dilutionOzPerGal: 2 },
      citedFacts: new Map(),
    });
    expect(passed.grounded).toBe(true);
  });
});
