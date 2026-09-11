// Single source of truth for the downloadable test-set CSV template and its column
// reference. The download button (TestTemplateDownload) and the on-screen column table
// on /admin/tests both read from here so the example row and the docs can't drift.
//
// Column semantics are kept in sync with the importer in ./csv.ts and the grader in
// ./runner.ts — only `question` is required; everything else is optional.

export type TestTemplateColumn = {
  /** CSV header name — must match what parseTestCsvContent reads. */
  name: string;
  /** The value written into the template's single example row (the attached "row 2"). */
  example: string;
  /** Whether the importer requires this column to have a value. */
  required: boolean;
  /** User-facing explanation shown in the column-reference table. */
  help: string;
};

export const TEST_TEMPLATE_COLUMNS: TestTemplateColumn[] = [
  {
    name: 'question',
    required: true,
    example:
      'Enter the prompt/question to test — e.g. How long does GE Fight Bac RTU need to stay wet to disinfect?',
    help: 'The prompt sent to Bex. Required — rows without a question (or a prompt / test_prompt column) are skipped on import.',
  },
  {
    name: 'canonical_product',
    required: false,
    example: 'Official Betco product name it maps to — e.g. pH7Q Neutral Disinfectant',
    help: 'Official Betco product the question maps to. Labelling/reference only — not used by the pass/fail grader.',
  },
  {
    name: 'reason_code',
    required: false,
    example:
      'Why-tag: cross_reference | product_info | sds_safety | dilution | use_surface | product_identity | dwell_time | regulatory_fact | efficacy_claim | sds_handling',
    help: 'Why-tag describing what the question probes (e.g. dilution, sds_safety). Labelling/reference only.',
  },
  {
    name: 'source',
    required: false,
    example: 'Where this prompt came from — e.g. email, bex, contact-us',
    help: 'Free-text origin of the prompt (e.g. email, bex, contact-us). Labelling/reference only — not used by the pass/fail grader.',
  },
  {
    name: 'priority',
    required: false,
    example: 'Optional integer rank, e.g. 1 (lower = more important)',
    help: 'Optional whole-number priority stored on the row. Invalid or non-integer values are ignored on import.',
  },
  {
    name: 'ideal_response',
    required: false,
    example: 'The ideal gold-standard answer for this prompt, in full sentences',
    help: 'The ideal/expected answer text for this prompt, stored for reviewer reference.',
  },
  {
    name: 'product_mention',
    required: false,
    example:
      'Product name as the user typed it, may be informal or misspelled — e.g. pH7Q, Best Sent Lemon Zest',
    help: 'Product name as a real user might type it (informal or misspelled). Stored with the row for context.',
  },
  {
    name: 'question_category',
    required: false,
    example:
      'Question category: recommendation | dilution | restroom-procedure | kill-claims | first-aid | dwell-time | product-comparison | competitor | sds-hazard',
    help: 'Topic grouping used to slice results (e.g. dilution, first-aid, competitor). Stored with the row for context.',
  },
  {
    name: 'source_style',
    required: false,
    example: 'How the question was authored — e.g. real_user_pattern',
    help: 'How the question was authored (e.g. real_user_pattern). Stored with the row for context.',
  },
  {
    name: 'expected_concepts',
    required: false,
    example:
      'Key concepts the ideal answer should contain, one per phrase, separated by | — e.g. 13 oz/gal or 100 mL/L | 1:10 with water | 10 minute contact time',
    help: 'Key concepts a complete answer should contain, pipe-separated (one phrase per concept). Each phrase is stored verbatim — dilution ratios, ppm, and contact times are never reformatted. Use n/a for none.',
  },
  {
    name: 'minimum_concepts',
    required: false,
    example: 'Must-have concepts for a passing answer, pipe-separated — e.g. 13 oz/gal | 10 minute contact time',
    help: 'The subset of expected_concepts a reviewer must see to pass the row, pipe-separated. Each phrase is stored verbatim. Use n/a for none.',
  },
  {
    name: 'expected_sources',
    required: false,
    example:
      'Comma-separated rag.document.id values the answer should be grounded in — e.g. 6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40, 3a91f2de-11c4-4c6f-9f2b-7d0e5a4c8b13',
    help: 'Document ids (rag.document.id UUIDs) the answer should be grounded in, comma- or pipe-separated. Values that are not UUIDs are reported as an import warning and not stored — look the id up on the RAG documents admin page.',
  },
  {
    name: 'should_cite',
    required: false,
    example: 'Should the answer cite sources? yes/no (stored true/false)',
    help: 'Whether the answer is expected to cite its sources. yes/true/1 or no/false/0; leave blank for no expectation.',
  },
  {
    name: 'expected_tool',
    required: false,
    example:
      'Function tool this question should route to, e.g. get_efficacy_data (see ~/lib/tools/tool-schemas.ts PRODUCT_TOOL_NAMES)',
    help:
      "Which of the 14 product-support function tools (search_product_docs, get_efficacy_data, lookup_cross_reference, etc.) this question is expected to call, scored by the run detail page's Tool routing panel (B0-383). Leave blank for no routing expectation.",
  },
  {
    name: 'expected_surface_type',
    required: false,
    example: 'Ground-truth surface type this question is about, e.g. tile',
    help:
      "Ground-truth surface type (matches the B0-786 signals extraction's surfaceType), scored by the run detail page's Signal accuracy panel (B0-790). Leave blank for no expectation.",
  },
  {
    name: 'expected_brand_family',
    required: false,
    example: 'Ground-truth brand family: betco | basic_coatings | envirozyme | 1950 | competitor',
    help:
      "Ground-truth brand family (matches the B0-786 signals extraction's brandFamily), scored by the run detail page's Signal accuracy panel (B0-790). Leave blank for no expectation.",
  },
  {
    name: 'expected_setting',
    required: false,
    example: 'Ground-truth use setting: commercial | residential',
    help:
      "Ground-truth use setting (matches the B0-786 signals extraction's setting), scored by the run detail page's Signal accuracy panel (B0-790). Leave blank for no expectation.",
  },
  {
    name: 'multi_turn_json',
    required: false,
    example:
      '{"version":1,"title":"Follow-up keeps the product","turns":[{"prompt":"What is pH7Q used for?"},{"prompt":"Is it safe on sealed concrete?","expectations":{"should_answer":true}}],"assertions":[{"type":"context_carry","from_turn":1,"turn":2,"anchor":"pH7Q"}]}',
    help:
      'Optional multi-turn scenario (B0-537) for this row, as one JSON object: an ordered "turns" array (2 or more) plus optional cross-turn "assertions" (context_carry, no_reask, consistent_product_anchor, mentions, not_mentions). The row is then replayed turn by turn in one conversation and graded across turns. Leave blank for an ordinary single-turn prompt. For whole scenario SETS, upload a .json file instead of a CSV — that is the primary path.',
  },
];

export const TEST_TEMPLATE_FILENAME = 'bex-test-set-template.csv';

/** RFC-4180 field quoting: wrap in double quotes and double any internal quotes. */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Builds the template CSV: a header row plus one example row (the attached "row 2")
 * whose cells describe what each column is for. Intentionally emits NO UTF-8 BOM — the
 * app's own importer parses without `bom: true`, so a BOM would corrupt the first header
 * key and break re-upload of this very file.
 */
export function buildTestTemplateCsv(): string {
  const header = TEST_TEMPLATE_COLUMNS.map((column) => csvField(column.name)).join(',');
  const exampleRow = TEST_TEMPLATE_COLUMNS.map((column) => csvField(column.example)).join(',');
  return `${header}\r\n${exampleRow}\r\n`;
}
