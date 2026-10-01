import { describe, expect, it } from 'vitest';

import {
  evaluateSdsContentLanguage,
  evaluateSdsPolicy,
  matchSdsFilenameLanguageSuffix,
} from './policy';

describe('evaluateSdsPolicy', () => {
  it('includes an ordinary EN Betco SDS file', () => {
    const decision = evaluateSdsPolicy('betco sds/chemtrec sds files ready to transfer/fml241.pdf', 'EN');
    expect(decision.inScope).toBe(true);
  });

  it('includes a CAN-tagged Betco SDS file', () => {
    const decision = evaluateSdsPolicy('betco sds/some folder/090-can.pdf', 'CAN');
    expect(decision.inScope).toBe(true);
  });

  it('excludes files outside the Betco SDS/ prefix entirely', () => {
    const decision = evaluateSdsPolicy('1950 sds/2907 sp (velocity marine rv wash).pdf', 'EN');
    expect(decision).toEqual({ inScope: false, reason: 'not_in_include_prefix', matched: expect.any(String) });
  });

  it('excludes Raw Materials, Private label, Basic, Prop 65, EnviroZyme, Battery, 1950 by folder keyword', () => {
    const cases = [
      'raw materials sds/some file.pdf',
      'private label sds/some file.pdf',
      'basic sds/b0657.pdf',
      'prop 65/110.pdf',
      'envirozyme sds/biowish/sds_aqua fog 1199-03-en.pdf',
      'battery sds/rbattcc_alkaline battery mercury free_rayovac.pdf',
      '1950 sds/2607 (multipurpose enzyme cleaner).pdf',
    ];
    for (const path of cases) {
      expect(evaluateSdsPolicy(path, 'EN').inScope).toBe(false);
    }
  });

  it('excludes intermediate/premix and wastewater/experimental by keyword', () => {
    expect(evaluateSdsPolicy('betco sds/intermediate premix/some.pdf', 'EN').inScope).toBe(false);
    expect(evaluateSdsPolicy('betco sds/wastewater program/some.pdf', 'EN').inScope).toBe(false);
    expect(evaluateSdsPolicy('betco sds/experimental formulas/some.pdf', 'EN').inScope).toBe(false);
  });

  it('excludes ES/FR by recorded locale even under the Betco SDS/ prefix', () => {
    expect(evaluateSdsPolicy('betco sds/chemtrec sds files ready to transfer/fml241_fr.pdf', 'FR').inScope).toBe(
      false,
    );
    expect(evaluateSdsPolicy('betco sds/some folder/151 mx.pdf', 'ES').inScope).toBe(false);
  });

  it('excludes real folder-named ES/FR paths confirmed live (folder marker, not just suffix)', () => {
    const cases = [
      'betco sds/diluted product sds/diluted spanish sds/138 dilsp.pdf',
      'betco sds/betco mexican form sds sp/151 mx.pdf',
      'betco sds/diluted product sds/diluted french canadian sds/138 dilfr.pdf',
      'betco sds/betco french canadian sds/archive/632 fr archive.pdf',
      'betco sds/betco spanish sds/346 sp just for allegheny.pdf',
    ];
    for (const path of cases) {
      // Locale metadata alone may say EN here (that's the known gap this ticket found) --
      // the folder-keyword check is the defense-in-depth layer that still excludes them.
      expect(evaluateSdsPolicy(path, 'EN').inScope).toBe(false);
    }
  });

  it('excludes FR/SP/MX/IT filename suffixes in folders no keyword can see (B0-794)', () => {
    // Every path here is a real live filename from the 364 documents B0-794 removed from
    // the retrievable corpus. None of their folders contains a language keyword.
    const cases = [
      'betco sds/archive sds/609fr.pdf',
      'betco sds/chemtrec sds files ready to transfer/5.20.24/065_fr.pdf',
      'betco sds/chemtrec sds files ready to transfer/betco ccn2664 files as of 12-31-21/188 draw fr.pdf',
      'betco sds/chemtrec sds files ready to transfer/betco ccn2664 files as of 12-31-21/024sp.pdf',
      'betco sds/chemtrec sds files ready to transfer/betco ccn 2664 7-7-22 index/141sp.pdf',
      'betco sds/specials/sp796sp.pdf',
      'betco sds/chemtrec sds files ready to transfer/betco ccn2664 7-25-25/gts305eu_it.pdf',
      'betco sds/diluted product sds/fastdraw diluted sds/167 fd sp.pdf',
    ];
    for (const path of cases) {
      const decision = evaluateSdsPolicy(path, 'EN');
      expect(decision, path).toEqual({
        inScope: false,
        reason: 'language_filename_suffix',
        matched: expect.any(String),
      });
    }
  });

  it('sees through trailing "Archive" / "(2)" decorations after the suffix', () => {
    for (const path of [
      'betco sds/archive sds/781sp archive.pdf',
      'betco sds/archive sds/795sp (2).pdf',
      'betco sds/archive sds/114fr archive.pdf',
    ]) {
      expect(evaluateSdsPolicy(path, 'EN').inScope, path).toBe(false);
    }
  });

  it('does NOT treat "ES" as Spanish -- it is the Essendant private-label code (B0-794)', () => {
    // All 14 live `<code> ES.pdf` files are English by content and belong to
    // "Private label SDS/Essendant Co ES1040 (Boardwalk)/". Sweeping them up as Spanish
    // would exclude legitimate English safety sheets, so `es` is not a suffix token.
    expect(matchSdsFilenameLanguageSuffix('betco sds/248 es.pdf')).toBeNull();
    expect(matchSdsFilenameLanguageSuffix('betco sds/5000 es.pdf')).toBeNull();
    expect(evaluateSdsPolicy('betco sds/248 es.pdf', 'EN').inScope).toBe(true);
  });

  it('does not sweep up English codes that merely END in the suffix letters', () => {
    // The token must be preceded by a digit, space, underscore or hyphen -- never another
    // letter. Nine real English filenames end in "Kit"; none may match the `it` token.
    const englishKits = [
      'betco sds/f02857 fastpak kit.pdf',
      'betco sds/f091874 water hardness test kit.pdf',
      'betco sds/f092535 fastpak mobile dilution control kit.pdf',
    ];
    for (const path of englishKits) {
      expect(matchSdsFilenameLanguageSuffix(path), path).toBeNull();
      expect(evaluateSdsPolicy(path, 'EN').inScope, path).toBe(true);
    }
    // Ordinary English Betco sheets are untouched.
    for (const path of ['betco sds/528.pdf', 'betco sds/2102.pdf', 'betco sds/035.pdf']) {
      expect(evaluateSdsPolicy(path, 'EN').inScope, path).toBe(true);
    }
    // A leading "SP" (the Specials prefix) is not a language marker on its own.
    expect(matchSdsFilenameLanguageSuffix('betco sds/specials/sp58864.pdf')).toBeNull();
  });

  it('reports which suffix matched, so a decision can be audited', () => {
    expect(matchSdsFilenameLanguageSuffix('betco sds/archive sds/609fr.pdf')).toBe('fr');
    expect(matchSdsFilenameLanguageSuffix('betco sds/archive sds/024sp.pdf')).toBe('sp');
    expect(matchSdsFilenameLanguageSuffix('betco sds/x/gts305eu_it.pdf')).toBe('it');
  });

  it('is env-configurable without code changes', () => {
    const originalPrefixes = process.env.SDS_POLICY_INCLUDE_PREFIXES;
    const originalKeywords = process.env.SDS_POLICY_EXCLUDE_KEYWORDS;
    try {
      process.env.SDS_POLICY_INCLUDE_PREFIXES = 'private label sds/';
      process.env.SDS_POLICY_EXCLUDE_KEYWORDS = 'archive';
      expect(evaluateSdsPolicy('private label sds/some file.pdf', 'EN').inScope).toBe(true);
      expect(evaluateSdsPolicy('private label sds/archive/some file.pdf', 'EN').inScope).toBe(false);
      expect(evaluateSdsPolicy('betco sds/some file.pdf', 'EN').inScope).toBe(false);
    } finally {
      if (originalPrefixes === undefined) delete process.env.SDS_POLICY_INCLUDE_PREFIXES;
      else process.env.SDS_POLICY_INCLUDE_PREFIXES = originalPrefixes;
      if (originalKeywords === undefined) delete process.env.SDS_POLICY_EXCLUDE_KEYWORDS;
      else process.env.SDS_POLICY_EXCLUDE_KEYWORDS = originalKeywords;
    }
  });
});

