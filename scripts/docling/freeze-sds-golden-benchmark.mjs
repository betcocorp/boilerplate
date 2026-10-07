#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const WORKSPACE_ROOT = path.resolve(REPOSITORY_ROOT, '../..');
const GOLDEN_ROOT = path.join(WORKSPACE_ROOT, '.workspace/golden-datasets');
const OUTPUT_PATH = path.join(
  REPOSITORY_ROOT,
  'scripts/docling/fixtures/sds-golden-benchmark.json',
);
const DATASET_FILES = [
  'Dilution Control FastDraw Specialist Golden Dataset 216_with_expected_mappings.csv',
  'Product Specialist Golden Dataset 250_with_expected_mappings.csv',
  'Restroom Cleaning Specialist Golden Dataset 250_with_expected_mappings.csv',
  'SportsZone Specialist Golden Dataset 250_with_expected_mappings.csv',
  'VCT Specialist Golden Dataset 249_with_expected_mappings.csv',
];
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseEnv(filePath) {
  return Object.fromEntries(
    fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [
          line.slice(0, separator),
          line.slice(separator + 1).replace(/^['"]|['"]$/g, ''),
        ];
      }),
  );
}

function readDatasets() {
  const references = new Map();
  const datasets = [];
  for (const file of DATASET_FILES) {
    const filePath = path.join(GOLDEN_ROOT, file);
    const workbook = XLSX.readFile(filePath);
    const rows = XLSX.utils.sheet_to_json(
      workbook.Sheets[workbook.SheetNames[0]],
      { defval: '' },
    );
    let referenceOccurrences = 0;
    const uniqueIds = new Set();
    for (const row of rows) {
      const matches = String(row['Expected References/Sources'] ?? '').match(UUID_PATTERN) ?? [];
      matches.forEach((rawId, index) => {
        const id = rawId.toLowerCase();
        referenceOccurrences += 1;
        uniqueIds.add(id);
        const occurrences = references.get(id) ?? [];
        occurrences.push({
          dataset: file,
          testId: String(row.ID),
          question: String(row.Question),
          referenceIndex: index + 1,
        });
        references.set(id, occurrences);
      });
    }
    datasets.push({
      path: `.workspace/golden-datasets/${file}`,
      sha256: sha256(filePath),
      rows: rows.length,
      referenceOccurrences,
      uniqueDocumentIds: uniqueIds.size,
    });
  }
  return { datasets, references };
}

async function selectAllDocuments(client, ids) {
  const documents = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const { data, error } = await client
      .from('document')
      .select('id,title,document_kind,source_record_id,is_current,lifecycle_status,metadata')
      .in('id', batch);
    if (error) throw error;
    documents.push(...data);
  }
  return documents;
}

async function main() {
  const { datasets, references } = readDatasets();
  const ids = [...references.keys()].sort();
  const env = parseEnv(path.join(REPOSITORY_ROOT, '.env.local'));
  const client = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { db: { schema: 'rag' }, auth: { persistSession: false } },
  );
  const documents = await selectAllDocuments(client, ids);
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const missingIds = ids.filter((id) => !documentsById.has(id));
  if (missingIds.length) {
    throw new Error(`Expected document IDs missing from rag.document: ${missingIds.join(', ')}`);
  }

  const kindCounts = Object.fromEntries(
    [
      ...[...documents]
        .reduce((counts, document) => {
          counts.set(document.document_kind, (counts.get(document.document_kind) ?? 0) + 1);
          return counts;
        }, new Map())
        .entries(),
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
  const sdsDocuments = documents
    .filter((document) => document.document_kind === 'sds')
    .sort((left, right) => left.id.localeCompare(right.id));
  const sourceRecordIds = sdsDocuments.map((document) => document.source_record_id);
  const { data: sourceRecords, error: sourceError } = await client
    .from('source_record')
    .select('id,is_active,source_uri')
    .in('id', sourceRecordIds);
  if (sourceError) throw sourceError;
  const sourcesById = new Map(sourceRecords.map((source) => [source.id, source]));

  const benchmarkDocuments = sdsDocuments.map((document) => {
    const source = sourcesById.get(document.source_record_id);
    if (!source) throw new Error(`Missing source record ${document.source_record_id}`);
    if (!source.source_uri.startsWith('s3://betco-sds/')) {
      throw new Error(`Unsupported SDS source URI: ${source.source_uri}`);
    }
    const key = source.source_uri.slice('s3://betco-sds/'.length);
    const localPath = `dump/sds/${key}`;
    const absolutePath = path.join(WORKSPACE_ROOT, localPath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Local benchmark PDF is missing: ${localPath}`);
    }
    return {
      documentId: document.id,
      title: document.title,
      documentKind: document.document_kind,
      documentState: {
        isCurrent: document.is_current,
        lifecycleStatus: document.lifecycle_status,
      },
      sourceRecordId: document.source_record_id,
      sourceActive: source.is_active,
      sourceUri: source.source_uri,
      localPdfPath: localPath,
      pdfSha256: sha256(absolutePath),
      pdfBytes: fs.statSync(absolutePath).size,
      references: references.get(document.id),
    };
  });

  const manifest = {
    schema: 'sds-golden-benchmark/v1',
    benchmarkId: 'full-golden-expected-sds-v1',
    scope: {
      canonicalDatasets: 'five full CSV datasets',
      excludes: ['XLSX duplicates', 'derived top-25 datasets'],
      selection: 'Every expected document UUID was resolved through local rag.document; all documents with document_kind=sds are included.',
    },
    datasets,
    expectedDocumentSummary: {
      testRows: datasets.reduce((sum, dataset) => sum + dataset.rows, 0),
      referenceOccurrences: datasets.reduce(
        (sum, dataset) => sum + dataset.referenceOccurrences,
        0,
      ),
      uniqueDocumentIds: ids.length,
      missingDocumentIds: [],
      documentKindCounts: kindCounts,
      selectedSdsDocuments: benchmarkDocuments.length,
      selectedSdsReferenceOccurrences: benchmarkDocuments.reduce(
        (sum, document) => sum + document.references.length,
        0,
      ),
    },
    documents: benchmarkDocuments,
  };
  const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  if (process.argv.includes('--check')) {
    const existing = fs.readFileSync(OUTPUT_PATH, 'utf8');
    if (existing !== rendered) {
      throw new Error(`Frozen benchmark differs from ${path.relative(REPOSITORY_ROOT, OUTPUT_PATH)}`);
    }
    console.log(`verified ${benchmarkDocuments.length} SDS documents from ${ids.length} expected document IDs`);
    return;
  }
  fs.writeFileSync(OUTPUT_PATH, rendered);
  console.log(`froze ${benchmarkDocuments.length} SDS documents from ${ids.length} expected document IDs`);
}

await main();
