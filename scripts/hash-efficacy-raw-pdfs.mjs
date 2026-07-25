/**
 * B0-224 supplementary finding — SHA-256 hashes every raw efficacy lab-report
 * PDF (s3://<AWS_S3_BUCKET_NAME>/efficacy/raw/**\/*.pdf) and records which of
 * the 70 files are byte-for-byte identical duplicates filed redundantly
 * under more than one formula's folder.
 *
 * Why this matters: the Master Efficacy Version Data workbook lists several
 * lab projects as combined multi-formula panels (e.g. project A17851 covers
 * M000141/M000751/M000752/M000759 "Version 0" all in one submission). This
 * confirms that with hard evidence — 70 raw PDFs resolve to only 50 unique
 * documents — rather than leaving it as a filename-based inference.
 *
 * Usage: node --env-file=.env.local scripts/hash-efficacy-raw-pdfs.mjs
 * Writes src/lib/training/efficacy-raw-pdf-duplicates.json.
 */

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dir, '../src/lib/training/efficacy-raw-pdf-duplicates.json');

function getS3Client() {
  const region = process.env.AWS_REGION?.trim();
  const accessKeyId = process.env.AWS_ACCESS_READ_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_READ_ACCESS_KEY?.trim();
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS_REGION / AWS_ACCESS_READ_KEY_ID / AWS_SECRET_READ_ACCESS_KEY in .env.local');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

const bucket = process.env.AWS_S3_BUCKET_NAME?.trim();
const client = getS3Client();

async function listAllPdfKeys(prefix) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    for (const obj of res.Contents ?? []) if (obj.Key && /\.pdf$/i.test(obj.Key)) keys.push(obj.Key);
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

async function main() {
  const keys = await listAllPdfKeys('efficacy/raw/');
  console.log(`Hashing ${keys.length} raw PDF(s)...`);

  const hashToKeys = new Map();
  for (const key of keys) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const hash = createHash('sha256');
    for await (const chunk of res.Body) hash.update(chunk);
    const digest = hash.digest('hex');
    if (!hashToKeys.has(digest)) hashToKeys.set(digest, []);
    hashToKeys.get(digest).push(key);
  }

  const duplicateGroups = [...hashToKeys.entries()]
    .filter(([, ks]) => ks.length > 1)
    .map(([hash, ks]) => ({ sha256: hash, keys: ks }));

  const output = {
    generated_at: new Date().toISOString(),
    total_raw_pdfs: keys.length,
    unique_content_hashes: hashToKeys.size,
    duplicate_groups: duplicateGroups,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`total=${keys.length} unique=${hashToKeys.size} duplicate_groups=${duplicateGroups.length}`);
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
