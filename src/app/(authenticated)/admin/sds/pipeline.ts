import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createS3IngestionPipeline,
  type S3IngestionDashboardDocument,
  type S3IngestionDashboardStatus,
  type S3IngestionRunMode,
  type S3IngestionRunResult,
} from '~/lib/rag/s3-ingestion-pipeline';

import {
  SDS_FILE_OVERRIDES,
  SDS_S3_BUCKET_DEFAULT,
  SDS_S3_PREFIX_DEFAULT,
  type SdsSeedDocument,
} from './manifest';

export type SdsDashboardDocument = S3IngestionDashboardDocument;
export type SdsDashboardStatus = S3IngestionDashboardStatus;
export type SdsIngestionRunMode = S3IngestionRunMode;
export type SdsIngestionRunResult = S3IngestionRunResult;

function normalizeRelativePath(value: string) {
  return value.replaceAll('\\', '/').toLowerCase();
}

function inferLocale(relativePath: string) {
  const lower = relativePath.toLowerCase();

  if (
    lower.includes('/fr/') ||
    lower.includes('-fr.pdf') ||
    lower.includes('(fr).pdf')
  ) {
    return 'FR';
  }

  if (
    lower.includes('/es/') ||
    lower.includes('/spanish') ||
    lower.includes('-es.pdf') ||
    lower.includes('(es).pdf')
  ) {
    return 'ES';
  }

  return 'EN';
}

function inferProductCode(fileName: string) {
  const match = fileName.match(/([a-z]{0,4}\d{2,}[a-z0-9-]*)/i);
  return match?.[1]?.toUpperCase() ?? null;
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
  return process.env.AWS_S3_BUCKET_NAME?.trim() || SDS_S3_BUCKET_DEFAULT;
}

function getS3Prefix() {
  const prefix = process.env.SDS_S3_PREFIX?.trim() || SDS_S3_PREFIX_DEFAULT;
  if (!prefix) {
    return '';
  }
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function getAwsCredentials() {
  const accessKeyId = process.env.AWS_SDS_READ_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SDS_READ_SECRET_ACCESS_KEY?.trim();

  if (!accessKeyId || !secretAccessKey) {
    return undefined;
  }

  return { accessKeyId, secretAccessKey };
}

function getS3Client() {
  const region = process.env.AWS_SDS_REGION?.trim() || 'us-east-2';
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
  if (s3Key.startsWith('sds/')) {
    return s3Key.slice('sds/'.length);
  }
  return s3Key;
}

async function listS3PdfKeys(client: S3Client, bucket: string, prefix: string) {
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
      if (extname(key).toLowerCase() === '.pdf') {
        keys.push(key);
      }
    }

    continuationToken = page.NextContinuationToken;
  } while (continuationToken);

  keys.sort((left, right) => left.localeCompare(right));
  return keys;
}

async function discoverSdsSeedDocuments(): Promise<SdsSeedDocument[]> {
  const bucket = getS3Bucket();
  const prefix = getS3Prefix();
  const client = getS3Client();
  const discoveredKeys = await listS3PdfKeys(client, bucket, prefix);

  return discoveredKeys.map((s3Key) => {
    const relativePath = normalizeRelativePath(
      keyToRelativePath(s3Key, prefix),
    );
    const fileName = basename(s3Key);
    const fileNameWithoutExtension = fileName.slice(
      0,
      -extname(fileName).length,
    );
    const override = SDS_FILE_OVERRIDES[relativePath];
    const inferredTitle = inferTitle(fileNameWithoutExtension);
    const inferredProductCode = inferProductCode(fileNameWithoutExtension);
    const locale = (
      override?.locale || inferLocale(relativePath)
    ).toUpperCase();

    return {
      id: createHash('sha1').update(s3Key).digest('hex').slice(0, 20),
      title: override?.title || inferredTitle,
      productCode: override?.productCode || inferredProductCode,
      s3Key,
      locale,
    } satisfies SdsSeedDocument;
  });
}

function normalizePdfText(rawText: string) {
  return rawText
    .replaceAll('\r', '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function parsePdf(buffer: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const standardFontDataUrl = pathToFileURL(
    join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/'),
  ).href;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl,
  });
  const pdfDocument = await loadingTask.promise;
  const pageCount = pdfDocument.numPages;
  const pageTexts: string[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const content = await page.getTextContent();
    const textParts: string[] = [];

    for (const item of content.items) {
      if (typeof item === 'object' && item !== null && 'str' in item) {
        const candidate = (item as { str?: unknown }).str;
        if (typeof candidate === 'string' && candidate.trim()) {
          textParts.push(candidate);
        }
      }
    }

    pageTexts.push(textParts.join(' '));
    page.cleanup();
  }
  await pdfDocument.destroy();

  const text = normalizePdfText(pageTexts.join('\n\n'));

  if (!text) {
    throw new Error('PDF parsing returned empty text.');
  }

  return {
    text,
    numPages: pageCount > 0 ? pageCount : null,
  };
}

async function parseSdsFile(buffer: Buffer) {
  const parsed = await parsePdf(buffer);
  return { bodyText: parsed.text, bodyMarkdown: null };
}

const sdsPipeline = createS3IngestionPipeline<SdsSeedDocument>({
  sourceSchema: 'sds',
  sourceTable: 'sheet',
  sourceType: 's3_pdf',
  documentKind: 'sds',
  sourceLabel: 'SDS',
  getS3Bucket,
  getS3Prefix,
  getS3Client,
  discoverSeedDocuments: discoverSdsSeedDocuments,
  parseFile: parseSdsFile,
  buildDocumentMetadata: (seed) => ({ product_code: seed.productCode }),
});

export const getSdsDashboardStatus = sdsPipeline.getDashboardStatus;
export const runSdsIngestion = sdsPipeline.runIngestion;
