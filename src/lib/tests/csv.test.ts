import { describe, expect, it } from 'vitest';

import {
  decodeCsvBytes,
  formatExpectedCriteriaCell,
  parseExpectedCriteriaCell,
  parseShouldCiteFromForm,
  parseTestCsvContent,
} from './csv';
import { TEST_TEMPLATE_COLUMNS, buildTestTemplateCsv } from './template';

/**
 * B0-833 — regression test for the import-encoding bug: uploaded CSVs are frequently
 * Windows-1252 (Excel's Windows "CSV" export), not UTF-8. Decoding a Windows-1252 en dash
 * (0x96) or degree sign (0xB0) as strict UTF-8 previously used a non-fatal `TextDecoder('utf-8')`
 * that silently swapped every such byte for U+FFFD — the exact corruption found in
 * `test_items.expected_concepts` / `minimum_concepts` (111 phrases across 47 items, 9 tests).
 * `decodeCsvBytes` must recover the real character via a Windows-1252 fallback, and this fixture
 * must never produce U+FFFD.
 */
describe('decodeCsvBytes — B0-833 Windows-1252 import fallback', () => {
  it('decodes a Windows-1252 CSV (en dash + degree sign) without introducing U+FFFD', () => {
    // Windows-1252 bytes for: "20–45 min" (en dash, 0x96) and "60–80°F" (en dash +
    // degree sign, 0xB0) — both invalid as standalone UTF-8, which is exactly what triggers the
    // silent-replacement bug in a plain `TextDecoder('utf-8')`.
    const header = Buffer.from('question,minimum_concepts\n', 'ascii');
    const row = Buffer.concat([
      Buffer.from('"Cure time?","', 'ascii'),
      Buffer.from('20', 'ascii'),
      Buffer.from([0x96]), // Windows-1252 en dash –
      Buffer.from('45 min at ', 'ascii'),
      Buffer.from([0x96]), // Windows-1252 en dash – again, inside the same cell
      Buffer.from('60', 'ascii'),
      Buffer.from([0xb0]), // Windows-1252 degree sign °
      Buffer.from('F"\n', 'ascii'),
    ]);
    const bytes = new Uint8Array(Buffer.concat([header, row]));

    const decoded = decodeCsvBytes(bytes);

    expect(decoded).not.toContain('�');
    expect(decoded).toContain('20–45 min at –60°F');

    const [parsedRow] = parseTestCsvContent(decoded);
    expect(parsedRow.minimumConcepts).not.toContain('�');
    expect(parsedRow.minimumConcepts).toBe('20–45 min at –60°F');
  });

  it('leaves a genuine UTF-8 file (including one with a BOM) unaffected', () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), // UTF-8 BOM
      Buffer.from('question,minimum_concepts\n"Cure time?","20–45 min"\n', 'utf-8'),
    ]);

    const decoded = decodeCsvBytes(new Uint8Array(withBom));

    expect(decoded).not.toContain('�');
    const [parsedRow] = parseTestCsvContent(decoded);
    expect(parsedRow.minimumConcepts).toBe('20–45 min');
  });
});

