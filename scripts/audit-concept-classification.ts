#!/usr/bin/env -S npx tsx
/**
 * B0-828 — audit of mandatory (`minimum_concepts`) vs expected (`expected_concepts`) concept
 * classification across every test set that carries concept columns.
 *
 * Under Bex's concept scoring rules (B0-835 — the agent-evaluation skill's) a missing must-have
 * concept gates the case (Result Fail, score capped at 59) while a missing expected concept only
 * lowers Completeness through coverage — so the mandatory/expected split decides both what fails
 * outright and what leadership sees flagged. This script exports every `public.test_items`
 * row that carries either concept array (B0-930 retyped both columns from free text to `text[]`,
 * so the phrases arrive already split and no splitter is involved), and flags review candidates
 * for the business owners
 * (work items 1–2 of B0-828). Items 3–4 (the agreed lists and the change log) are theirs.
 *
 * READ-ONLY: nothing here writes to the database. Output is two CSVs plus a stdout summary.
 *
 *   npx tsx --env-file=.env.local scripts/audit-concept-classification.ts --out <dir> [--examples 10]
 *
 * Per-PHRASE flags (concept-audit-phrases.csv):
 *   mandatory_not_in_expected         a mandatory phrase whose normalised form has no equal, containing
 *                                     or contained match among the expected phrases. The scoring model
 *                                     assumes mandatory ⊆ expected; Bex asserts it.
 *   duplicate_across_columns          normalised equality between a mandatory and an expected phrase —
 *                                     expected and benign under mandatory ⊆ expected, counted anyway.
 *   near_duplicate_within_column      two phrases in the same cell that are equal after normalisation,
 *                                     one contains the other, or Levenshtein ≤ 2 when both > 8 chars.
 *   regulated_value                   the phrase carries a regulated value (oz/gal, mL/L, ppm, %,
 *                                     contact time, ratio, EPA Reg, CAS, log reduction). These belong
 *                                     in mandatory and must be exact.
 *   procedural_or_stylistic_mandatory a MANDATORY phrase built on a procedural / stylistic cue word
 *                                     (recommend, mention, explain, tone, format, …) — a candidate for
 *                                     demotion to expected.
 *   replacement_char                  the stored phrase contains U+FFFD (encoding corruption at import).
 *                                     Where that sits inside a regulated value ("~20�45 min") the
 *                                     value is unreadable as stored — say so, never guess the character.
 * Per-ITEM flags (concept-audit-items.csv):
 *   mandatory_gt_expected             more mandatory phrases than expected phrases.
 *   no_expected                       no expected phrases — Unable to Evaluate (a concept-less case is never graded).
 *   no_mandatory                      no mandatory phrases.
 *
 * Both files are sorted deterministically (test name, question, item id; then column and phrase
 * order) so a re-run after reclassification diffs cleanly for the step-3 before/after.
 *
 * Regulated-data rule: every phrase is re-emitted verbatim. Nothing here parses, rounds or converts
 * a value — the `regulated_value` regexes only detect that a number-with-unit is present.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normConcept } from '~/lib/tests/report/case-concepts';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/** PostgREST caps a single request at 1000 rows (db-max-rows), so the export pages. */
const PAGE_SIZE = 1000;

type TestRow = { id: string; name: string; is_golden: boolean; is_archived: boolean };

type ItemRow = {
  id: string;
  test_id: string;
  prompt: string;
  /** B0-930 — `text[]`, one concept phrase per element. */
  minimum_concepts: string[];
  expected_concepts: string[];
};

type Column = 'mandatory' | 'expected';

type PhraseFlag =
  | 'mandatory_not_in_expected'
  | 'duplicate_across_columns'
  | 'near_duplicate_within_column'
  | 'regulated_value'
  | 'procedural_or_stylistic_mandatory'
  | 'replacement_char';

