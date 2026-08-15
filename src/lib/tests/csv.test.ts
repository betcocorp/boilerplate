import { describe, expect, it } from 'vitest';

import { parseShouldCiteFromForm, parseTestCsvContent } from './csv';
import { TEST_TEMPLATE_COLUMNS, buildTestTemplateCsv } from './template';

describe('parseTestCsvContent — golden test set format', () => {
  it('reads the concept, source, and citation columns into typed fields', () => {
    const csv = [
      'question,should_answer,expected_result_type,canonical_product,reason_code,priority,ideal_response,product_mention,question_category,source_style,expected_concepts,minimum_concepts,expected_sources,should_cite',
      '"How much pH7Q per gallon?",yes,answer,pH7Q Neutral Disinfectant,dilution,1,"Use 2 oz per gallon.",pH7Q,dilution,real_user_pattern,"2 oz/gal or 15 mL/L; 1:64","2 oz/gal","pH7Q TDS, Selector Guide Section 1",yes',
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

  it('parses the downloadable template so the template round-trips through import', () => {
    const [row] = parseTestCsvContent(buildTestTemplateCsv());

    expect(TEST_TEMPLATE_COLUMNS.map((column) => column.name)).toEqual([
      'question',
      'should_answer',
      'expected_result_type',
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
      'expected_sources',
      'should_cite',
      'expected_tool',
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
