import { describe, expect, it } from 'vitest';
import {
  extractDilutionFromLabel,
  extractDirectionsSection,
  extractRtuStatement,
  findDilutionMentions,
} from '~/lib/label/extract-dilution-from-label';

/** Wraps directions text in the label markdown shape produced by label ingestion. */
function label(directions: string, extra = ''): string {
  return [
    '',
    '# Some Betco Product',
    '',
    'Betco product. Label content transcribed from the product master label.',
    '',
    '## Directions for Use   <!-- section_type: directions -->',
    directions,
    '',
    extra,
  ].join('\n');
}

describe('extractDirectionsSection', () => {
  it('pulls the section flagged with the directions section_type marker', () => {
    const section = extractDirectionsSection(
      label('DIRECTIONS FOR USE: Dilute 2 oz. per gallon of water.', '## Hazards   <!-- section_type: hazards -->\nDANGER'),
    );
    expect(section).toContain('Dilute 2 oz. per gallon');
    expect(section).not.toContain('DANGER');
  });

  it('reads the plain "Directions for use:" block of a product_line_profile document', () => {
    const profile = [
      'Product line: SCORCH PLUS 1021',
      'Summary: Non-selective vegetation killer',
      'Description: This product may be diluted 1:10 (13 ounces per gallon) with water.',
      '',
      'Directions for use:',
      '- Apply 4 oz. per gallon of water to affected area.',
      '',
      'Technical specifications:',
      '- Color: Brown',
    ].join('\n');
    const section = extractDirectionsSection(profile);
    expect(section).toContain('4 oz. per gallon');
    // Marketing Description prose is NOT a directions statement and must stay out of the section.
    expect(section).not.toContain('13 ounces per gallon');
    expect(section).not.toContain('Color: Brown');
  });

  it('returns null when the label has no directions section', () => {
    expect(extractDirectionsSection('## Hazards   <!-- section_type: hazards -->\nDANGER')).toBeNull();
    expect(extractDirectionsSection(null)).toBeNull();
    expect(extractDirectionsSection('')).toBeNull();
  });
});

describe('findDilutionMentions', () => {
  it('reads a printed range as a range, not as two single values', () => {
    const mentions = findDilutionMentions('Dilute 4 - 8 ounces per gallon of water.');
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.kind).toBe('range');
    expect(mentions[0]!.raw).toBe('4 - 8 ounces per gallon');
  });

  it('parses printed fractions without rounding', () => {
    const mentions = findDilutionMentions('Use 1/2 ounce per gallon.');
    expect(mentions[0]!.kind).toBe('oz_per_gal');
    expect(mentions[0]!.value).toBe(0.5);
    expect(mentions[0]!.raw).toBe('1/2 ounce per gallon');
  });

  it('captures 1:N ratios and mL/L metric mentions distinctly', () => {
    const mentions = findDilutionMentions('Diluer 1:256 — 15 mL/4 L d’eau.');
    expect(mentions.map((m) => m.kind).sort()).toEqual(['metric', 'ratio']);
  });
});

describe('extractDilutionFromLabel — extraction', () => {
  it('uses the printed oz/gal figure verbatim', () => {
    const result = extractDilutionFromLabel(
      label('DIRECTIONS FOR USE: Dilute 2 oz./gal. of water and apply to surface.'),
    );
    expect(result).toEqual({
      status: 'extracted',
      ozPerGal: 2,
      display: '2 oz./gal.',
      mention: expect.objectContaining({ kind: 'oz_per_gal' }),
    });
  });

  it('derives 128/N for a printed 1:N ratio and keeps the ratio verbatim in display', () => {
    const result = extractDilutionFromLabel(label('DIRECTIONS FOR USE: Dilute at 1:256 with water.'));
    expect(result).toMatchObject({ status: 'extracted', ozPerGal: 0.5, display: '1:256' });
  });

  it('prefers the printed oz figure over the computed one when both appear', () => {
    const result = extractDilutionFromLabel(
      label('DIRECTIONS FOR USE: Dilute 1:256 (1/2 ounce per gallon) of water.'),
    );
    expect(result).toMatchObject({ status: 'extracted', ozPerGal: 0.5, display: '1/2 ounce per gallon' });
  });

  it('reads the English window rather than the metric-first French panel above it', () => {
    const result = extractDilutionFromLabel(
      label('Diluer 15 mL par 4 L d’eau.\nDIRECTIONS FOR USE: Dilute 4 oz. per gallon of water.'),
    );
    expect(result).toMatchObject({ status: 'extracted', ozPerGal: 4, display: '4 oz. per gallon' });
  });
});