const PHRASE_FLAGS: readonly PhraseFlag[] = [
  'mandatory_not_in_expected',
  'duplicate_across_columns',
  'near_duplicate_within_column',
  'regulated_value',
  'procedural_or_stylistic_mandatory',
  'replacement_char',
];

/** The Unicode replacement character — what a mis-decoded en dash or degree sign became at import. */
const REPLACEMENT_CHAR = '�';

type ItemFlag = 'mandatory_gt_expected' | 'no_expected' | 'no_mandatory';

const ITEM_FLAGS: readonly ItemFlag[] = ['mandatory_gt_expected', 'no_expected', 'no_mandatory'];

type PhraseRecord = {
  testName: string;
  testId: string;
  itemId: string;
  question: string;
  column: Column;
  index: number;
  phrase: string;
  normalised: string;
  flags: Set<PhraseFlag>;
};

type ItemRecord = {
  testName: string;
  isGolden: boolean;
  isArchived: boolean;
  itemId: string;
  question: string;
  mandatoryCount: number;
  expectedCount: number;
  mandatoryNotInExpectedCount: number;
  regulatedInMandatory: number;
  regulatedInExpectedOnly: number;
  itemFlags: ItemFlag[];
  rawMinimum: string;
  rawExpected: string;
};

/**
 * A number followed by a regulated unit or construct. Detection only — the matched text is never
 * extracted, rounded or converted.
 */
const REGULATED_PATTERNS: readonly RegExp[] = [
  /\d\s*(?:fl\.?\s*)?oz\.?\s*(?:\/|per)\s*(?:gal|gallon)s?\b/i,
  /\d\s*ml\s*(?:\/|per)\s*(?:l|liter|litre)s?\b/i,
  /\d\s*ppm\b/i,
  /\d\s*%/,
  /\d\s*(?:min|mins|minute|minutes|sec|secs|second|seconds|hr|hrs|hour|hours)\b/i,
  /\b\d+(?:\.\d+)?\s*(?::|\bto\b)\s*\d+(?:\.\d+)?\b/i,
  /\bEPA\s*Reg/i,
  /\b\d{2,7}-\d{2}-\d\b/,
  /\b\d+(?:\.\d+)?[\s-]*log\b/i,
];

/** Cue words that mark a phrase as procedural or stylistic rather than substantive. */
const PROCEDURAL_CUES =
  /\b(?:recommends?|recommended|mentions?|mentioned|explains?|explained|describes?|described|tone|friendly|polite|politely|format|formatted|bullets?|bulleted|lists?|listed|summari[sz]e[sd]?|summary|suggests?|suggested|asks?|asked|clarif(?:y|ies|ied|ying)|follow[\s-]?up|links?|linked|contact|contacts|refers?|referred|referral|offers?|offered|emphasi[sz]es?|emphasi[sz]ed|note that|reminds?|reminded)\b/i;

/** Cells with a non-blank trimmed value — the same predicate the SQL selection uses. */
function isRegulated(phrase: string): boolean {
  return REGULATED_PATTERNS.some((re) => re.test(phrase));
}

function isProcedural(phrase: string): boolean {
  return PROCEDURAL_CUES.test(phrase);
}

/** Classic two-row Levenshtein distance. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Equal, or one normalised form contains the other. Empty keys never match. */
function looseMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function nearDuplicate(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (looseMatch(a, b)) return true;
  return a.length > 8 && b.length > 8 && levenshtein(a, b) <= 2;
}

function csvCell(value: string | number | boolean | null | undefined): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(cells: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return cells.map(csvCell).join(',');
}

function parseArgs(argv: string[]) {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  return {
    out: get('--out') ?? 'concept-audit',
    examples: Number(get('--examples') ?? 0),
  };
}

async function loadTests(): Promise<Map<string, TestRow>> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('tests')
    .select('id, name, is_golden, is_archived')
    .order('id');
  if (error) throw new Error(`tests: ${error.message}`);
  return new Map((data ?? []).map((row) => [row.id, row as TestRow]));
}

