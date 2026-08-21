import { parse } from 'csv-parse/sync';

import type { CriteriaTier, ExpectedCriterion } from './criteria-schemas';
import type { ParsedCsvRow } from './types';

function asTrimmedString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Shared yes/no CSV cell parsing for `should_answer` and `should_cite`. */
function parseBooleanCell(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (['yes', 'true', '1'].includes(normalized)) {
    return true;
  }
  if (['no', 'false', '0'].includes(normalized)) {
    return false;
  }
  return null;
}

function parseExpectedShouldAnswer(value: string): boolean | null {
  return parseBooleanCell(value);
}

/** Parses the `should_cite` form field / CSV cell. Blank or unrecognized → no expectation. */
export function parseShouldCiteFromForm(value: string): boolean | null {
  return parseBooleanCell(value);
}

/** Parses manual add form / combobox values (presets + CSV-style tokens). */
export function parseExpectedShouldAnswerFromForm(value: string): boolean | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower === 'na' ||
    lower === 'n/a' ||
    lower === 'no expectation (n/a)'
  ) {
    return null;
  }
  if (lower === 'should answer') {
    return true;
  }
  if (lower === 'should decline') {
    return false;
  }

  return parseExpectedShouldAnswer(trimmed);
}

/**
 * Parses a priority value (CSV cell or form input) into an int2-safe integer.
 * Blank, non-numeric, decimal, or out-of-range (−32768..32767) values → null.
 */
export function parsePriority(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < -32768 || parsed > 32767) {
    return null;
  }
  return parsed;
}

/** CSV columns read into typed `test_items` columns — kept out of the `metadata` catch-all. */
const TYPED_CSV_COLUMNS = new Set([
  'question',
  'prompt',
  'test_prompt',
  'should_answer',
  'expected_result_type',
  'canonical_product',
  'reason_code',
  'source',
  'priority',
  'ideal_response',
  'expected_concepts',
  'minimum_concepts',
  'expected_criteria',
  'expected_sources',
  'should_cite',
]);

/** CSV columns routed into `input_payload` rather than `metadata`. */
const INPUT_PAYLOAD_CSV_COLUMNS = new Set([
  'product_mention',
  'question_category',
  'source_style',
]);

/**
 * B0-615 — mini-syntax for `expected_criteria`, so test authors keep a flat CSV cell
 * instead of a JSON blob (per the business case's CSV-authoring mitigation): segments
 * separated by `;`, each `t<tier>[x]: <concept>` — tier is 1 (must-have) / 2 (should-have)
 * / 3 (bonus); a trailing `x` on the tier marks `match: 'exact'` (regulated values —
 * dilution ratios, oz/gal, mL/L, ppm, contact times, CAS/EPA numbers — checked as a
 * literal substring, never rounded/converted/inferred).
 *
 * Example: `t1: dilution 4 oz/gal; t1x: EPA Reg. No. 12345-67; t2: dwell time`
 *
 * Malformed segments (no `t<1|2|3>[x]:` prefix, or an empty concept) are dropped rather
 * than throwing, so one typo in a 200-row CSV upload does not fail the whole import —
 * authors see the parsed result on the review step before it is saved.
 */
const CRITERION_SEGMENT_PATTERN = /^t([123])(x)?\s*:\s*(.+)$/i;

export function parseExpectedCriteriaCell(value: string): ExpectedCriterion[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  return trimmed
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment): ExpectedCriterion | null => {
      const match = CRITERION_SEGMENT_PATTERN.exec(segment);
      if (!match) {
        return null;
      }
      const tier = Number(match[1]) as CriteriaTier;
      const isExact = Boolean(match[2]);
      const concept = (match[3] ?? '').trim();
      if (!concept) {
        return null;
      }
      return { concept, tier, match: isExact ? 'exact' : 'semantic' };
    })
    .filter((c): c is ExpectedCriterion => c !== null);
}

/** Inverse of `parseExpectedCriteriaCell` — for pre-filling the manual-entry textarea and CSV export. */
export function formatExpectedCriteriaCell(criteria: ExpectedCriterion[]): string {
  return criteria
    .map((c) => `t${c.tier}${c.match === 'exact' ? 'x' : ''}: ${c.concept}`)
    .join('; ');
}

/** Parses the `expectedCriteria` manual-entry / edit form field (same mini-syntax as the CSV cell). */
export function parseExpectedCriteriaFromForm(value: string): ExpectedCriterion[] {
  return parseExpectedCriteriaCell(value);
}

export function parseTestCsvContent(content: string): ParsedCsvRow[] {
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, unknown>[];

  return records
    .map((record, index) => {
      const prompt =
        asTrimmedString(record.question) ||
        asTrimmedString(record.prompt) ||
        asTrimmedString(record.test_prompt);

      if (!prompt) {
        return null;
      }

      const rowIndex = index + 1;
      const expectedShouldAnswer = parseExpectedShouldAnswer(
        asTrimmedString(record.should_answer),
      );
      const expectedResultType = asTrimmedString(record.expected_result_type) || null;
      const expectedCanonicalProduct =
        asTrimmedString(record.canonical_product) || null;
      const expectedReasonCode = asTrimmedString(record.reason_code) || null;
      const source = asTrimmedString(record.source) || null;
      const priority = parsePriority(asTrimmedString(record.priority));
      const idealResponse = asTrimmedString(record.ideal_response) || null;
      // Concept/source expectations are stored verbatim (never split or normalized) so
      // regulated values — oz/gal, mL/L, ppm, contact times — survive the round trip.
      const expectedConcepts = asTrimmedString(record.expected_concepts) || null;
      const minimumConcepts = asTrimmedString(record.minimum_concepts) || null;
      const expectedCriteria = parseExpectedCriteriaCell(asTrimmedString(record.expected_criteria));
      const expectedSources = asTrimmedString(record.expected_sources) || null;
      const shouldCite = parseBooleanCell(asTrimmedString(record.should_cite));

      const inputPayload: Record<string, string> = {};
      const metadata: Record<string, string> = {};

      for (const [key, value] of Object.entries(record)) {
        const normalizedKey = key.trim();
        const normalizedValue = asTrimmedString(value);

        if (!normalizedKey || !normalizedValue) {
          continue;
        }

        if (TYPED_CSV_COLUMNS.has(normalizedKey)) {
          continue;
        }

        if (INPUT_PAYLOAD_CSV_COLUMNS.has(normalizedKey)) {
          inputPayload[normalizedKey] = normalizedValue;
          continue;
        }

        metadata[normalizedKey] = normalizedValue;
      }

      return {
        rowIndex,
        prompt,
        expectedShouldAnswer,
        expectedResultType,
        expectedCanonicalProduct,
        expectedReasonCode,
        source,
        priority,
        idealResponse,
        expectedConcepts,
        minimumConcepts,
        expectedCriteria,
        expectedSources,
        shouldCite,
        inputPayload,
        metadata,
      } satisfies ParsedCsvRow;
    })
    .filter((row): row is ParsedCsvRow => row !== null);
}

export function parseCsvColumnNames(content: string) {
  const headerRecords = parse(content, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    to_line: 1,
  }) as string[][];

  return (headerRecords[0] || []).map((column) => column.trim()).filter(Boolean);
}
