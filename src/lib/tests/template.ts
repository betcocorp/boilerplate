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
    name: 'should_answer',
    required: false,
    example: 'Should the assistant answer? yes/no (stored true/false)',
    help: 'Whether Bex should answer. yes/true/1 expects an answer; no/false/0 expects a decline; leave blank for no expectation.',
  },
  {
    name: 'expected_result_type',
    required: false,
    example:
      'Expected output type: answer | decline | list | none; SDS types: first_aid, disposal, spill_response, handling_storage, exposure_ppe, hazard',
    help: "Shape of a correct response. For should_answer=no rows, 'decline' or 'none' makes the grader require a decline-style answer.",
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
      'Key concepts the ideal answer should contain, as a single string — e.g. 13 oz/gal or 100 mL/L; 1:10 with water',
    help: 'Key concepts a complete answer should contain, as one string. Stored verbatim — dilution ratios, ppm, and contact times are never reformatted.',
  },
  {
    name: 'minimum_concepts',
    required: false,
    example: 'Minimum concepts required for a passing answer, as a single string — e.g. 13 oz/gal',
    help: 'The subset of expected_concepts a reviewer must see to pass the row, as one string. Stored verbatim.',
  },
  {
    name: 'expected_sources',
    required: false,
    example:
      'Comma-separated sources the answer should draw from — e.g. Ax-It Plus TDS, Selector Guide Section 1',
    help: 'Sources the answer should be grounded in, comma-separated. Stored as typed for reviewer reference.',
  },
  {
    name: 'should_cite',
    required: false,
    example: 'Should the answer cite sources? yes/no (stored true/false)',
    help: 'Whether the answer is expected to cite its sources. yes/true/1 or no/false/0; leave blank for no expectation.',
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