/** Every item with a non-null concept cell, paged; the trimmed-non-empty filter is applied after. */
async function loadItems(): Promise<ItemRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const rows: ItemRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('test_items')
      .select('id, test_id, prompt, minimum_concepts, expected_concepts')
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`test_items page @${from}: ${error.message}`);
    const page = (data ?? []) as ItemRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows.filter((row) => row.minimum_concepts.length > 0 || row.expected_concepts.length > 0);
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'en') || (a < b ? -1 : a > b ? 1 : 0);
}

function analyse(items: ItemRow[], tests: Map<string, TestRow>) {
  const phrases: PhraseRecord[] = [];
  const itemRecords: ItemRecord[] = [];

  for (const item of items) {
    const test = tests.get(item.test_id);
    const testName = test?.name ?? `(unknown test ${item.test_id})`;
    const mandatory = item.minimum_concepts;
    const expected = item.expected_concepts;

    const make = (column: Column, list: string[]): PhraseRecord[] =>
      list.map((phrase, index) => ({
        testName,
        testId: item.test_id,
        itemId: item.id,
        question: item.prompt,
        column,
        index,
        phrase,
        normalised: normConcept(phrase),
        flags: new Set<PhraseFlag>(),
      }));
    const mand = make('mandatory', mandatory);
    const exp = make('expected', expected);

    // Cross-column: subset check and exact duplicates.
    for (const m of mand) {
      if (!exp.some((e) => looseMatch(m.normalised, e.normalised))) {
        m.flags.add('mandatory_not_in_expected');
      }
      for (const e of exp) {
        if (m.normalised && m.normalised === e.normalised) {
          m.flags.add('duplicate_across_columns');
          e.flags.add('duplicate_across_columns');
        }
      }
    }

    // Within-column near duplicates (pairwise).
    for (const list of [mand, exp]) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          if (nearDuplicate(list[i].normalised, list[j].normalised)) {
            list[i].flags.add('near_duplicate_within_column');
            list[j].flags.add('near_duplicate_within_column');
          }
        }
      }
    }

    // Content flags.
    for (const p of [...mand, ...exp]) {
      if (isRegulated(p.phrase)) p.flags.add('regulated_value');
      if (p.phrase.includes(REPLACEMENT_CHAR)) p.flags.add('replacement_char');
    }
    for (const m of mand) {
      if (isProcedural(m.phrase)) m.flags.add('procedural_or_stylistic_mandatory');
    }

    const regulatedInMandatory = mand.filter((m) => m.flags.has('regulated_value')).length;
    const regulatedInExpectedOnly = exp.filter(
      (e) =>
        e.flags.has('regulated_value') &&
        !mand.some((m) => looseMatch(m.normalised, e.normalised)),
    ).length;

    const itemFlags: ItemFlag[] = [];
    if (mand.length > exp.length) itemFlags.push('mandatory_gt_expected');
    if (exp.length === 0) itemFlags.push('no_expected');
    if (mand.length === 0) itemFlags.push('no_mandatory');

    phrases.push(...mand, ...exp);
    itemRecords.push({
      testName,
      isGolden: test?.is_golden ?? false,
      isArchived: test?.is_archived ?? false,
      itemId: item.id,
      question: item.prompt,
      mandatoryCount: mand.length,
      expectedCount: exp.length,
      mandatoryNotInExpectedCount: mand.filter((m) => m.flags.has('mandatory_not_in_expected'))
        .length,
      regulatedInMandatory,
      regulatedInExpectedOnly,
      itemFlags,
      // Re-joined for the CSV cell only; each phrase is still emitted verbatim.
      rawMinimum: item.minimum_concepts.join(' | '),
      rawExpected: item.expected_concepts.join(' | '),
    });
  }

  const byItem = (a: { testName: string; question: string; itemId: string }, b: typeof a) =>
    compareText(a.testName, b.testName) ||
    compareText(a.question, b.question) ||
    compareText(a.itemId, b.itemId);

  phrases.sort(
    (a, b) =>
      byItem(a, b) ||
      (a.column === b.column ? 0 : a.column === 'mandatory' ? -1 : 1) ||
      a.index - b.index,
  );
  itemRecords.sort(byItem);

  return { phrases, itemRecords };
}

