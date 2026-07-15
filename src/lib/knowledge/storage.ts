import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

/**
 * S3 read access to the curated v1 markdown knowledge files in `s3://retool-360/v1-markdown-files/`
 * (the markdown-ingest source). Uses the read-only `retool-360` credentials from `.env.local`
 * (`AWS_ACCESS_READ_KEY_ID` / `AWS_SECRET_READ_ACCESS_KEY`); returns null client when unconfigured so
 * the admin dashboard can degrade gracefully (mirrors the SDS pipeline's S3-unavailable fallback).
 */

export const KNOWLEDGE_S3_BUCKET = process.env.KNOWLEDGE_S3_BUCKET?.trim() || 'retool-360';
export const KNOWLEDGE_S3_PREFIX = process.env.KNOWLEDGE_S3_PREFIX?.trim() || 'v1-markdown-files/';

function getReadClient(): S3Client | null {
  const accessKeyId = process.env.AWS_ACCESS_READ_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_READ_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return null;
  return new S3Client({
    region: process.env.AWS_REGION?.trim() || 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
  });
}

export function isKnowledgeS3Configured(): boolean {
  return getReadClient() !== null;
}

const MISSING_CREDS =
  'retool-360 read credentials are not configured (AWS_ACCESS_READ_KEY_ID / AWS_SECRET_READ_ACCESS_KEY).';

/** List every `.md` object key under the knowledge prefix (paginated). */
export async function listKnowledgeMarkdownKeys(): Promise<string[]> {
  const client = getReadClient();
  if (!client) throw new Error(MISSING_CREDS);

  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: KNOWLEDGE_S3_BUCKET,
        Prefix: KNOWLEDGE_S3_PREFIX,
        ContinuationToken: token,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key && obj.Key.toLowerCase().endsWith('.md')) keys.push(obj.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Fetch a markdown object's raw UTF-8 text. */
export async function getKnowledgeMarkdown(key: string): Promise<string> {
  const client = getReadClient();
  if (!client) throw new Error(MISSING_CREDS);
  const res = await client.send(new GetObjectCommand({ Bucket: KNOWLEDGE_S3_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Empty S3 body for ${key}`);
  return res.Body.transformToString('utf-8');
}
