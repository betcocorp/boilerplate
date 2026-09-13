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
  /** TypeScript type definition for this column. */
  format: string;
  /** Literal acceptable examples for this column. */
  examples: string;
};

export const TEST_TEMPLATE_COLUMNS: TestTemplateColumn[] = [
  {
    name: 'question',
    required: true,
    example:
      'Enter the prompt/question to test — e.g. How long does GE Fight Bac RTU need to stay wet to disinfect?',
    help: 'The prompt or question to test.',
    format: 'string',
    examples: 'How long does pH7Q need to stay wet? | What dilution for tile floors?',
  },
  {
    name: 'canonical_product',
    required: false,
    example: 'Official Betco product name it maps to — e.g. pH7Q Neutral Disinfectant',
    help: 'Official Betco product this question is about.',
    format: 'string | null',
    examples: 'pH7Q Neutral Disinfectant | Basic Coatings Hard Wax Oil',
  },
  {
    name: 'reason_code',
    required: false,
    example:
      'Why-tag: cross_reference | product_info | sds_safety | dilution | use_surface | product_identity | dwell_time | regulatory_fact | efficacy_claim | sds_handling',
    help: 'A why-tag describing what topic this question covers. Free text — not DB-enforced; these are the conventional values in use.',
    format: 'string | null',
    examples: 'dilution | sds_safety | efficacy_claim',
  },
  {
    name: 'source',
    required: false,
    example: 'Where this prompt came from — e.g. email, bex, contact-us',
    help: 'Where this prompt originated from.',
    format: 'string | null',
    examples: 'email | bex | contact-us | customer-feedback',
  },
  {
    name: 'priority',
    required: false,
    example: 'Optional integer rank, e.g. 1 (lower = more important)',
    help: 'Priority ranking for this test item (lower numbers = higher priority).',
    format: 'number | null',
    examples: '1 | 2 | 5 | 10',
  },
  {
    name: 'ideal_response',
    required: false,
    example: 'The ideal gold-standard answer for this prompt, in full sentences',
    help: 'The gold-standard answer for reviewers to compare against.',
    format: 'string | null',
    examples: 'Mix 1 part concentrate with 9 parts water | Apply at 200 ppm for 10 minutes',
  },
  {
    name: 'product_mention',
    required: false,
    example:
      'Product name as the user typed it, may be informal or misspelled — e.g. pH7Q, Best Sent Lemon Zest',
    help: 'The product name as a user might actually type it (informal or misspelled).',
    format: 'string | null',
    examples: 'pH7Q | ph7q | Best Sent Lemon Zest | betco lemon',
  },
  {
    name: 'question_category',
    required: false,
    example:
      'Question category: recommendation | dilution | restroom-procedure | kill-claims | first-aid | dwell-time | product-comparison | competitor | sds-hazard',
    help: 'Topic category for grouping and filtering test results. Free text — not DB-enforced; these are the conventional values in use.',
    format: 'string | null',
    examples: 'dilution | competitor | first-aid',
  },
  {
    name: 'source_style',
    required: false,
    example: 'How the question was authored — e.g. real_user_pattern',
    help: 'How this question was created or sourced.',
    format: 'string | null',
    examples: 'real_user_pattern | synthetic | generated | manual',
  },
  {
    name: 'expected_concepts',
    required: false,
    example:
      'Key concepts the ideal answer should contain, one per phrase, separated by | — e.g. 13 oz/gal or 100 mL/L | 1:10 with water | 10 minute contact time',
    help: 'All concepts that a complete answer should cover. Stored as a real array (text[], not nullable — defaults to an empty array); enter one phrase per cell segment, pipe-separated.',
    format: 'string[]',
    examples: '13 oz/gal | 1:10 with water | 10 minute contact time',
  },
  {
    name: 'minimum_concepts',
    required: false,
    example: 'Must-have concepts for a passing answer, pipe-separated — e.g. 13 oz/gal | 10 minute contact time',
    help: 'The minimum concepts required for an acceptable answer. Stored as a real array (text[], not nullable — defaults to an empty array); enter one phrase per cell segment, pipe-separated.',
    format: 'string[]',
    examples: '13 oz/gal | 10 minute contact time',
  },
  {
    name: 'expected_sources',
    required: false,
    example:
      'Comma-separated rag.document.id values the answer should be grounded in — e.g. 6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40, 3a91f2de-11c4-4c6f-9f2b-7d0e5a4c8b13',
    help: 'Document IDs (rag.document.id UUIDs) the answer should be grounded in. Stored as a real array (uuid[], not nullable — defaults to an empty array); enter as comma- or pipe-separated UUIDs in one cell.',
    format: 'string[]',
    examples: '6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40 | 6f0c3f1a-6b2a-4a1e-9d3c-2f5b8e7a1c40,3a91f2de-11c4-4c6f-9f2b-7d0e5a4c8b13',
  },
  {
    name: 'should_cite',
    required: false,
    example: 'Should the answer cite sources? yes/no (stored true/false)',
    help: 'Whether the answer is expected to cite its sources.',
    format: 'boolean | null',
    examples: 'yes | true | 1 | no | false | 0',
  },
  {
    name: 'expected_tool',
    required: false,
    example:
      'Function tool this question should route to, e.g. get_efficacy_data (see ~/lib/tools/tool-schemas.ts PRODUCT_TOOL_NAMES)',
    help: 'The tool this question should trigger. One of the 14 product-support function tools (PRODUCT_TOOL_NAMES in ~/lib/tools/tool-schemas.ts).',
    format: 'string | null',
    examples: 'search_product_docs | get_efficacy_data | lookup_cross_reference',
  },
  {
    name: 'expected_surface_type',
    required: false,
    example: 'Ground-truth surface type this question is about, e.g. tile',
    help: 'The surface type this question is about.',
    format: 'string | null',
    examples: 'tile | wood | concrete | carpet | laminate',
  },
  {
    name: 'expected_brand_family',
    required: false,
    example: 'Ground-truth brand family: betco | basic_coatings | envirozyme | 1950 | competitor',
    help: 'The brand family this question is about.',
    format: "'betco' | 'basic_coatings' | 'envirozyme' | '1950' | 'competitor' | null",
    examples: 'betco | basic_coatings | competitor',
  },
  {
    name: 'expected_setting',
    required: false,
    example: 'Ground-truth use setting: commercial | residential',
    help: 'The use setting this question is about.',
    format: "'commercial' | 'residential' | null",
    examples: 'commercial | residential',
  },
  {
    name: 'multi_turn_json',
    required: false,
    example:
      '{"version":1,"title":"Follow-up keeps the product","turns":[{"prompt":"What is pH7Q used for?"},{"prompt":"Is it safe on sealed concrete?","expectations":{"should_answer":true}}],"assertions":[{"type":"context_carry","from_turn":1,"turn":2,"anchor":"pH7Q"}]}',
    help: 'A multi-turn scenario for conversation-style testing (2+ turns in one dialog).',
    format: 'JSON object | null',
    examples: 'See template download for full schema',
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
