import { parse } from 'csv-parse/sync';

import type { ParsedCsvRow } from './types';

function asTrimmedString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseExpectedShouldAnswer(value: string): boolean | null {
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

      const inputPayload: Record<string, string> = {};
      const metadata: Record<string, string> = {};

      for (const [key, value] of Object.entries(record)) {
        const normalizedKey = key.trim();
        const normalizedValue = asTrimmedString(value);

        if (!normalizedKey || !normalizedValue) {
          continue;
        }

        if (
          normalizedKey === 'question' ||
          normalizedKey === 'prompt' ||
          normalizedKey === 'test_prompt' ||
          normalizedKey === 'should_answer' ||
          normalizedKey === 'expected_result_type' ||
          normalizedKey === 'canonical_product' ||
          normalizedKey === 'reason_code'
        ) {
          continue;
        }

        if (
          normalizedKey === 'product_mention' ||
          normalizedKey === 'question_category' ||
          normalizedKey === 'source_style'
        ) {
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