describe('extractRtuStatement', () => {
  it('returns the verbatim RTU statement when the document prints no dilution figure at all', () => {
    expect(
      extractRtuStatement(label('DIRECTIONS FOR USE: Product is ready to use. DO NOT DILUTE. Apply undiluted.')),
    ).toEqual({ rtu: true, statement: 'DO NOT DILUTE' });
  });

  it('reads a `Dilution: RTU` spec line', () => {
    expect(extractRtuStatement('Technical specifications:\n- Color: COLORLESS\n- Dilution: RTU\n- pH: 7-8')).toEqual({
      rtu: true,
      statement: 'Dilution: RTU',
    });
  });

  it('refuses the RTU reading when a dilution figure appears anywhere in the document', () => {
    // The B0-265 trap: an RTU-titled product that still prints a real trigger-sprayer dilution.
    expect(
      extractRtuStatement(
        label(
          'DIRECTIONS FOR USE: Product is ready to use. TRIGGER SPRAYERS: Dilute 13 oz./gal. with water.',
        ),
      ),
    ).toBeNull();
  });

  it('refuses the RTU reading when a word-form ratio appears', () => {
    expect(
      extractRtuStatement(label('DIRECTIONS FOR USE: DO NOT DILUTE for heavy soil; dilute with equal parts of water otherwise.')),
    ).toBeNull();
  });

  it('returns null with no explicit RTU statement', () => {
    expect(extractRtuStatement(label('DIRECTIONS FOR USE: Spray and wipe.'))).toBeNull();
    expect(extractRtuStatement(null)).toBeNull();
  });
});

