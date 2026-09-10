import { describe, expect, it } from 'vitest';

import {
  buildRegulatedClaimDeclineCopy,
  buildRegulatedClaimSentenceRedactionFooter,
  buildRegulatedClaimTokenRedactionFooter,
  REGULATED_CLAIM_CONSULT_LINE,
  REGULATED_CLAIM_GOVERNING_RULES,
  regulatedClaimWithheldMarker,
  stripRegulatedClaimRedactionArtifacts,
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
