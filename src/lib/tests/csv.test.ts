import { describe, expect, it } from 'vitest';

import {
  decodeCsvBytes,
  formatPhraseCell,
  isDocumentId,
  parseExpectedSourceIdsFromForm,
  parseExpectedSourcesCell,
  parsePhraseListFromForm,
  parseShouldCiteFromForm,
  parseTestCsvContent,
  splitPhraseCell,
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
    expect(parsedRow.minimumConcepts).toEqual(['20–45 min at –60°F']);
  });

  it('leaves a genuine UTF-8 file (including one with a BOM) unaffected', () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), // UTF-8 BOM
      Buffer.from('question,minimum_concepts\n"Cure time?","20–45 min"\n', 'utf-8'),
    ]);

    const decoded = decodeCsvBytes(new Uint8Array(withBom));

    expect(decoded).not.toContain('�');
    const [parsedRow] = parseTestCsvContent(decoded);
    expect(parsedRow.minimumConcepts).toEqual(['20–45 min']);
  });
});

describe('parseTestCsvContent — golden test set format', () => {
  it('reads the concept, source, and citation columns into typed array fields', () => {
    const csv = [
      'question,canonical_product,reason_code,priority,ideal_response,product_mention,question_category,source_style,expected_concepts,minimum_concepts,expected_sources,should_cite',
      '"How much pH7Q per gallon?",pH7Q Neutral Disinfectant,dilution,1,"Use 2 oz per gallon.",pH7Q,dilution,real_user_pattern,"2 oz/gal or 15 mL/L | 1:64","2 oz/gal","6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40, 3a91f2de-11c4-4c6f-9f2b-7d0e5a4c8b13",yes',
    ].join('\n');

    const [row] = parseTestCsvContent(csv);

    // Pipe-delimited phrases; each element verbatim, so "15 mL/L" is never converted or rounded.
    expect(row.expectedConcepts).toEqual(['2 oz/gal or 15 mL/L', '1:64']);
    expect(row.minimumConcepts).toEqual(['2 oz/gal']);
    expect(row.expectedSources).toEqual([
      '6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40',
      '3a91f2de-11c4-4c6f-9f2b-7d0e5a4c8b13',
    ]);
    expect(row.warnings).toEqual([]);
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

  it('leaves the array fields empty for legacy CSVs without those columns', () => {
    const csv = [
      'question,should_answer,expected_result_type',
      'Legacy row,yes,answer',
    ].join('\n');

    const [row] = parseTestCsvContent(csv);

    expect(row.expectedConcepts).toEqual([]);
    expect(row.minimumConcepts).toEqual([]);
    expect(row.expectedCriteria).toEqual([]);
    expect(row.expectedSources).toEqual([]);
    expect(row.shouldCite).toBeNull();
  });

  it('B0-931 — drops the retired expected_should_answer column without leaking it into metadata', () => {
    const csv = [
      'question,expected_should_answer,expected_result_type,should_answer,legacy_note',
      '"How much pH7Q per gallon?",yes,answer,yes,keep me',
    ].join('\n');

    const [row] = parseTestCsvContent(csv);

    expect(row.metadata).toEqual({ legacy_note: 'keep me' });
  });

  it('B0-931 — reports non-uuid expected_sources tokens as a row warning instead of storing them', () => {
    const csv = [
      'question,expected_sources',
      '"How much pH7Q per gallon?","6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40, pH7Q TDS"',
    ].join('\n');

    const [row] = parseTestCsvContent(csv);

    expect(row.expectedSources).toEqual(['6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40']);
    expect(row.warnings).toHaveLength(1);
    expect(row.warnings[0]).toContain('pH7Q TDS');
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
    // The example cell is pipe-delimited, so it splits into phrases like a real one.
    expect(row.expectedConcepts.some((phrase) => phrase.includes('13 oz/gal'))).toBe(true);
    // No retired column may appear in the downloadable template.
    const templateColumnNames = TEST_TEMPLATE_COLUMNS.map((column) => column.name);
    expect(templateColumnNames).not.toContain('should_answer');
    expect(templateColumnNames).not.toContain('expected_should_answer');
    expect(templateColumnNames).not.toContain('expected_result_type');
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

describe('splitPhraseCell — B0-931 phrase splitting (mirror of concept_rules.py split_concepts)', () => {
  it('splits on pipes as the primary delimiter, verbatim', () => {
    expect(splitPhraseCell('4 oz/gal | 10 minute contact time | EPA Reg. No. 1839-95')).toEqual([
      '4 oz/gal',
      '10 minute contact time',
      'EPA Reg. No. 1839-95',
    ]);
  });

  it('never splits on a comma', () => {
    expect(splitPhraseCell('dilute 2 oz/gal, then dwell')).toEqual(['dilute 2 oz/gal, then dwell']);
  });

  it('splits on semicolons only when nothing else delimited the cell', () => {
    expect(splitPhraseCell('a; b')).toEqual(['a', 'b']);
    expect(splitPhraseCell('a; b | c')).toEqual(['a; b', 'c']);
  });

  it('splits on newlines and strips list markers', () => {
    expect(splitPhraseCell('- 4 oz/gal\r\n* 1:32\n1. 100 ppm\no PPE required')).toEqual([
      '4 oz/gal',
      '1:32',
      '100 ppm',
      'PPE required',
    ]);
  });

  it('treats blank cells and empty-cell markers as no phrases', () => {
    for (const cell of ['', '   ', 'n/a', 'NA', 'none', '-', '—', null, undefined]) {
      expect(splitPhraseCell(cell)).toEqual([]);
    }
  });

  it('re-emits regulated values byte-for-byte', () => {
    const cell = '1:64 | 13 oz/gal or 100 mL/L | 600 ppm | 10 minutes | CAS 7681-52-9 | EPA Reg. No. 1839-95';
    expect(splitPhraseCell(cell)).toEqual([
      '1:64',
      '13 oz/gal or 100 mL/L',
      '600 ppm',
      '10 minutes',
      'CAS 7681-52-9',
      'EPA Reg. No. 1839-95',
    ]);
  });

  it('round-trips through formatPhraseCell', () => {
    const phrases = ['13 oz/gal or 100 mL/L', '10 minute contact time', 'EPA Reg. No. 1839-95'];
    expect(splitPhraseCell(formatPhraseCell(phrases))).toEqual(phrases);
  });

  it('parses expected_criteria as a plain phrase list out of a full CSV row', () => {
    const csv = [
      'question,expected_criteria',
      '"How much pH7Q per gallon?","names the dilution 4 oz/gal | states the dwell time"',
    ].join('\n');

    const [row] = parseTestCsvContent(csv);
    expect(row.expectedCriteria).toEqual([
      'names the dilution 4 oz/gal',
      'states the dwell time',
    ]);
  });
});

describe('expected_sources — B0-931 rag.document.id uuids', () => {
  it('accepts a comma- or pipe-separated uuid list', () => {
    const ids = ['6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40', '3A91F2DE-11C4-4C6F-9F2B-7D0E5A4C8B13'];
    expect(parseExpectedSourcesCell(ids.join(', ')).documentIds).toEqual(ids);
    expect(parseExpectedSourcesCell(ids.join(' | ')).documentIds).toEqual(ids);
  });

  it('separates non-uuid tokens instead of coercing or dropping them silently', () => {
    const parsed = parseExpectedSourcesCell(
      '6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40, Ax-It Plus TDS, Selector Guide Section 1',
    );
    expect(parsed.documentIds).toEqual(['6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40']);
    expect(parsed.invalidTokens).toEqual(['Ax-It Plus TDS', 'Selector Guide Section 1']);
  });

  it('treats a blank cell and empty-cell markers as no sources', () => {
    expect(parseExpectedSourcesCell('')).toEqual({ documentIds: [], invalidTokens: [] });
    expect(parseExpectedSourcesCell('n/a')).toEqual({ documentIds: [], invalidTokens: [] });
  });

  it('validates a single token with isDocumentId', () => {
    expect(isDocumentId('6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40')).toBe(true);
    expect(isDocumentId('pH7Q TDS')).toBe(false);
  });
});

describe('form field readers — B0-931 repeated inputs', () => {
  it('parsePhraseListFromForm trims, drops blanks, and keeps the rest verbatim', () => {
    expect(
      parsePhraseListFromForm(['  4 oz/gal ', '', '   ', '10 minute contact time']),
    ).toEqual(['4 oz/gal', '10 minute contact time']);
  });

  it('parseExpectedSourceIdsFromForm rejects non-uuid values', () => {
    const parsed = parseExpectedSourceIdsFromForm([
      '6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40',
      'not-a-uuid',
      '',
    ]);
    expect(parsed.documentIds).toEqual(['6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40']);
    expect(parsed.invalidTokens).toEqual(['not-a-uuid']);
  });
});