type TestSummary = {
  items: number;
  mandatoryPhrases: number;
  expectedPhrases: number;
  phraseFlags: Record<PhraseFlag, number>;
  itemFlags: Record<ItemFlag, number>;
};

function emptySummary(): TestSummary {
  return {
    items: 0,
    mandatoryPhrases: 0,
    expectedPhrases: 0,
    phraseFlags: Object.fromEntries(PHRASE_FLAGS.map((f) => [f, 0])) as Record<PhraseFlag, number>,
    itemFlags: Object.fromEntries(ITEM_FLAGS.map((f) => [f, 0])) as Record<ItemFlag, number>,
  };
}

function summarise(phrases: PhraseRecord[], items: ItemRecord[]) {
  const perTest = new Map<string, TestSummary>();
  const total = emptySummary();
  const bump = (s: TestSummary, fn: (s: TestSummary) => void) => {
    fn(s);
    fn(total);
  };
  for (const item of items) {
    const s = perTest.get(item.testName) ?? emptySummary();
    perTest.set(item.testName, s);
    bump(s, (x) => {
      x.items += 1;
      x.mandatoryPhrases += item.mandatoryCount;
      x.expectedPhrases += item.expectedCount;
      for (const f of item.itemFlags) x.itemFlags[f] += 1;
    });
  }
  for (const p of phrases) {
    const s = perTest.get(p.testName) ?? emptySummary();
    perTest.set(p.testName, s);
    bump(s, (x) => {
      for (const f of p.flags) x.phraseFlags[f] += 1;
    });
  }
  return { perTest, total };
}

function printSummary(perTest: Map<string, TestSummary>, total: TestSummary, tests: Map<string, TestRow>) {
  const meta = new Map<string, TestRow>();
  for (const t of tests.values()) meta.set(t.name, t);
  const names = [...perTest.keys()].sort(compareText);
  const line = (name: string, s: TestSummary) => {
    const t = meta.get(name);
    const tag = t ? `${t.is_golden ? 'golden' : 'non-golden'}${t.is_archived ? ', archived' : ''}` : '';
    console.log(`\n${name}${tag ? `  [${tag}]` : ''}`);
    console.log(
      `  items ${s.items} · mandatory phrases ${s.mandatoryPhrases} · expected phrases ${s.expectedPhrases}`,
    );
    console.log(
      `  phrase flags: ${PHRASE_FLAGS.map((f) => `${f}=${s.phraseFlags[f]}`).join('  ')}`,
    );
    console.log(`  item flags:   ${ITEM_FLAGS.map((f) => `${f}=${s.itemFlags[f]}`).join('  ')}`);
  };
  console.log('CONCEPT CLASSIFICATION AUDIT (B0-828) — per test');
  for (const name of names) line(name, perTest.get(name)!);
  console.log('\n' + '='.repeat(72));
  console.log(`TOTAL — ${names.length} tests`);
  console.log(
    `  items ${total.items} · mandatory phrases ${total.mandatoryPhrases} · expected phrases ${total.expectedPhrases}`,
  );
  console.log(
    `  phrase flags: ${PHRASE_FLAGS.map((f) => `${f}=${total.phraseFlags[f]}`).join('  ')}`,
  );
  console.log(`  item flags:   ${ITEM_FLAGS.map((f) => `${f}=${total.itemFlags[f]}`).join('  ')}`);
}

