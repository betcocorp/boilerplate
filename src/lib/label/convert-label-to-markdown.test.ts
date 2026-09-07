import { describe, expect, it } from 'vitest';

import {
  convertLabelToMarkdown,
  stripTrademarkSymbols,
} from '~/lib/label/convert-label-to-markdown';

/**
 * B0-876 — trademark marks must be STRIPPED from an emitted title, never mapped to a letter. The
 * live corpus carries "Fight BacT RTU" / "GREEN EARTHr" artefacts from an upstream source; this
 * converter must not be a second producer of them.
 */
describe('stripTrademarkSymbols (B0-876)', () => {
  it('removes ™ (U+2122), ® (U+00AE) and ℠ (U+2120) without leaving a letter behind', () => {
    expect(stripTrademarkSymbols('GE Fight Bac™ RTU')).toBe('GE Fight Bac RTU');
    expect(stripTrademarkSymbols('Green Earth® Daily Disinfectant')).toBe(
      'Green Earth Daily Disinfectant',
    );
    expect(stripTrademarkSymbols('Defender℠ Linoleum System')).toBe('Defender Linoleum System');
    expect(stripTrademarkSymbols('Fight Bac(TM) RTU')).toBe('Fight Bac RTU');
  });

  it('never produces the transliteration artefact', () => {
    expect(stripTrademarkSymbols('Fight Bac™ RTU')).not.toMatch(/BacT/);
    expect(stripTrademarkSymbols('GREEN EARTH® ALL PURPOSE')).not.toMatch(/EARTHr/);
  });

  it('leaves a title with no marks byte-identical', () => {
    expect(stripTrademarkSymbols('pH7Q Dual Neutral Disinfectant Cleaner')).toBe(
      'pH7Q Dual Neutral Disinfectant Cleaner',
    );
  });
});

describe('convertLabelToMarkdown title emission (B0-876)', () => {
  it('emits the H1 and metadata title with the marks stripped, regulated values untouched', () => {
    const out = convertLabelToMarkdown('DIRECTIONS FOR USE: apply undiluted.', {
      productTitle: 'GE Fight Bac™ RTU',
      epaRegNo: '34810-25-4170',
    });
    expect(out.markdown.startsWith('# GE Fight Bac RTU\n')).toBe(true);
    expect(out.metadata.productTitle).toBe('GE Fight Bac RTU');
    // The registration number is transcribed exactly as supplied.
    expect(out.markdown).toContain('- **EPA Registration:** 34810-25-4170');
  });

  it('omits the title block entirely when no title is supplied', () => {
    const out = convertLabelToMarkdown('HAZARDS: none listed.');
    expect(out.markdown).not.toMatch(/^# /m);
    expect(out.metadata.productTitle).toBeUndefined();
  });
});