describe('evaluateSdsContentLanguage', () => {
  const englishSds =
    'Safety Data Sheet. Section 1: Identification of the substance and the company. ' +
    'This product is a heavy duty industrial cleaner intended for commercial use. ' +
    'Hazard statements and first aid measures are described in the sections below.';
  const frenchSds =
    "Fiche de données de sécurité. Section 1 : identification de la substance et de la société. " +
    "Ce produit est un nettoyant industriel destiné à un usage commercial. " +
    "Les mentions de danger et les premiers secours sont décrits dans les sections ci-dessous.";
  const spanishSds =
    'Hoja de datos de seguridad. Sección 1: identificación de la sustancia y de la empresa. ' +
    'Este producto es un limpiador industrial destinado para uso comercial. ' +
    'Las indicaciones de peligro y los primeros auxilios se describen en las secciones siguientes.';

  it('flags a mismatch when content is French but expected locale is EN (the confirmed false-negative case)', () => {
    const result = evaluateSdsContentLanguage(frenchSds, 'EN');
    expect(result.detectedLocale).toBe('FR');
    expect(result.mismatch).toBe(true);
  });

  it('flags a mismatch when content is Spanish but expected locale is EN', () => {
    const result = evaluateSdsContentLanguage(spanishSds, 'EN');
    expect(result.detectedLocale).toBe('ES');
    expect(result.mismatch).toBe(true);
  });

  it('does not flag a mismatch when content and expected locale agree', () => {
    const result = evaluateSdsContentLanguage(englishSds, 'EN');
    expect(result.detectedLocale).toBe('EN');
    expect(result.mismatch).toBe(false);
  });

  it('does not flag CAN-expected English content as a mismatch', () => {
    const result = evaluateSdsContentLanguage(englishSds, 'CAN');
    expect(result.detectedLocale).toBe('EN');
    expect(result.mismatch).toBe(false);
  });

  it('flags French content even when the expected locale is CAN (all-FR exclusion is deliberate per policy)', () => {
    const result = evaluateSdsContentLanguage(frenchSds, 'CAN');
    expect(result.detectedLocale).toBe('FR');
    expect(result.mismatch).toBe(true);
  });

  it('treats too-short/garbled text as inconclusive rather than a guessed mismatch', () => {
    const result = evaluateSdsContentLanguage('xx', 'EN');
    expect(result.francCode).toBe('und');
    expect(result.detectedLocale).toBeNull();
    expect(result.mismatch).toBe(false);
  });
});
