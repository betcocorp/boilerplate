/**
 * B0-636 — one-off seed: golden eval coverage for the new `dispensing-systems`
 * prompt_category, sourced from the FastDraw dilution/yield seed data
 * (`fastdraw_dilutions_final (Barry version).xlsx` — 40 SKUs, minus the 2
 * skipped below with no rag.entity yet).
 *
 * Inserts directly into public.tests + public.test_items via the Supabase
 * client (NOT scripts/import-test-csv.mjs — that script only writes a
 * `question_category` into the input_payload jsonb catch-all, it never
 * populates the typed `prompt_category` column, which would defeat this
 * work). `prompt_category` is set explicitly on every row so the
 * `test_items_auto_classify` trigger (fires only when prompt_category IS
 * NULL — see 20260527120000_prompt_category_on_test_items.sql) never
 * overwrites it with a keyword-matched 'dilution' guess.
 *
 * Values below are transcribed verbatim from the seed file — never rounded,
 * converted, or inferred (regulated dilution/yield data).
 *
 * Usage: node scripts/seed-fastdraw-golden-tests.mjs
 * Safe to re-run: creates a new `tests` row each time (mirrors
 * import-test-csv.mjs's create-per-run pattern) — don't re-run casually.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// ── Load .env.local ──────────────────────────────────────────────────────────
const envContent = readFileSync(new URL('../.env.local', import.meta.url), 'utf-8');
const env = Object.fromEntries(
  envContent
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    }),
);

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

// ── Golden rows ──────────────────────────────────────────────────────────────
// Each entry below is a tier-1 expectation in the pre-B0-940 `expected_criteria` jsonb shape,
// e.g. [{ "tier": 1, "match": "exact", "concept": "6 oz" }]. That column is gone; the literal is
// kept in this shape ON PURPOSE and converted at insert time (see `toMinimumConcepts`) so no
// regulated dilution value or gallon yield is ever retyped by hand during the migration.
const SOURCE_NOTE = 'FastDraw dispensing seed (B0-636) — "fastdraw_dilutions_final (Barry version).xlsx"';

const ROWS = [
  // ── Dilution-only ──────────────────────────────────────────────────────────
  {
    prompt: "What's the dilution ratio for AF79 Concentrate Restroom Cleaner in FastDraw?",
    expected_criteria: [{ tier: 1, match: 'exact', concept: '1:64' }],
  },
  {
    prompt: 'What is the FastDraw dilution ratio for pH7 ULTRA Floor Cleaner?',
    expected_criteria: [{ tier: 1, match: 'exact', concept: '1:256' }],
  },
  {
    prompt: "What's the dilution ratio for AF315 Disinfectant in the FastDraw system?",
    expected_criteria: [{ tier: 1, match: 'exact', concept: '1:32' }],
  },
  {
    prompt: 'In FastDraw, what dilution ratio does TOP FLITE All Purpose Cleaner use?',
    expected_criteria: [{ tier: 1, match: 'exact', concept: '1:64' }],
  },
  {
    prompt: "What's the FastDraw dilution ratio for GREEN EARTH VELOCITY Degreaser?",
    expected_criteria: [{ tier: 1, match: 'exact', concept: '1:20' }],
  },
  // ── Yield-only ─────────────────────────────────────────────────────────────
  {
    prompt: 'How many gallons do I get from a 2-liter FastDraw bottle of pH7 ULTRA?',
    expected_criteria: [{ tier: 1, match: 'exact', concept: '136 gallons' }],
  },
  {
    prompt: 'How many gallons of RTU solution does a 2-liter FastDraw bottle of AF315 Disinfectant yield?',
    expected_criteria: [{ tier: 1, match: 'exact', concept: '17 gallons' }],
  },
  {
    prompt: "What's the gallon yield from a 2-liter FastDraw bottle of SYMPLICITY CITRUSUDS Dish and Pan Detergent?",
    expected_criteria: [{ tier: 1, match: 'exact', concept: '338 gallons' }],
  },
  {
    prompt: 'How many gallons does a 2-liter FastDraw bottle of EXTREME ULTRA Floor Stripper make?',
    expected_criteria: [{ tier: 1, match: 'exact', concept: '11 gallons' }],
  },
  // ── Combined (dilution + yield) ──────────────────────────────────────────
  {
    prompt:
      "What's the dilution ratio and gallon yield for a 2-liter FastDraw bottle of pH7Q DUAL Disinfectant Cleaner Deodorizer?",
    expected_criteria: [
      { tier: 1, match: 'exact', concept: '1:256' },
      { tier: 1, match: 'exact', concept: '136 gallons' },
    ],
  },
  {
    prompt:
      "For DENSICLEAN Polished Concrete Cleaner in FastDraw, what's the dilution ratio and how many gallons does a 2-liter bottle yield?",
    expected_criteria: [
      { tier: 1, match: 'exact', concept: '1:256' },
      { tier: 1, match: 'exact', concept: '136 gallons' },
    ],
  },
  {
    prompt: 'What dilution ratio and yield does TRIFORCE Disinfectant use in a FastDraw dispenser?',
    expected_criteria: [
      { tier: 1, match: 'exact', concept: '1:256' },
      { tier: 1, match: 'exact', concept: '136 gallons' },
    ],
  },
  // ── Dual-ratio SKUs (general dilution vs. spray_dilution both present in the
  // seed row) — the closest verifiable proxy available for testing that the
  // FastDraw-specific answer wins over a single generic ratio. NOTE: the seed
  // file has no `conflicts_with_legacy_dilution_code` column, so these are not
  // confirmed against that flag — see report for the flagged gap. ──────────
  {
    prompt: "What's the spray dilution for PUSH Lemon & Sage?",
    expected_criteria: [
      { tier: 1, match: 'exact', concept: '1:20' },
      {
        tier: 1,
        match: 'semantic',
        concept:
          'the answer gives the FastDraw spray dilution (1:20), not the general FastDraw dilution ratio (1:64) for the same product',
      },
    ],
  },
  {
    prompt:
      "In FastDraw, what's the spray dilution ratio for CITRUS CHISEL Degreaser, and how is that different from its general dilution?",
    expected_criteria: [
      { tier: 1, match: 'exact', concept: '1:20' },
      { tier: 1, match: 'exact', concept: '1:64' },
      {
        tier: 1,
        match: 'semantic',
        concept:
          'the answer distinguishes the spray dilution (1:20, 11 gallon yield per 2L) from the general dilution (1:64, 34 gallon yield per 2L)',
      },
    ],
  },
];

const testName = 'FastDraw Dispensing Systems Golden Set (B0-636)';

// ── Create the parent test row ────────────────────────────────────────────────
const { data: testRecord, error: testError } = await supabase
  .from('tests')
  .insert({
    name: testName,
    source_file_name: 'fastdraw_dilutions_final (Barry version).xlsx',
    source_bucket: 'ad-hoc',
    source_key: 'ad-hoc/fastdraw_dilutions_final (Barry version).xlsx',
    row_count: ROWS.length,
    status: 'ready',
    intended_agent: 'dilution',
    is_golden: true,
    metadata: {
      seed_script: 'scripts/seed-fastdraw-golden-tests.mjs',
      jira: 'B0-636',
      source_note: SOURCE_NOTE,
    },
  })
  .select('id')
  .single();

if (testError || !testRecord) {
  console.error('Failed to create test record:', testError);
  process.exit(1);
}

const testId = testRecord.id;
console.log(`Created test record "${testName}" id=${testId}`);

// ── Insert test items ──────────────────────────────────────────────────────────
/**
 * B0-940 — the tiered `expected_criteria` column is gone, and B0-930 dropped
 * `expected_should_answer`. Tier is now expressed by which column a phrase lives in, and every
 * entry in ROWS is tier 1, so they all become `minimum_concepts` — the must-have list that gates
 * the case. `match: 'exact'` survives as the `exact:` prefix, which routes the phrase to the
 * deterministic literal check in `~/lib/tests/criteria-grader.ts` instead of an LLM's judgement.
 * That matters here: every value in this file is a regulated dilution ratio or gallon yield.
 */
function toMinimumConcepts(criteria) {
  return criteria.map((criterion) => {
    if (criterion.tier !== 1) {
      throw new Error(
        `Only tier-1 entries are supported here; got tier ${criterion.tier} for "${criterion.concept}".`,
      );
    }
    return criterion.match === 'exact' ? `exact: ${criterion.concept}` : criterion.concept;
  });
}

const items = ROWS.map((row, index) => ({
  test_id: testId,
  row_index: index + 1,
  prompt: row.prompt,
  prompt_category: 'dispensing-systems',
  intended_agent_item: 'dilution',
  minimum_concepts: toMinimumConcepts(row.expected_criteria),
  source: SOURCE_NOTE,
  metadata: {},
  input_payload: {},
}));

const { data: inserted, error: insertError } = await supabase
  .from('test_items')
  .insert(items)
  .select('id, prompt, prompt_category, intended_agent_item');

if (insertError) {
  console.error('Failed to insert test items:', insertError);
  process.exit(1);
}

console.log(`Inserted ${inserted.length} test_items rows.`);
for (const row of inserted) {
  console.log(`  ${row.id}  [${row.prompt_category} / ${row.intended_agent_item}]  ${row.prompt}`);
}
console.log(`\nDone. Test ID: ${testId}`);