describe('extractDilutionFromLabel — skip rules', () => {
  it('skips when there is no directions section at all', () => {
    expect(extractDilutionFromLabel('## Hazards   <!-- section_type: hazards -->\nDANGER')).toEqual({
      status: 'skipped',
      reason: 'no_directions_section',
    });
  });

  it('skips ready-to-use / DO NOT DILUTE labels', () => {
    expect(
      extractDilutionFromLabel(label('DIRECTIONS FOR USE: DO NOT DILUTE. Spray and wipe dry.')),
    ).toEqual({ status: 'skipped', reason: 'ready_to_use' });
  });

  it('skips when the directions carry no dilution language', () => {
    expect(
      extractDilutionFromLabel(label('DIRECTIONS FOR USE: Sweep large debris and dust mop the floor.')),
    ).toEqual({ status: 'skipped', reason: 'no_dilution_language' });
  });

  it('skips disagreeing use-modes', () => {
    const result = extractDilutionFromLabel(
      label(
        'DIRECTIONS FOR USE: TRIGGER SPRAYERS: Dilute 6 oz./gal. of water. MOP BUCKET: Dilute 2 oz./gal. of water.',
      ),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'conflicting_use_modes', detail: '6 vs 2' });
  });

  it('skips a printed multi-tier range with no default marked', () => {
    const result = extractDilutionFromLabel(
      label('DIRECTIONS FOR USE: HARD SURFACES: Dilute 4 - 8 ounces per gallon of water.'),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'multi_tier_range' });
  });

  it("skips a ratio that belongs to a different named product in a prep step", () => {
    const result = extractDilutionFromLabel(
      label('DIRECTIONS FOR USE: Mix Squeaky Cleaner at 32 oz./gal. of water, then apply this finish.'),
      { productTitle: 'Clear Waterbased Sport Floor Finish' },
    );
    expect(result).toEqual({ status: 'skipped', reason: 'other_product_ratio' });
  });

  it('does not treat the label talking about itself as another product', () => {
    const result = extractDilutionFromLabel(
      label('DIRECTIONS FOR USE: Mix Squeaky Cleaner at 32 oz./gal. of water and mop.'),
      { productTitle: 'Squeaky Cleaner' },
    );
    expect(result).toMatchObject({ status: 'extracted', ozPerGal: 32 });
  });

  it('skips metric-only Canadian labels rather than converting', () => {
    const result = extractDilutionFromLabel(
      label('DIRECTIONS FOR USE: Diluer 15 mL/4 L d’eau. Aucune conversion.'),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'metric_only', detail: '15 mL/4 L' });
  });

  it('still skips a metric-only label when a 1:N appears in a claim-support statement', () => {
    // Verbatim shape from the Neutral Disinfectant Cleaner (Canada Only) profile: the printed use
    // dose is metric, and the 1:64 belongs to the HIV-1 contact-time claim, not the directions.
    const result = extractDilutionFromLabel(
      label(
        'DIRECTIONS FOR USE: Use 16 mL per litre of water for a minimum contact time of 10 minutes. ' +
          'Contact Time: Effective against HIV-1 when used at a 1:64 dilution (providing 600 ppm of active quaternary).',
      ),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'metric_only' });
  });

  it('skips a range whose unit is separated from "per gallon" by other words', () => {
    // Verbatim shape from the Lemon deodorant profile — the trap that produced a wrong 5 oz/gal.
    const result = extractDilutionFromLabel(
      label(
        'DIRECTIONS FOR USE: Add 5 oz. per gallon of water to disinfect. To Clean and Deodorize: use 12 - 16 oz. of this product per gallon of water.',
      ),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'multi_tier_range' });
  });

  it('skips a ratio belonging to a lowercase, OCR-mangled other-product reference', () => {
    // Verbatim shape from the HYDROLINE SEALER / STREETSHOE profiles.
    const result = extractDilutionFromLabel(
      label(
        'DIRECTIONS FOR USE: FOR SCREENING AND RECOATING: Always clean the finish prior to screening. Mix wood finish maintenance cleaner at 32 oz./gal. with water and tack using a clean towel.',
      ),
      { productTitle: 'STREETSHOE 275' },
    );
    expect(result).toEqual({ status: 'skipped', reason: 'other_product_ratio' });
  });

  it('skips a ratio attached to an explicitly Betco-branded other product', () => {
    // Verbatim shape from the Concrete Maintenance Stain & Etch Remover Kit profile.
    const result = extractDilutionFromLabel(
      label(
        'Directions for use:\n- Saturate stained area with wet mop and Betco Densiclean at 0.5 oz. per gallon (1:256). Apply Betco LiquiGrind to fully cover stain.',
      ),
      { productTitle: 'Concrete Maintenance Stain & Etch Remover Kit' },
    );
    expect(result).toEqual({ status: 'skipped', reason: 'other_product_ratio' });
  });

  it('skips capacity/weight dosing instead of reading it as a water dilution', () => {
    const result = extractDilutionFromLabel(
      label(
        'DIRECTIONS FOR USE: GREASE TRAPS: For less than 20 cubic feet capacity, add 4 oz. per gallon daily by pouring into a sink.',
      ),
    );
    expect(result).toEqual({ status: 'skipped', reason: 'capacity_dosing' });
  });

  it('skips an unreadable printed value rather than guessing', () => {
    const result = extractDilutionFromLabel(
      label('DIRECTIONS FOR USE: Dilute ½ oz/gal of water.'),
    );
    // The garbled fraction glyph leaves no parseable number, so nothing is written.
    expect(result).toMatchObject({ status: 'skipped' });
    expect(['no_dilution_language', 'unreadable_value']).toContain(
      (result as { reason: string }).reason,
    );
  });

  it('skips a 1:0 ratio as unreadable rather than dividing by zero', () => {
    const result = extractDilutionFromLabel(label('DIRECTIONS FOR USE: Dilute at 1:0 with water.'));
    expect(result).toMatchObject({ status: 'skipped', reason: 'unreadable_value' });
  });

  it('skips a dose stated per multiple gallons rather than dividing it down', () => {
    // Verbatim shape from the SYM Low Temp Machine Sanitizer label.
    const result = extractDilutionFromLabel(
      label(
        'DIRECTIONS FOR USE: SANITATION OF NONPOROUS FOOD CONTACT SURFACES: prepare by thoroughly mixing 3 fl. oz. of this product per 10 gallons of water.',
      ),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'non_per_gallon_dose' });
  });

  it('skips "1 or 2 ounces per gallon" as two printed alternatives, not 2 oz/gal', () => {
    // Verbatim shape from the Flatware Presoak label — the bug this rule exists to prevent.
    const result = extractDilutionFromLabel(
      label(
        'DIRECTIONS FOR USE: 1. For detarnishing silverware, use 1 or 2 ounces per gallon of warm water.',
      ),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'multi_tier_range', detail: '1 or 2 ounces per gallon' });
  });

  it('skips a printed ceiling ("up to X per gallon of finish") as not a water dilution', () => {
    // Verbatim shape from the Basic Coatings Dry Time Extender label — an additive dose into finish.
    const result = extractDilutionFromLabel(
      label(
        'DIRECTIONS FOR USE: Up to 12 ounces of Dry Time Extender can be added per gallon of Basic Coatings water based finish. A gallon of finish will not allow for more than 12 ounces per gallon.',
      ),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'not_a_water_dilution' });
  });

  it('skips a ratio written in words rather than inferring oz/gal from it', () => {
    // Verbatim shape from the Oven Jell label.
    const result = extractDilutionFromLabel(
      label('DIRECTIONS FOR USE: FOR LIGHT DEPOSITS AND REGULAR CLEANING: Dilute with equal parts of water.'),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'word_form_ratio' });
  });

  it('skips a mode-specific dilution when the other printed use-modes are direct application', () => {
    // Verbatim shape from the Ready-To-Use Multi-Purpose Cleaner profile: RTU for showers, floors
    // and carpets, 2 oz./gallon for glass/mirror only. Promoting 2 oz/gal to the line would tell a
    // customer to dilute a product its own label says to apply neat.
    const result = extractDilutionFromLabel(
      label(
        'Directions for use:\n- SHOWERS: Spray on tile, grout, fixtures. Let stand 5 minutes and rinse. ' +
          'FLOORS: Add directly to grout scrubber. ' +
          'GLASS/MIRROR CLEANER: Dilute 2 oz./gallon. Spray onto surface and wipe. ' +
          'CARPETS: Apply a small amount of liquid to the stain.',
      ),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'single_mode_of_many' });
  });

  it('does not skip when every printed use-mode agrees on the same figure', () => {
    const result = extractDilutionFromLabel(
      label(
        'DIRECTIONS FOR USE: TRIGGER SPRAYERS: Dilute 13 oz./gal. with water. MOP BUCKETS: Dilute 13 oz./gal. with water.',
      ),
    );
    expect(result).toMatchObject({ status: 'extracted', ozPerGal: 13 });
  });

  it('skips conflicting ratios', () => {
    const result = extractDilutionFromLabel(
      label('DIRECTIONS FOR USE: For cleaning dilute 1:64. For disinfection dilute 1:256.'),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'conflicting_use_modes' });
  });
});