describe('parseTestCsvContent — golden test set format', () => {
  it('reads the concept, source, and citation columns into typed fields', () => {
    const csv = [
      'question,canonical_product,reason_code,priority,ideal_response,product_mention,question_category,source_style,expected_concepts,minimum_concepts,expected_sources,should_cite',
      '"How much pH7Q per gallon?",pH7Q Neutral Disinfectant,dilution,1,"Use 2 oz per gallon.",pH7Q,dilution,real_user_pattern,"2 oz/gal or 15 mL/L; 1:64","2 oz/gal","pH7Q TDS, Selector Guide Section 1",yes',
    ].join('\n');

    const [row] = parseTestCsvContent(csv);

    expect(row.expectedConcepts).toBe('2 oz/gal or 15 mL/L; 1:64');
    expect(row.minimumConcepts).toBe('2 oz/gal');
    expect(row.expectedSources).toBe('pH7Q TDS, Selector Guide Section 1');
    expect(row.shouldCite).toBe(true);
    // Typed columns must not leak into the metadata catch-all.
    expect(row.metadata).not.toHaveProperty('expected_concepts');
    expect(row.metadata).not.toHaveProperty('should_cite');
    expect(row.inputPayload).toEqual({
      product_mention: 'pH7Q',
      question_category: 'dilution',
      source_style: 'real_user_pattern',
    });
  });

  it('reads expected_tool into a typed field, not the metadata catch-all', () => {
    const csv = [
      'question,expected_tool',
      '"What is the dilution for pH7Q?",get_efficacy_data',
    ].join('\n');

    const [row] = parseTestCsvContent(csv);

    expect(row.expectedTool).toBe('get_efficacy_data');
    expect(row.metadata).not.toHaveProperty('expected_tool');
  });

  it('reads the B0-790 signal ground-truth columns into typed fields, not the metadata catch-all', () => {
    const csv = [
      'question,expected_surface_type,expected_brand_family,expected_setting',
      '"What is pH7Q used on?",tile,betco,commercial',
    ].join('\n');

    const [row] = parseTestCsvContent(csv);

    expect(row.expectedSurfaceType).toBe('tile');
    expect(row.expectedBrandFamily).toBe('betco');
    expect(row.expectedSetting).toBe('commercial');
    expect(row.metadata).not.toHaveProperty('expected_surface_type');
    expect(row.metadata).not.toHaveProperty('expected_brand_family');
    expect(row.metadata).not.toHaveProperty('expected_setting');
  });

  it('treats blank or unrecognized should_cite as no expectation', () => {
    const csv = [
      'question,should_cite',
      'Row with blank cite,',
      'Row with junk cite,maybe',
      'Row that should not cite,no',
    ].join('\n');

    expect(parseTestCsvContent(csv).map((row) => row.shouldCite)).toEqual([
      null,
      null,
      false,
    ]);
  });

  it('leaves the new fields null for legacy CSVs without those columns', () => {
    const csv = [
      'question,should_answer,expected_result_type',
      'Legacy row,yes,answer',
    ].join('\n');

    const [row] = parseTestCsvContent(csv);

    expect(row.expectedConcepts).toBeNull();
    expect(row.minimumConcepts).toBeNull();
    expect(row.expectedSources).toBeNull();
    expect(row.shouldCite).toBeNull();
  });

  it('B0-799 — drops the retired should_answer / expected_result_type columns without leaking them into metadata', () => {
    const csv = [
      'question,should_answer,expected_result_type,canonical_product,legacy_note',
      '"How much pH7Q per gallon?",yes,answer,pH7Q Neutral Disinfectant,keep me',
    ].join('\n');

    const [row] = parseTestCsvContent(csv);

    expect(row.prompt).toBe('How much pH7Q per gallon?');
    expect(row.expectedCanonicalProduct).toBe('pH7Q Neutral Disinfectant');
    // The retired columns are dropped: no typed field exists for them any more, and the metadata
    // catch-all (B0-694 anti-pattern) must not carry them either.
    expect(row.metadata).not.toHaveProperty('should_answer');
    expect(row.metadata).not.toHaveProperty('expected_result_type');
    // Genuinely unknown columns still land in metadata as before.
    expect(row.metadata).toEqual({ legacy_note: 'keep me' });
  });

  it('parses the downloadable template so the template round-trips through import', () => {
    const [row] = parseTestCsvContent(buildTestTemplateCsv());

    expect(TEST_TEMPLATE_COLUMNS.map((column) => column.name)).toEqual([
      'question',
      'canonical_product',
      'reason_code',
      'source',
      'priority',
      'ideal_response',
      'product_mention',
      'question_category',
      'source_style',
      'expected_concepts',
      'minimum_concepts',
      'expected_criteria',
      'expected_sources',
      'should_cite',
      'expected_tool',
      // B0-790 — ground-truth columns for the signals-accuracy harness.
      'expected_surface_type',
      'expected_brand_family',
      'expected_setting',
      // B0-537 — optional multi-turn scenario escape hatch.
      'multi_turn_json',
    ]);
    // The template's example row is prose, so only the prompt is expected to survive typed parsing.
    expect(row.prompt).toContain('Enter the prompt/question to test');
    expect(row.expectedConcepts).toContain('13 oz/gal');
  });
});

describe('parseShouldCiteFromForm', () => {
  it('maps the dialog presets and blanks', () => {
    expect(parseShouldCiteFromForm('yes')).toBe(true);
    expect(parseShouldCiteFromForm('No')).toBe(false);
    expect(parseShouldCiteFromForm('')).toBeNull();
    expect(parseShouldCiteFromForm('   ')).toBeNull();
  });
});

describe('parseExpectedCriteriaCell — B0-615 tiered mini-syntax', () => {
  it('parses tiered, exact, and semantic segments', () => {
    const criteria = parseExpectedCriteriaCell(
      't1: dilution 4 oz/gal; t1x: EPA Reg. No. 12345-67; t2: dwell time; t3: mentions PPE',
    );

    expect(criteria).toEqual([
      { concept: 'dilution 4 oz/gal', tier: 1, match: 'semantic' },
      { concept: 'EPA Reg. No. 12345-67', tier: 1, match: 'exact' },
      { concept: 'dwell time', tier: 2, match: 'semantic' },
      { concept: 'mentions PPE', tier: 3, match: 'semantic' },
    ]);
  });

  it('drops malformed segments instead of throwing', () => {
    expect(parseExpectedCriteriaCell('t1: fine; not a criterion; t4: bad tier; t2:')).toEqual([
      { concept: 'fine', tier: 1, match: 'semantic' },
    ]);
  });

  it('treats blank input as no criteria (legacy behavior-only grading)', () => {
    expect(parseExpectedCriteriaCell('')).toEqual([]);
    expect(parseExpectedCriteriaCell('   ')).toEqual([]);
  });

  it('round-trips through formatExpectedCriteriaCell', () => {
    const original = 't1: dilution 4 oz/gal; t1x: EPA Reg. No. 12345-67; t2: dwell time';
    expect(parseExpectedCriteriaCell(formatExpectedCriteriaCell(parseExpectedCriteriaCell(original)))).toEqual(
      parseExpectedCriteriaCell(original),
    );
  });

  it('parses expected_criteria out of a full CSV row', () => {
    const csv = [
      'question,expected_criteria',
      '"How much pH7Q per gallon?","t1: dilution 4 oz/gal; t2: dwell time"',
    ].join('\n');

    const [row] = parseTestCsvContent(csv);
    expect(row.expectedCriteria).toEqual([
      { concept: 'dilution 4 oz/gal', tier: 1, match: 'semantic' },
      { concept: 'dwell time', tier: 2, match: 'semantic' },
    ]);
  });
});
