import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
import { parseSdsMarkdownManifest } from '~/lib/rag/sds-markdown';

import {
  SDS_FILE_OVERRIDES,
  SDS_MARKDOWN_PREFIX_DEFAULT,
  SDS_SOURCE_BUCKET,
  type SdsSeedDocument,
} from './manifest';
import { evaluateSdsContentLanguage, evaluateSdsPolicy } from './policy';

export type SdsDashboardDocument = S3IngestionDashboardDocument;
export type SdsDashboardStatus = S3IngestionDashboardStatus;
export type SdsIngestionRunMode = S3IngestionRunMode;
export type SdsIngestionRunResult = S3IngestionRunResult;

type SdsCandidate = { seed: SdsSeedDocument; relativePath: string };

function logSdsDiscovery(event: string, details: Record<string, unknown>) {
  console.info(
    JSON.stringify({
      level: 'info',
      event: `sds.ingestion.${event}`,
      ...details,
    }),
  );
}

function isDetailedDiscoveryLoggingEnabled() {
  return process.env.BEX_SDS_INGESTION_DEBUG?.trim().toLowerCase() === 'true';
}

function normalizeRelativePath(value: string) {
  return value.replaceAll('\\', '/').toLowerCase();
}

function inferLocale(relativePath: string) {
  const lower = relativePath.toLowerCase();
  if (lower.includes('/fr/') || lower.includes('-fr.pdf') || lower.includes('(fr).pdf')) {
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

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for SDS markdown ingestion.`);
  return value;
}

function getS3Bucket() {
  return requiredEnv('BEX_S3_BUCKET_NAME');
}

function getS3Prefix() {
  const prefix =
    process.env.BEX_SDS_MARKDOWN_PREFIX?.trim() || SDS_MARKDOWN_PREFIX_DEFAULT;
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function getManifestKey() {
  return `${getS3Prefix()}manifest.csv`;
}

function getS3Client() {
  return new S3Client({
    region: process.env.BEX_S3_REGION?.trim() || "us-east-1",
    credentials: {
      accessKeyId: requiredEnv("BEX_S3_READ_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("BEX_S3_READ_SECRET_ACCESS_KEY"),
    },
  });
}

async function readS3Text(client: S3Client, bucket: string, key: string) {
  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await object.Body?.transformToString('utf-8');
  if (!text?.trim()) throw new Error(`S3 object was empty: s3://${bucket}/${key}`);
  return text;
}

async function discoverAllSdsCandidates(): Promise<SdsCandidate[]> {
  const client = getS3Client();
  const bucket = getS3Bucket();
  const prefix = getS3Prefix();
  const manifestKey = getManifestKey();
  const manifest = parseSdsMarkdownManifest(
    await readS3Text(client, bucket, manifestKey),
  );
  logSdsDiscovery('manifest_loaded', {
    bucket,
    prefix,
    manifestKey,
    manifestRows: manifest.length,
  });

  return manifest.map((row) => {
    const relativePath = normalizeRelativePath(row.sourcePdfKey);
    const fileName = basename(row.sourcePdfKey);
    const fileNameWithoutExtension = fileName.slice(0, -extname(fileName).length);
    const override = SDS_FILE_OVERRIDES[relativePath];
    const locale = (override?.locale || inferLocale(relativePath)).toUpperCase();

    return {
      seed: {
        id: createHash('sha1').update(row.sourcePdfKey).digest('hex').slice(0, 20),
        documentId: row.documentId,
        title: override?.title || inferTitle(fileNameWithoutExtension),
        productCode: override?.productCode || inferProductCode(fileNameWithoutExtension),
        s3Key: `${getS3Prefix()}${row.markdownPath}`,
        sourcePdfKey: row.sourcePdfKey,
        locale,
      },
      relativePath,
    };
  });
}

async function discoverSdsSeedDocuments(): Promise<SdsSeedDocument[]> {
  const candidates = await discoverAllSdsCandidates();
  const included: SdsSeedDocument[] = [];
  const excludedByReason: Record<string, number> = {};
  const detailed = isDetailedDiscoveryLoggingEnabled();

  for (const { seed, relativePath } of candidates) {
    const decision = evaluateSdsPolicy(relativePath, seed.locale);
    if (decision.inScope) {
      included.push(seed);
      if (detailed) {
        logSdsDiscovery('candidate_included', {
          documentId: seed.documentId,
          sourcePdfKey: seed.sourcePdfKey,
          markdownS3Key: seed.s3Key,
          locale: seed.locale,
        });
      }
      continue;
    }

    const reason = `${decision.reason}:${decision.matched}`;
    excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
    if (detailed) {
      logSdsDiscovery('candidate_excluded', {
        documentId: seed.documentId,
        sourcePdfKey: seed.sourcePdfKey,
        markdownS3Key: seed.s3Key,
        locale: seed.locale,
        reason: decision.reason,
        matched: decision.matched,
      });
    }
  }

  logSdsDiscovery('policy_summary', {
    manifestRows: candidates.length,
    included: included.length,
    excluded: candidates.length - included.length,
    excludedByReason,
  });
  return included;
}

export type SdsDiscoveryReport = {
  totalDiscovered: number;
  inScope: number;
  excludedByReason: Record<string, number>;
};

export async function getSdsDiscoveryReport(): Promise<SdsDiscoveryReport> {
  const candidates = await discoverAllSdsCandidates();
  const excludedByReason: Record<string, number> = {};
  let inScope = 0;

  for (const { seed, relativePath } of candidates) {
    const decision = evaluateSdsPolicy(relativePath, seed.locale);
    if (decision.inScope) inScope += 1;
    else {
      const key = `${decision.reason}:${decision.matched}`;
      excludedByReason[key] = (excludedByReason[key] ?? 0) + 1;
    }
  }

  return { totalDiscovered: candidates.length, inScope, excludedByReason };
}

async function parseSdsFile(buffer: Buffer, seed: SdsSeedDocument) {
  const bodyMarkdown = buffer.toString('utf8').trim();
  if (!bodyMarkdown) throw new Error('Markdown object contained no text.');
  const bodyText = markdownToPlainText(bodyMarkdown);
  if (!bodyText) throw new Error('Markdown conversion produced empty plain text.');
  const languageCheck = evaluateSdsContentLanguage(bodyText, seed.locale);

  return {
    bodyText,
    bodyMarkdown,
    extraMetadata: {
      language_detected: languageCheck.detectedLocale,
      language_detection_code: languageCheck.francCode,
      language_policy_mismatch: languageCheck.mismatch,
      markdown_s3_key: seed.s3Key,
      markdown_source_uri: `s3://${getS3Bucket()}/${seed.s3Key}`,
    },
  };
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
  getSourceUri: (seed) => `s3://${SDS_SOURCE_BUCKET}/${seed.sourcePdfKey}`,
  getExistingDocumentId: (seed) => seed.documentId,
  preserveExistingDocumentTitle: true,
  isDocumentCurrent: (seed, metadata) => metadata?.markdown_s3_key === seed.s3Key,
  discoverSeedDocuments: discoverSdsSeedDocuments,
  parseFile: parseSdsFile,
  buildDocumentMetadata: (seed) => ({
    product_code: seed.productCode,
    s3_key: seed.sourcePdfKey,
    markdown_s3_key: seed.s3Key,
  }),
});

export const getSdsDashboardStatus = sdsPipeline.getDashboardStatus;
export const runSdsIngestion = sdsPipeline.runIngestion;
