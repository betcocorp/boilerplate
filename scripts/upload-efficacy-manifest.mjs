/**
 * B0-226 — Uploads the B0-223 version table and B0-225 legacy reconciliation
 * deliverables to S3 alongside the existing efficacy/raw/ and
 * efficacy/markdown/ tiers, under a new efficacy/manifest/ prefix.
 *
 * Uses the SAME generic bucket/credentials already in .env.local
 * (AWS_S3_BUCKET_NAME / AWS_ACCESS_WRITE_KEY_ID / AWS_SECRET_WRITE_ACCESS_KEY
 * / AWS_REGION) that the rest of this batch's scripts use for reads — no new
 * env vars needed (see the B0-226 findings in the task report for why).
 *
 * Usage: node --env-file=.env.local scripts/upload-efficacy-manifest.mjs [--dry-run]
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const MANIFEST_PREFIX = 'efficacy/manifest/';

const FILES = [
  { local: 'src/lib/training/efficacy-version-table.json', contentType: 'application/json' },
  { local: 'src/lib/training/efficacy-version-table.csv', contentType: 'text/csv' },
  { local: 'src/lib/training/efficacy-raw-pdf-duplicates.json', contentType: 'application/json' },
  { local: 'src/lib/training/efficacy-markdown-enrichment-report.json', contentType: 'application/json' },
  { local: 'src/lib/training/efficacy-legacy-reconciliation.json', contentType: 'application/json' },
  { local: 'src/lib/training/efficacy-legacy-reconciliation.md', contentType: 'text/markdown' },
];

function getS3Client() {
  const region = process.env.AWS_REGION?.trim();
  const accessKeyId = process.env.AWS_ACCESS_WRITE_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_WRITE_ACCESS_KEY?.trim();
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS_REGION / AWS_ACCESS_WRITE_KEY_ID / AWS_SECRET_WRITE_ACCESS_KEY in .env.local');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function getBucket() {
  const bucket = process.env.AWS_S3_BUCKET_NAME?.trim();
  if (!bucket) throw new Error('Missing AWS_S3_BUCKET_NAME in .env.local');
  return bucket;
}

async function main() {
  const bucket = getBucket();
  const client = getS3Client();

  for (const { local, contentType } of FILES) {
    const path = resolve(REPO_ROOT, local);
    const body = readFileSync(path);
    const key = `${MANIFEST_PREFIX}${local.split('/').pop()}`;
    console.log(`${DRY_RUN ? '[dry-run] would upload' : 'uploading'} s3://${bucket}/${key} (${body.length} bytes)`);
    if (!DRY_RUN) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    }
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
