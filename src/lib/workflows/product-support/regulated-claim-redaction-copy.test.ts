import { describe, expect, it } from 'vitest';

import {
  buildRegulatedClaimDeclineCopy,
  buildRegulatedClaimSentenceRedactionFooter,
  buildRegulatedClaimTokenRedactionFooter,
  mergeRepeatedRegulatedClaimWithheldMarkers,
  REGULATED_CLAIM_CONSULT_LINE,
  REGULATED_CLAIM_GOVERNING_RULES,
  regulatedClaimWithheldMarker,
  stripRegulatedClaimRedactionArtifacts,
  stripRegulatedClaimWithheldMarkers,
} from './regulated-claim-redaction-copy';

describe('regulated-claim redaction copy (B0-928)', () => {
  describe('stripRegulatedClaimRedactionArtifacts', () => {
    it('removes both footers, the inline token marker, and every withheld marker', () => {
      const text = [
        'GE Fight Bac RTU is ready-to-use, EPA Reg. 34810-35-4170.',
        'pH7Q Dual is a concentrate, EPA Reg. (unable to verify).',
        regulatedClaimWithheldMarker('compatibility'),
        '',
        buildRegulatedClaimTokenRedactionFooter('EPA registration number'),
      ].join('\n');

      const stripped = stripRegulatedClaimRedactionArtifacts(text);

      expect(stripped).not.toContain('(unable to verify)');
      expect(stripped).not.toContain('withheld');
      expect(stripped).not.toContain(REGULATED_CLAIM_CONSULT_LINE);
      expect(stripped).toContain('EPA Reg. 34810-35-4170');
    });

    it('handles the sentence-redaction footer too, and leaves untouched text alone', () => {
      const clean = 'Dilute at 1:256 (0.5 oz/gal) per the label. Source: pH7Q Dual product label.';
      expect(stripRegulatedClaimRedactionArtifacts(clean)).toBe(clean);

      const stripped = stripRegulatedClaimRedactionArtifacts(
        `${clean}\n\n${buildRegulatedClaimSentenceRedactionFooter('efficacy claim')}`,
      );
      expect(stripped.trim()).toBe(clean);
    });
  });

  describe('buildRegulatedClaimDeclineCopy', () => {
    it('inserts the governing rule for the single flagged category', () => {
      const copy = buildRegulatedClaimDeclineCopy({
        flagged: 'compatibility statement',
        categories: ['compatibility'],
      });

      expect(copy).toContain("I can't verify the compatibility statement in this answer");
      expect(copy).toContain(REGULATED_CLAIM_GOVERNING_RULES.compatibility);
      expect(copy.endsWith(REGULATED_CLAIM_CONSULT_LINE)).toBe(true);
    });

    it('bullets multiple rules and never repeats one', () => {
      const copy = buildRegulatedClaimDeclineCopy({
        flagged: 'dilution ratio, contact/dwell time',
        categories: ['dilution_ratio', 'contact_time', 'dilution_ratio'],
      });

      expect(copy).toContain(`- ${REGULATED_CLAIM_GOVERNING_RULES.dilution_ratio}`);
      expect(copy).toContain(`- ${REGULATED_CLAIM_GOVERNING_RULES.contact_time}`);
      expect(copy.split(REGULATED_CLAIM_GOVERNING_RULES.dilution_ratio)).toHaveLength(2);
    });

    it('states no product-specific value in any governing rule', () => {
      // The rules ship inside a REGULATED decline; a value in one would be an unverified claim.
      // The only digits allowed are the SDS section numbers and the Poison Control number, neither
      // of which is a product-specific value.
      for (const rule of Object.values(REGULATED_CLAIM_GOVERNING_RULES)) {
        const withoutAllowedDigits = rule
          .replace('(1-800-222-1222 in the US)', '')
          .replace(/Section \d+/g, 'Section');
        expect(withoutAllowedDigits).not.toMatch(/\d/);
        expect(rule).not.toMatch(/oz\/gal|ppm|1:\d|minutes?\b/i);
      }
    });
  });
});

/**
 * B0-971 — two withheld bullets in a row rendered the identical `[one efficacy claim withheld …]`
 * marker twice. Consecutive identical markers are merged into one pluralised marker, and the
 * grader's strip removes either form.
 */
describe('withheld markers (B0-971)', () => {
  it('merges a run of identical markers (with or without list bullets between) into one pluralised marker', () => {
    const one = regulatedClaimWithheldMarker('efficacy_claim');
    expect(mergeRepeatedRegulatedClaimWithheldMarkers(`Intro line.\n${one}\n${one}\nOutro.`)).toBe(
      `Intro line.\n[two efficacy claims withheld — not verifiable against a retrieved label]\nOutro.`,
    );
    expect(mergeRepeatedRegulatedClaimWithheldMarkers(`- ${one}\n- ${one}\n- ${one}`)).toBe(
      '- [three efficacy claims withheld — not verifiable against a retrieved label]',
    );
  });

  it('leaves markers of different categories, or separated by other text, untouched', () => {
    const efficacy = regulatedClaimWithheldMarker('efficacy_claim');
    const compat = regulatedClaimWithheldMarker('compatibility');
    const mixed = `${efficacy}\n${compat}`;
    expect(mergeRepeatedRegulatedClaimWithheldMarkers(mixed)).toBe(mixed);
    const separated = `${efficacy}\nSome grounded sentence.\n${efficacy}`;
    expect(mergeRepeatedRegulatedClaimWithheldMarkers(separated)).toBe(separated);
  });

  it('strips the pluralised marker exactly like the singular one', () => {
    const text = `Kept sentence. ${regulatedClaimWithheldMarker('efficacy_claim', 2)} Another kept sentence.`;
    expect(stripRegulatedClaimWithheldMarkers(text)).not.toContain('withheld');
    expect(stripRegulatedClaimRedactionArtifacts(text)).not.toContain('withheld');
    expect(stripRegulatedClaimRedactionArtifacts(text)).toContain('Kept sentence.');
  });
});
