import { parse } from 'csv-parse/sync';

import type { CriteriaTier, ExpectedCriterion } from './criteria-schemas';
import {
  MULTI_TURN_PAYLOAD_KEY,
  multiTurnScenarioSchema,
  type MultiTurnScenario,
} from './multi-turn';
import type { ParsedCsvRow } from './types';

function asTrimmedString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * B0-833 — decodes uploaded CSV/dataset bytes as text, tolerating non-UTF-8 exports. Excel's
 * "CSV" export on Windows is frequently Windows-1252 (cp1252), not UTF-8: a Windows-1252 en dash
 * (–, 0x96) or degree sign (°, 0xB0) is not valid UTF-8 on its own, so a naive
 * `new TextDecoder('utf-8').decode(bytes)` — non-fatal by default — silently swaps each one for
 * U+FFFD (the replacement character) instead of erroring. That is exactly the corruption found in
 * `test_items.expected_concepts` / `minimum_concepts` (111 phrases across 47 items, 9 tests —
 * e.g. "20�45 min", "35�50% RH"): the source CSVs were Windows-1252, imported as if UTF-8.
 *
 * Decoding strictly (`fatal: true`) first and falling back to Windows-1252 only when that throws
 * fixes the common case without guessing at any specific character: Windows-1252 is a superset of
 * ISO-8859-1 and maps every byte 0x00-0xFF to a real character (never U+FFFD), so the fallback
 * itself can never reintroduce the bug it's fixing. A genuinely UTF-8 file (the common case,
 * including one with a UTF-8 BOM) is completely unaffected — it still decodes on the first,
 * strict pass.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Yes/no CSV cell parsing for `should_cite`. */
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

/** Parses the `should_cite` form field / CSV cell. Blank or unrecognized → no expectation. */
export function parseShouldCiteFromForm(value: string): boolean | null {
  return parseBooleanCell(value);
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
  'expected_tool',
  // B0-790 — ground-truth columns for the signals-accuracy harness.
  'expected_surface_type',
  'expected_brand_family',
  'expected_setting',
  // B0-537 — routed into `input_payload.multi_turn`, not `metadata`, by `parseMultiTurnJsonCell`.
  'multi_turn_json',
]);

/**
 * B0-799 — retired dataset columns. Older CSVs (and sets downloaded before the removal) still
 * carry them; they are dropped on import rather than falling through to the `metadata`
 * catch-all (the B0-694 anti-pattern). The `test_items` columns themselves are untouched.
 */
const LEGACY_IGNORED_CSV_COLUMNS = new Set(['should_answer', 'expected_result_type']);

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

/**
 * B0-537 — CSV escape hatch for a multi-turn scenario: the whole
 * `multiTurnScenarioSchema` document in one `multi_turn_json` cell. The primary authoring path is
 * the JSON scenario-set importer (`./multi-turn-import.ts`); this exists so a single scenario can
 * ride along in an otherwise-normal CSV.
 *
 * Tolerant like `parseExpectedCriteriaCell`: a blank, unparseable, or schema-invalid cell yields
 * `null` (the row imports as an ordinary single-turn prompt) rather than failing a 200-row upload.
 * The runner is the backstop — a scenario that IS stored but invalid is reported as a failed row,
 * never silently downgraded.
 */
export function parseMultiTurnJsonCell(value: string): MultiTurnScenario | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = multiTurnScenarioSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Inverse of {@link parseMultiTurnJsonCell} — compact one-line JSON for CSV export. */
export function formatMultiTurnJsonCell(scenario: MultiTurnScenario | null): string {
  return scenario ? JSON.stringify(scenario) : '';
}

/**
 * The add/edit prompt dialog's multi-turn field. Unlike the CSV cell this is STRICT: one
 * interactive row has one author watching, so a typo must be reported rather than silently dropped.
 * Blank clears the row back to a single-turn prompt.
 */
export function parseMultiTurnJsonFromForm(
  value: string,
): { ok: true; scenario: MultiTurnScenario | null } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, scenario: null };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      message: `Multi-turn scenario is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = multiTurnScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, message: `Multi-turn scenario is invalid — ${issues}` };
  }

  return { ok: true, scenario: parsed.data };
}

export function parseTestCsvContent(content: string): ParsedCsvRow[] {
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, unknown>[];

  return records
    .map((record, index): ParsedCsvRow | null => {
      const prompt =
        asTrimmedString(record.question) ||
        asTrimmedString(record.prompt) ||
        asTrimmedString(record.test_prompt);

      if (!prompt) {
        return null;
      }

      const rowIndex = index + 1;
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
      const expectedTool = asTrimmedString(record.expected_tool) || null;
      // B0-790 — ground truth for the signals-accuracy harness; validated only in app code
      // (~/lib/tests/signal-accuracy.ts), same as expected_tool above.
      const expectedSurfaceType = asTrimmedString(record.expected_surface_type) || null;
      const expectedBrandFamily = asTrimmedString(record.expected_brand_family) || null;
      const expectedSetting = asTrimmedString(record.expected_setting) || null;
      const multiTurnScenario = parseMultiTurnJsonCell(
        asTrimmedString(record.multi_turn_json),
      );

      const inputPayload: ParsedCsvRow['inputPayload'] = {};
      const metadata: Record<string, string> = {};

      for (const [key, value] of Object.entries(record)) {
        const normalizedKey = key.trim();
        const normalizedValue = asTrimmedString(value);

        if (!normalizedKey || !normalizedValue) {
          continue;
        }

        if (
          TYPED_CSV_COLUMNS.has(normalizedKey) ||
          LEGACY_IGNORED_CSV_COLUMNS.has(normalizedKey)
        ) {
          continue;
        }

        if (INPUT_PAYLOAD_CSV_COLUMNS.has(normalizedKey)) {
          inputPayload[normalizedKey] = normalizedValue;
          continue;
        }

        metadata[normalizedKey] = normalizedValue;
      }

      if (multiTurnScenario) {
        // Same storage key the JSON importer and the runner use — there is only one place a
        // scenario ever lives.
        inputPayload[MULTI_TURN_PAYLOAD_KEY] = JSON.parse(
          JSON.stringify(multiTurnScenario),
        );
        metadata.multi_turn_turn_count = String(multiTurnScenario.turns.length);
      }

      return {
        rowIndex,
        prompt,
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
        expectedTool,
        expectedSurfaceType,
        expectedBrandFamily,
        expectedSetting,
        multiTurnScenario,
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
