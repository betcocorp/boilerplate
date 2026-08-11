/**
 * One-off script: import a test dataset CSV into public.tests + public.test_items.
 * Usage: node scripts/import-test-csv.mjs <path-to-csv> <"Test Name"> [intended_agent]
 * Example: node scripts/import-test-csv.mjs "C:\...\product_catalog_specialist_200.csv" "Product Catalog Specialist — 200" product
 */
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
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

// ── Args ─────────────────────────────────────────────────────────────────────
const [, , csvPath, testName, intendedAgent = 'product'] = process.argv;
if (!csvPath || !testName) {
  console.error('Usage: node scripts/import-test-csv.mjs <csvPath> <"Test Name"> [agent]');
  process.exit(1);
}

// ── Parse CSV ────────────────────────────────────────────────────────────────
function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseShouldAnswer(value) {
  const v = asTrimmedString(value).toLowerCase();
  if (['yes', 'true', '1'].includes(v)) return true;
  if (['no', 'false', '0'].includes(v)) return false;
  return null;
}

/** Mirrors parsePriority in src/lib/tests/csv.ts — int2 range, integers only. */
function parsePriority(value) {
  const v = asTrimmedString(value);
  if (!/^[+-]?\d+$/.test(v)) return null;
  const parsed = Number.parseInt(v, 10);
  if (parsed < -32768 || parsed > 32767) return null;
  return parsed;
}

const csvContent = readFileSync(csvPath, 'utf-8');
const records = parse(csvContent, {
  columns: true,
  skip_empty_lines: true,
  relax_column_count: true,
  trim: true,
});

// Keep in sync with TYPED_CSV_COLUMNS in src/lib/tests/csv.ts.
const PRIMARY_COLS = new Set([
  'question', 'prompt', 'test_prompt',
  'should_answer', 'expected_result_type', 'canonical_product', 'reason_code',
  'priority', 'ideal_response',
  'expected_concepts', 'minimum_concepts', 'expected_sources', 'should_cite',
]);
const PAYLOAD_COLS = new Set(['product_mention', 'question_category', 'source_style']);

const rows = records
  .map((record, index) => {
    const prompt =
      asTrimmedString(record.question) ||
      asTrimmedString(record.prompt) ||
      asTrimmedString(record.test_prompt);
    if (!prompt) return null;

    const inputPayload = {};
    const metadata = {};
    for (const [key, value] of Object.entries(record)) {
      const k = key.trim();
      const v = asTrimmedString(value);
      if (!k || !v || PRIMARY_COLS.has(k)) continue;
      if (PAYLOAD_COLS.has(k)) { inputPayload[k] = v; continue; }
      metadata[k] = v;
    }

    return {
      row_index: index + 1,
      prompt,
      expected_should_answer: parseShouldAnswer(record.should_answer),
      expected_result_type: asTrimmedString(record.expected_result_type) || null,
      expected_canonical_product: asTrimmedString(record.canonical_product) || null,
      expected_reason_code: asTrimmedString(record.reason_code) || null,
      priority: parsePriority(record.priority),
      ideal_response: asTrimmedString(record.ideal_response) || null,
      // Stored verbatim — never split or reformatted (oz/gal, mL/L, ppm, contact times).
      expected_concepts: asTrimmedString(record.expected_concepts) || null,
      minimum_concepts: asTrimmedString(record.minimum_concepts) || null,
      expected_sources: asTrimmedString(record.expected_sources) || null,
      should_cite: parseShouldAnswer(record.should_cite),
      input_payload: inputPayload,
      metadata,
    };
  })
  .filter(Boolean);

console.log(`Parsed ${rows.length} rows from CSV.`);

// ── Create test record ────────────────────────────────────────────────────────
const fileName = csvPath.split(/[\\/]/).pop();
const { data: testRecord, error: testError } = await supabase
  .from('tests')
  .insert({
    name: testName,
    source_file_name: fileName,
    source_bucket: 'ad-hoc',
    source_key: `ad-hoc/${fileName}`,
    row_count: rows.length,
    status: 'ready',
    intended_agent: intendedAgent || null,
    metadata: { column_names: Object.keys(records[0] || {}), content_type: 'text/csv' },
  })
  .select('id')
  .single();

if (testError || !testRecord) {
  console.error('Failed to create test record:', testError);
  process.exit(1);
}

const testId = testRecord.id;
console.log(`Created test record id=${testId}`);

// ── Insert test items in batches of 250 ──────────────────────────────────────
const items = rows.map((r) => ({ ...r, test_id: testId }));
const BATCH = 250;
let inserted = 0;
for (let i = 0; i < items.length; i += BATCH) {
  const batch = items.slice(i, i + BATCH);
  const { error } = await supabase.from('test_items').insert(batch);
  if (error) {
    console.error(`Batch ${i}–${i + batch.length} failed:`, error);
    process.exit(1);
  }
  inserted += batch.length;
  console.log(`  Inserted ${inserted}/${items.length}`);
}

console.log(`\nDone. Test "${testName}" created with ${inserted} items.`);
console.log(`Test ID: ${testId}`);
