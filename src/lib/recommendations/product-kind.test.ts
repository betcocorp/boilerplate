import { describe, expect, it } from 'vitest';

import {
  KIND_COMPATIBILITY,
  classifyProductKind,
  compareProductKind,
  competitorKindText,
} from '~/lib/recommendations/product-kind';

describe('classifyProductKind (B0-795)', () => {
  it('maps competitor and Betco phrasing onto the same taxonomy leaves', () => {
    expect(classifyProductKind('glass cleaner')).toEqual({
      domain: 'general_cleaning',
      kind: 'glass_cleaner',
    });
    expect(classifyProductKind('Non-Ammoniated Glass Cleaner')).toEqual({
      domain: 'general_cleaning',
      kind: 'glass_cleaner',
    });
    expect(classifyProductKind('Low Foam Extraction Cleaner')).toEqual({
      domain: 'carpet_care',
      kind: 'carpet_cleaner',
    });
    expect(classifyProductKind('Neutral Daily Floor Cleaner Concentrate')).toEqual({
      domain: 'floor_care',
      kind: 'floor_cleaner',
    });
  });

  it('returns null rather than guessing when nothing in the vocabulary matches', () => {
    expect(classifyProductKind('')).toBeNull();
    expect(classifyProductKind(null)).toBeNull();
    expect(classifyProductKind('Betco X')).toBeNull();
  });

  describe('ordering: the specific rule must win over the general one', () => {
    it('separates acid-free from acid bowl cleaners', () => {
      // The B0-795 exemplar: Hang-Tite Plus (acid) answered with an ACID FREE disinfectant.
      expect(classifyProductKind('Concentrated Acid Free Bathroom Disinfectant')).toEqual({
        domain: 'restroom',
        kind: 'bowl_cleaner_acid_free',
      });
      expect(classifyProductKind('Kling 9% HCl Thick Bowl Cleaner')).toEqual({
        domain: 'restroom',
        kind: 'bowl_cleaner_acid',
      });
    });

    it('separates strippers, finishes and sealers within floor care', () => {
      expect(classifyProductKind('floor finish remover')).toMatchObject({ kind: 'stripper' });
      expect(classifyProductKind('high solids floor finish')).toMatchObject({ kind: 'floor_finish' });
      expect(classifyProductKind('Metal Interlocked Acrylic Polymer Floor Sealer')).toMatchObject({
        kind: 'floor_sealer',
      });
    });

    it('treats a restroom or floor disinfectant as that domain first', () => {
      // Collapsing everything that says "disinfectant" into one bucket is what makes a chemistry
      // swap invisible, so the domain rules deliberately run before the disinfectant rule.
      expect(classifyProductKind('restroom disinfectant cleaner')).toMatchObject({
        domain: 'restroom',
      });
      expect(classifyProductKind('one-step disinfectant for hard surfaces')).toMatchObject({
        domain: 'disinfectants',
      });
    });

    it('only classifies as odor control when odor IS the purpose', () => {
      // Nearly every cleaner claims to deodorize; an eager odor rule swallowed disinfectants,
      // laundry detergents and bowl cleaners on the first measured pass (B0-795).
      expect(classifyProductKind('Ready-To-Use Malodor Eliminator')).toMatchObject({
        domain: 'odor',
      });
      expect(classifyProductKind('disinfectant cleaner and deodorant for nonporous surfaces')).toMatchObject(
        { domain: 'disinfectants' },
      );
    });
  });
});

describe('competitorKindText (B0-795)', () => {
  it('uses only the structured category/use fields, never marketing claims', () => {
    const text = competitorKindText({
      productCategory: 'disinfectant',
      primaryUse: 'toilet bowls and urinals',
    });
    expect(text).toBe('disinfectant. toilet bowls and urinals');
    expect(text).not.toContain('fragrance');
  });

  it('tolerates missing fields', () => {
    expect(competitorKindText({ productCategory: null, primaryUse: null })).toBe('');
  });
});

describe('compareProductKind (B0-795)', () => {
  const base = { competitorText: 'bowl cleaner. toilet bowls' };

  it('scores same kind, same domain and cross-domain distinctly', () => {
    expect(compareProductKind({ ...base, candidateTitle: 'Thick Bowl Cleaner' }).score).toBe(
      KIND_COMPATIBILITY.sameKind,
    );
    expect(compareProductKind({ ...base, candidateTitle: 'Restroom Cleaner' }).score).toBe(
      KIND_COMPATIBILITY.sameDomain,
    );
    expect(compareProductKind({ ...base, candidateTitle: 'Heavy Duty Degreaser' }).score).toBe(
      KIND_COMPATIBILITY.mismatch,
    );
  });

  it('never fabricates agreement or disagreement when a side is unclassifiable', () => {
    expect(compareProductKind({ ...base, candidateTitle: 'Betco X' }).score).toBeNull();
    expect(
      compareProductKind({ competitorText: '', candidateTitle: 'Thick Bowl Cleaner' }).score,
    ).toBeNull();
  });

  it('prefers the candidate title over its evidence body', () => {
    // Chunk bodies routinely name neighbouring categories ("safe to use after stripping"), so
    // classifying on evidence first mislabels the candidate.
    const result = compareProductKind({
      ...base,
      candidateTitle: 'Thick Bowl Cleaner',
      candidateEvidence: 'Also suitable for use on carpet and upholstery after extraction.',
    });
    expect(result.candidate).toEqual({ domain: 'restroom', kind: 'bowl_cleaner' });
  });

  it('falls back to evidence only when the title says nothing', () => {
    const result = compareProductKind({
      ...base,
      candidateTitle: 'Betco 1234',
      candidateEvidence: 'A thick clinging toilet bowl cleaner.',
    });
    expect(result.candidate).toEqual({ domain: 'restroom', kind: 'bowl_cleaner' });
  });
});
