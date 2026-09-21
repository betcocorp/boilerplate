import { describe, expect, it } from 'vitest';

import {
  DILUTION_RELATIVE_TOLERANCE,
  extractContactTimes,
  extractDilutions,
  extractDins,
  extractEpaRegistrations,
  findMatchingValue,
  foldLiteral,
  normalizeContactTime,
  normalizeDilution,
  normalizeDin,
  normalizeEpaRegistration,
  normalizeFor,
  normalizedMatches,
} from './normalize';

describe('normalizeEpaRegistration', () => {
  it('canonicalizes every label form to the bare number', () => {
    const forms = [
      'EPA Reg. No. 1839-95',
      'EPA Registration Number 1839-95',
      'EPA Reg No: 1839-95',
      '1839-95',
      'epa reg. no. 1839-95',
    ];
    for (const form of forms) {
      expect(normalizeEpaRegistration(form).canonical).toBe('1839-95');
    }
  });

  it('parses the sub-registration segment and keeps the parent visible', () => {
    const sub = normalizeEpaRegistration('EPA Reg. No. 1839-95-10352');
    expect(sub.canonical).toBe('1839-95-10352');
    expect(sub.company).toBe('1839');
    expect(sub.product).toBe('95');
    expect(sub.subRegistration).toBe('10352');
    expect(sub.parent).toBe('1839-95');
  });

  it('does NOT match a sub-registration against its parent (different products)', () => {
    const parent = normalizeEpaRegistration('1839-95');
    const sub = normalizeEpaRegistration('1839-95-10352');
    expect(normalizedMatches(parent, sub)).toBe(false);
    expect(normalizedMatches(sub, parent)).toBe(false);
  });

  it('treats zero-padded segments as the same registration', () => {
    expect(normalizeEpaRegistration('01839-095').canonical).toBe('1839-95');
  });

  it('ignores ISO dates that share the bare shape', () => {
    expect(extractEpaRegistrations('Revised 2024-01-15 by QA')).toHaveLength(0);
  });

  it('extracts several registrations from one chunk', () => {
    const found = extractEpaRegistrations(
      'EPA Reg. No. 1839-95. Distributor product EPA Reg. No. 1839-95-10352.',
    );
    expect(found.map((entry) => entry.canonical)).toEqual(['1839-95', '1839-95-10352']);
  });

  it('falls back to a literal fold when nothing parses', () => {
    const value = normalizeEpaRegistration('exempt under 40 CFR');
    expect(value.company).toBeNull();
    expect(value.canonical).toBe('exempt under 40 cfr');
  });
});

describe('normalizeDin', () => {
  it('strips the DIN prefix and punctuation', () => {
    expect(normalizeDin('DIN 02245678').canonical).toBe('02245678');
    expect(normalizeDin('din no. 02245678').canonical).toBe('02245678');
    expect(normalizeDin('02245678').canonical).toBe('02245678');
  });

  it('rejects runs that are not exactly eight digits', () => {
    expect(normalizeDin('DIN 1234567').din).toBeNull();
    expect(extractDins('order 1234567890 units')).toHaveLength(0);
  });
});

describe('normalizeDilution', () => {
  it('converts a ratio to oz per gallon on the label convention', () => {
    const value = normalizeDilution('1:64');
    expect(value.ozPerGallon).toBeCloseTo(2, 10);
    expect(value.ratio).toEqual({ concentrate: 1, water: 64 });
    expect(value.canonical).toBe('ozpg:2');
  });

  it('reads the spelled-out ratio form', () => {
    expect(normalizeDilution('1 to 64').ozPerGallon).toBeCloseTo(2, 10);
  });

  it('reads every oz/gal spelling', () => {
    for (const form of ['2 oz per gallon', '2 oz/gal', '2 ounces per gallon', '2 fl oz/gallon']) {
      expect(normalizeDilution(form).ozPerGallon, form).toBeCloseTo(2, 10);
    }
  });

  it('keeps both forms when the label prints both', () => {
    const value = normalizeDilution('1:64 (2 oz/gal)');
    expect(value.ozPerGallon).toBeCloseTo(2, 10);
    expect(value.ratio).toEqual({ concentrate: 1, water: 64 });
  });

  it('matches a ratio against an oz/gal statement numerically', () => {
    expect(normalizedMatches(normalizeDilution('1:64'), normalizeDilution('2 oz/gal'))).toBe(true);
    expect(normalizedMatches(normalizeDilution('1:128'), normalizeDilution('1 oz/gal'))).toBe(true);
  });

  it('absorbs label rounding but not an adjacent dilution', () => {
    // 1:100 is 1.28 oz/gal; labels print 1.3.
    expect(normalizedMatches(normalizeDilution('1:100'), normalizeDilution('1.3 oz/gal'))).toBe(true);
    // 1:64 (2.0) vs 1:60 (2.133) is 6.7% apart — well outside the tolerance.
    expect(normalizedMatches(normalizeDilution('1:64'), normalizeDilution('1:60'))).toBe(false);
    expect(DILUTION_RELATIVE_TOLERANCE).toBe(0.02);
  });

  it('parses fractional amounts including the unicode vulgar fraction', () => {
    expect(normalizeDilution('1/2 oz per gallon').ozPerGallon).toBeCloseTo(0.5, 10);
    expect(normalizeDilution('½ oz/gal').ozPerGallon).toBeCloseTo(0.5, 10);
  });

  it('extracts three different dilution spellings from one chunk', () => {
    const text = 'Dilute 1:64 (2 oz/gal). For heavy soil use 4 ounces per gallon.';
    const strengths = extractDilutions(text)
      .map((entry) => entry.ozPerGallon)
      .filter((value): value is number => value !== null);
    expect(strengths).toContain(2);
    expect(strengths).toContain(4);
  });

  it('falls back to a literal fold for non-numeric directions', () => {
    const value = normalizeDilution('per label directions');
    expect(value.ozPerGallon).toBeNull();
    expect(value.canonical).toBe('per label directions');
  });
});