/** `n` examples per flag, round-robin across tests so the sample is varied, not one set's rows. */
function printExamples(phrases: PhraseRecord[], items: ItemRecord[], n: number) {
  if (n <= 0) return;
  const clip = (s: string, len = 90) => (s.length > len ? `${s.slice(0, len - 1)}…` : s);
  const roundRobin = <T extends { testName: string }>(rows: T[]): T[] => {
    const buckets = new Map<string, T[]>();
    for (const r of rows) {
      const b = buckets.get(r.testName) ?? [];
      b.push(r);
      buckets.set(r.testName, b);
    }
    const out: T[] = [];
    const queues = [...buckets.values()];
    while (out.length < n && queues.some((q) => q.length > 0)) {
      for (const q of queues) {
        const next = q.shift();
        if (next) out.push(next);
        if (out.length >= n) break;
      }
    }
    return out;
  };
  console.log('\n' + '='.repeat(72));
  console.log(`EXAMPLES — up to ${n} per flag, spread across tests`);
  for (const flag of PHRASE_FLAGS) {
    const rows = roundRobin(phrases.filter((p) => p.flags.has(flag)));
    console.log(`\n[${flag}] ${rows.length} shown`);
    for (const r of rows) {
      console.log(`  - ${r.testName} | ${clip(r.question, 70)} | ${r.column}: "${clip(r.phrase)}"`);
    }
  }
  for (const flag of ITEM_FLAGS) {
    const rows = roundRobin(items.filter((i) => i.itemFlags.includes(flag)));
    console.log(`\n[${flag}] ${rows.length} shown`);
    for (const r of rows) {
      console.log(
        `  - ${r.testName} | ${clip(r.question, 70)} | mandatory ${r.mandatoryCount} / expected ${r.expectedCount}`,
      );
    }
  }
}

async function writeCsvs(outDir: string, phrases: PhraseRecord[], items: ItemRecord[]) {
  await mkdir(outDir, { recursive: true });
  const phraseLines = [
    csvLine(['test_name', 'test_id', 'item_id', 'question', 'column', 'phrase', 'normalised', 'flags']),
    ...phrases.map((p) =>
      csvLine([
        p.testName,
        p.testId,
        p.itemId,
        p.question,
        p.column,
        p.phrase,
        p.normalised,
        [...p.flags].sort().join(';'),
      ]),
    ),
  ];
  const itemLines = [
    csvLine([
      'test_name',
      'item_id',
      'question',
      'mandatory_count',
      'expected_count',
      'mandatory_not_in_expected_count',
      'regulated_in_mandatory',
      'regulated_in_expected_only',
      'item_flags',
      'minimum_concepts',
      'expected_concepts',
      'is_golden',
      'is_archived',
    ]),
    ...items.map((i) =>
      csvLine([
        i.testName,
        i.itemId,
        i.question,
        i.mandatoryCount,
        i.expectedCount,
        i.mandatoryNotInExpectedCount,
        i.regulatedInMandatory,
        i.regulatedInExpectedOnly,
        i.itemFlags.join(';'),
        i.rawMinimum,
        i.rawExpected,
        i.isGolden,
        i.isArchived,
      ]),
    ),
  ];
  const phrasesPath = path.join(outDir, 'concept-audit-phrases.csv');
  const itemsPath = path.join(outDir, 'concept-audit-items.csv');
  await writeFile(phrasesPath, `${phraseLines.join('\n')}\n`, 'utf8');
  await writeFile(itemsPath, `${itemLines.join('\n')}\n`, 'utf8');
  return { phrasesPath, itemsPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(process.cwd(), options.out);

  const [tests, items] = await Promise.all([loadTests(), loadItems()]);
  console.log(`Loaded ${items.length} test_items with a concept cell across ${tests.size} tests.`);

  const { phrases, itemRecords } = analyse(items, tests);
  const { perTest, total } = summarise(phrases, itemRecords);
  printSummary(perTest, total, tests);
  printExamples(phrases, itemRecords, options.examples);

  const written = await writeCsvs(outDir, phrases, itemRecords);
  console.log(`\nWrote ${phrases.length} phrase rows -> ${written.phrasesPath}`);
  console.log(`Wrote ${itemRecords.length} item rows   -> ${written.itemsPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
