import { parse } from 'csv-parse/sync';

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
const LEGACY_IGNORED_CSV_COLUMNS = new Set([
  'should_answer',
  'expected_result_type',
  // B0-931 — `expected_should_answer` was dropped from `test_items` with the array retype; older
  // CSVs (and every set exported before it) still carry the column.
  'expected_should_answer',
]);

/** CSV columns routed into `input_payload` rather than `metadata`. */
const INPUT_PAYLOAD_CSV_COLUMNS = new Set([
  'product_mention',
  'question_category',
  'source_style',
]);

/**
 * Cells that mean "no phrases of this kind were specified" — the reference splitter's set.
 */
const EMPTY_PHRASE_CELL_MARKERS = new Set(['n/a', 'na', 'none', '-', '—']);

/**
 * A leading list marker: `-`, `*`, `•`, `‣`, `▪`, `·`, a lone `o`, `1.` / `1)` / `(1)`, or
 * `a.` / `a)`. Mirrors the reference skill's `concept_rules.py` `_BULLET` pattern, including its
 * case-insensitivity.
 */
const PHRASE_BULLET = /^\s*(?:[-*•‣▪·o]|\(?\d+[.)]|[a-z][.)])\s+/i;

/**
 * B0-931 — splits one phrase cell (`expected_concepts`, `minimum_concepts`, `expected_criteria`,
 * now `text[]` columns) into an ordered list of phrases. Mirrors the reference skill's
 * `concept_rules.py` `split_concepts` — the same rules the B0-930 retype used on the live rows —
 * so a CSV round-trip through import/export is lossless.
 *
 * **Pipe is the primary delimiter**, per line; newlines also split; list markers are stripped; a
 * **semicolon splits only when nothing else delimited the cell**; commas never split (a phrase
 * routinely contains one: "dilute 2 oz/gal, then dwell"). An empty cell, or one holding only an
 * empty-cell marker, yields `[]`.
 *
 * Deliberately a local copy rather than an import of `./report/case-concepts` — that module is the
 * report pipeline's and its exports are free to change; the importer keeps its own copy of the
 * rules and the tests below pin them.
 *
 * Regulated-data rule: the split is structural only. Phrases are re-emitted verbatim — dilution
 * ratios, oz/gal, mL/L, ppm, contact times, CAS numbers and EPA registration numbers are never
 * rounded, unit-converted, re-cased, reflowed or truncated here.
 */
export function splitPhraseCell(cell: string | null | undefined): string[] {
  if (cell == null) {
    return [];
  }
  const text = String(cell).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text || EMPTY_PHRASE_CELL_MARKERS.has(text.toLowerCase())) {
    return [];
  }

  let parts: string[] = [];
  for (const line of text.split('\n')) {
    parts.push(...(line.includes('|') ? line.split('|') : [line]));
  }
  // Semicolons only when nothing else delimited the cell — pipes and newlines take precedence.
  if (parts.length === 1 && text.includes(';')) {
    parts = text.split(';');
  }

  const out: string[] = [];
  for (const raw of parts) {
    const phrase = raw.replace(PHRASE_BULLET, '').trim().replace(/^;+|;+$/g, '').trim();
    if (phrase) {
      out.push(phrase);
    }
  }
  return out;
}

/** Inverse of {@link splitPhraseCell} — the pipe-delimited cell CSV export writes. */
export function formatPhraseCell(phrases: readonly string[]): string {
  return phrases.join(' | ');
}

/** Parses a repeated phrase form field (`formData.getAll(...)`): trimmed, verbatim, no blanks. */
export function parsePhraseListFromForm(values: readonly FormDataEntryValue[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const phrase = value.trim();
    if (phrase) {
      out.push(phrase);
    }
  }
  return out;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a uuid — i.e. storable in the `expected_sources` `uuid[]` column. */
export function isDocumentId(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

export type ParsedExpectedSources = {
  /** Tokens that are uuids, kept verbatim and in author order. */
  documentIds: string[];
  /** Tokens that are not uuids — surfaced as an import warning, never coerced or silently dropped. */
  invalidTokens: string[];
};

/**
 * B0-931 — `expected_sources` is now `uuid[]` holding `rag.document.id` values (the old prose
 * category labels are archived in `metadata.legacy_expected_sources`). Authors write a comma- or
 * pipe-separated list. A token that is not a uuid cannot be stored, so it is reported back to the
 * uploader as a row-level warning rather than coerced into something else or dropped in silence.
 */
export function parseExpectedSourcesCell(cell: string | null | undefined): ParsedExpectedSources {
  const documentIds: string[] = [];
  const invalidTokens: string[] = [];

  if (cell == null) {
    return { documentIds, invalidTokens };
  }
  const text = String(cell).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text || EMPTY_PHRASE_CELL_MARKERS.has(text.toLowerCase())) {
    return { documentIds, invalidTokens };
  }

  for (const token of text.split(/[,|\n]/)) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }
    if (UUID_PATTERN.test(trimmed)) {
      documentIds.push(trimmed);
    } else {
      invalidTokens.push(trimmed);
    }
  }

  return { documentIds, invalidTokens };
}

/** Parses the repeated `expectedSources` form field — each value one `rag.document.id`. */
export function parseExpectedSourceIdsFromForm(
  values: readonly FormDataEntryValue[],
): ParsedExpectedSources {
  const documentIds: string[] = [];
  const invalidTokens: string[] = [];

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    if (UUID_PATTERN.test(trimmed)) {
      documentIds.push(trimmed);
    } else {
      invalidTokens.push(trimmed);
    }
  }

  return { documentIds, invalidTokens };
}

/**
 * B0-537 — CSV escape hatch for a multi-turn scenario: the whole
 * `multiTurnScenarioSchema` document in one `multi_turn_json` cell. The primary authoring path is
 * the JSON scenario-set importer (`./multi-turn-import.ts`); this exists so a single scenario can
 * ride along in an otherwise-normal CSV.
 *
 * Tolerant like {@link splitPhraseCell}: a blank, unparseable, or schema-invalid cell yields
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
      // B0-931 — concept/criteria cells become `text[]`. The split is structural only: each
      // phrase is stored verbatim, so regulated values — oz/gal, mL/L, ppm, contact times, CAS
      // and EPA numbers — survive the round trip byte-for-byte.
      const expectedConcepts = splitPhraseCell(asTrimmedString(record.expected_concepts));
      const minimumConcepts = splitPhraseCell(asTrimmedString(record.minimum_concepts));
      const expectedCriteria = splitPhraseCell(asTrimmedString(record.expected_criteria));
      const parsedExpectedSources = parseExpectedSourcesCell(
        asTrimmedString(record.expected_sources),
      );
      const expectedSources = parsedExpectedSources.documentIds;
      const warnings: string[] =
        parsedExpectedSources.invalidTokens.length > 0
          ? [
              `expected_sources: ${parsedExpectedSources.invalidTokens
                .map((token) => `"${token}"`)
                .join(', ')} ${
                parsedExpectedSources.invalidTokens.length === 1 ? 'is not a' : 'are not'
              } document id${
                parsedExpectedSources.invalidTokens.length === 1 ? '' : 's'
              } (rag.document.id uuid) and could not be imported.`,
            ]
          : [];
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
        warnings,
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