describe('normalizeContactTime', () => {
  it('canonicalizes to seconds', () => {
    expect(normalizeContactTime('10 minutes').seconds).toBe(600);
    expect(normalizeContactTime('10 min').seconds).toBe(600);
    expect(normalizeContactTime('600 seconds').seconds).toBe(600);
    expect(normalizeContactTime('1 minute').seconds).toBe(60);
    expect(normalizeContactTime('1 hr').seconds).toBe(3600);
  });

  it('matches across units', () => {
    expect(
      normalizedMatches(normalizeContactTime('10 minutes'), normalizeContactTime('600 sec')),
    ).toBe(true);
  });

  it('compares exactly — no tolerance on a regulated dwell time', () => {
    expect(
      normalizedMatches(normalizeContactTime('10 minutes'), normalizeContactTime('9 minutes')),
    ).toBe(false);
  });

  it('refuses single-letter unit abbreviations', () => {
    expect(extractContactTimes('hose length 10 m')).toHaveLength(0);
  });
});

describe('foldLiteral', () => {
  it('folds case, curly quotes, dashes and whitespace', () => {
    expect(foldLiteral('Don’t Use—Ever')).toBe("don't use-ever");
    expect(foldLiteral('  ready to​use \n\t spray. ')).toBe('ready to use spray');
    expect(foldLiteral('“Quaternary”')).toBe('quaternary');
  });

  it('applies NFKC so compatibility forms compare equal', () => {
    expect(foldLiteral('ﬁrst aid')).toBe('first aid');
    expect(foldLiteral('Ⅳ')).toBe('iv');
  });

  it('does not stem', () => {
    expect(
      normalizedMatches(normalizeFor('literal', 'disinfectant'), normalizeFor('literal', 'disinfect')),
    ).toBe(false);
  });

  it('matches a literal by containment in the surrounding text', () => {
    const required = normalizeFor('literal', 'Get medical attention');
    const chunk = normalizeFor('literal', 'Skin contact : Get medical attention immediately.');
    expect(normalizedMatches(required, chunk)).toBe(true);
  });

  it('never matches an empty literal', () => {
    expect(normalizedMatches(normalizeFor('literal', '   '), normalizeFor('literal', 'anything'))).toBe(
      false,
    );
  });
});

describe('normalizeFor', () => {
  it('dispatches to the right normalizer for every kind', () => {
    expect(normalizeFor('epa_registration', 'EPA Reg. No. 1839-95').kind).toBe('epa_registration');
    expect(normalizeFor('din', 'DIN 02245678').kind).toBe('din');
    expect(normalizeFor('dilution', '1:64').kind).toBe('dilution');
    expect(normalizeFor('contact_time', '10 minutes').kind).toBe('contact_time');
    expect(normalizeFor('literal', 'anything').kind).toBe('literal');
  });
});

describe('findMatchingValue', () => {
  it('returns the accepted surface form that hit', () => {
    const matched = findMatchingValue(
      'dilution',
      ['1:64', '2 oz/gal'],
      'Mix at two ounces... actually 2 oz per gallon of water.',
    );
    // Both forms are numerically equal to the text, so the first accepted value is reported.
    expect(matched).toBe('1:64');
  });

  it('returns null when nothing in the text parses to the kind', () => {
    expect(findMatchingValue('din', ['02245678'], 'No Canadian registration on this label')).toBeNull();
  });
});
