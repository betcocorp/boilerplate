import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

import { markdownToPlainText } from '~/lib/rag/markdown-chunking';
import {
  createS3IngestionPipeline,
  type S3IngestionDashboardDocument,
  type S3IngestionDashboardStatus,
  type S3IngestionRunMode,
  type S3IngestionRunResult,
} from '~/lib/rag/s3-ingestion-pipeline';

import {
  EFFICACY_FILE_OVERRIDES,
  EFFICACY_S3_BUCKET_DEFAULT,
  EFFICACY_S3_PREFIX_DEFAULT,
  type EfficacySeedDocument,
} from './manifest';

export type EfficacyDashboardDocument = S3IngestionDashboardDocument;
export type EfficacyDashboardStatus = S3IngestionDashboardStatus;
export type EfficacyIngestionRunMode = S3IngestionRunMode;
export type EfficacyIngestionRunResult = S3IngestionRunResult;

function normalizeRelativePath(value: string) {
  return value.replaceAll('\\', '/').toLowerCase();
}

function inferLocale(relativePath: string) {
  const lower = relativePath.toLowerCase();

  if (
    lower.includes('/fr/') ||
    lower.includes('-fr.md') ||
    lower.includes('(fr).md')
  ) {
    return 'FR';
  }

  if (
    lower.includes('/es/') ||
    lower.includes('/spanish') ||
    lower.includes('-es.md') ||
    lower.includes('(es).md')
  ) {
    return 'ES';
  }

  return 'EN';
}

function inferTitle(fileNameWithoutExtension: string) {
  const normalized = fileNameWithoutExtension
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return normalized || fileNameWithoutExtension;
}

function getS3Bucket() {
  return process.env.AWS_EFFICACY_S3_BUCKET?.trim() || EFFICACY_S3_BUCKET_DEFAULT;
}

function getS3Prefix() {
  const prefix = process.env.EFFICACY_S3_PREFIX?.trim() || EFFICACY_S3_PREFIX_DEFAULT;
  if (!prefix) {
    return '';
  }
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function getAwsCredentials() {
  // Efficacy source files live in the same retool-360 bucket as Knowledge/Labels
  // (see admin/knowledge/pipeline.ts) — prefer the documented AWS_360_* read
  // keys, falling back to the write keys, same as those other pipelines.
  const accessKeyId =
    process.env.AWS_EFFICACY_READ_ACCESS_KEY_ID?.trim() ||
    process.env.AWS_360_READ_ACCESS_KEY_ID?.trim() ||
    process.env.AWS_360_WRITE_ACCESS_KEY_ID?.trim();
  const secretAccessKey =
    process.env.AWS_EFFICACY_READ_SECRET_ACCESS_KEY?.trim() ||
    process.env.AWS_360_READ_SECRET_ACCESS_KEY?.trim() ||
    process.env.AWS_360_WRITE_SECRET_ACCESS_KEY?.trim();

  if (!accessKeyId || !secretAccessKey) {
    return undefined;
  }

  return { accessKeyId, secretAccessKey };
}

function getS3Client() {
  const region =
    process.env.AWS_EFFICACY_REGION?.trim() ||
    process.env.AWS_360_REGION?.trim() ||
    'us-east-1';
  const credentials = getAwsCredentials();
  return new S3Client({
    region,
    ...(credentials ? { credentials } : {}),
  });
}

function keyToRelativePath(s3Key: string, prefix: string) {
  if (prefix && s3Key.startsWith(prefix)) {
    return s3Key.slice(prefix.length);
  }
  if (s3Key.startsWith('efficacy/')) {
    return s3Key.slice('efficacy/'.length);
  }
  return s3Key;
}

async function listS3MarkdownKeys(client: S3Client, bucket: string, prefix: string) {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of page.Contents ?? []) {
      const key = item.Key?.trim();
      if (!key || key.endsWith('/')) {
        continue;
      }
      if (extname(key).toLowerCase() === '.md') {
        keys.push(key);
      }
    }

    continuationToken = page.NextContinuationToken;
  } while (continuationToken);

  keys.sort((left, right) => left.localeCompare(right));
  return keys;
}

async function discoverEfficacySeedDocuments(): Promise<EfficacySeedDocument[]> {
  const bucket = getS3Bucket();
  const prefix = getS3Prefix();
  const client = getS3Client();
  const discoveredKeys = await listS3MarkdownKeys(client, bucket, prefix);

  return discoveredKeys.map((s3Key) => {
    const relativePath = normalizeRelativePath(
      keyToRelativePath(s3Key, prefix),
    );
    const fileName = basename(s3Key);
    const fileNameWithoutExtension = fileName.slice(
      0,
      -extname(fileName).length,
    );
    const override = EFFICACY_FILE_OVERRIDES[relativePath];
    const inferredTitle = inferTitle(fileNameWithoutExtension);
    const locale = (
      override?.locale || inferLocale(relativePath)
    ).toUpperCase();

    return {
      id: createHash('sha1').update(s3Key).digest('hex').slice(0, 20),
      title: override?.title || inferredTitle,
      s3Key,
      locale,
    } satisfies EfficacySeedDocument;
  });
}

// Efficacy documents are markdown-primary (unlike SDS, which is
// PDF-text-primary): the S3 object body is the body_markdown, and body_text
// is a derived plain-text fallback/preview. Frontmatter parsing
// (formula_code/version/project_number extraction from YAML frontmatter) is
// a follow-up once B0-224 lands with real source files to define the exact
// frontmatter shape against — buildDocumentMetadata below is the extension
// point for that.
async function parseEfficacyFile(buffer: Buffer) {
  const bodyMarkdown = buffer.toString('utf-8');
  return { bodyText: markdownToPlainText(bodyMarkdown), bodyMarkdown };
}

const efficacyPipeline = createS3IngestionPipeline<EfficacySeedDocument>({
  sourceSchema: 'efficacy',
  sourceTable: 'document',
  sourceType: 's3_markdown',
  documentKind: 'efficacy',
  sourceLabel: 'efficacy',
  getS3Bucket,
  getS3Prefix,
  getS3Client,
  discoverSeedDocuments: discoverEfficacySeedDocuments,
  parseFile: parseEfficacyFile,
  // No frontmatter parser yet — see comment above. Once B0-224 lands, extract
  // formula_code/version/project_number here.
  buildDocumentMetadata: () => ({}),
});

export const getEfficacyDashboardStatus = efficacyPipeline.getDashboardStatus;
export const runEfficacyIngestion = efficacyPipeline.runIngestion;
