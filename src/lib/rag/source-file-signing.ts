import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * B0-684 — presign the ingested S3 object behind a RAG document so it can be viewed.
 *
 * `rag.source_record.source_uri` holds an `s3://bucket/key` pointer to the file a document
 * was ingested from (a label markdown, an SDS PDF). Those objects are private, so the URI
 * is not viewable on its own; this module turns a stored URI into a short-lived signed URL.
 *
 * Callers must resolve the URI from the database themselves and never from request input —
 * signing a client-supplied bucket/key would make the app an open proxy to every object our
 * credentials can read. The bucket allowlist below is defence in depth behind that rule.
 */

/** How long a generated view URL stays valid. Deliberately short — these are regulated docs. */
export const SOURCE_FILE_URL_TTL_SECONDS = 300;

type BucketConfig = {
  /** Env var names holding the read credentials for this bucket, in preference order. */
  accessKeyIdVars: string[];
  secretAccessKeyVars: string[];
  regionVars: string[];
};

/**
 * Buckets we will sign for, and the credentials each one needs. `betco-sds` is a separate
 * account from `retool-360` and has its own key pair (B0-243).
 */
const ALLOWED_BUCKETS: Record<string, BucketConfig> = {
  'retool-360': {
    accessKeyIdVars: [
      'AWS_360_READ_ACCESS_KEY_ID',
      'AWS_360_WRITE_ACCESS_KEY_ID',
      'AWS_ACCESS_READ_KEY_ID',
    ],
    secretAccessKeyVars: [
      'AWS_360_READ_SECRET_ACCESS_KEY',
      'AWS_360_WRITE_SECRET_ACCESS_KEY',
      'AWS_SECRET_READ_ACCESS_KEY',
    ],
    regionVars: ['AWS_360_REGION', 'AWS_REGION'],
  },
  'betco-sds': {
    accessKeyIdVars: ['AWS_SDS_READ_ACCESS_KEY_ID', 'AWS_SDS_WRITE_ACCESS_KEY_ID'],
    secretAccessKeyVars: ['AWS_SDS_READ_SECRET_ACCESS_KEY', 'AWS_SDS_WRITE_SECRET_ACCESS_KEY'],
    regionVars: ['AWS_SDS_REGION', 'AWS_REGION'],
  },
};

export type ParsedS3Uri = { bucket: string; key: string };

/**
 * Split an `s3://bucket/key` URI. Returns null for anything that is not a well-formed s3 URI
 * so callers can treat non-S3 sources (or junk) as simply not viewable.
 */
export function parseS3Uri(uri: string): ParsedS3Uri | null {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri.trim());
  if (!match) {
    return null;
  }

  const [, bucket, key] = match;
  if (!bucket || !key) {
    return null;
  }

  return { bucket, key };
}

/** Whether a stored URI points at a bucket we are configured to sign for. */
export function isSignableSourceUri(uri: string | null | undefined): boolean {
  if (!uri) {
    return false;
  }

  const parsed = parseS3Uri(uri);
  return parsed ? parsed.bucket in ALLOWED_BUCKETS : false;
}

function readFirstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

export class SourceFileSigningError extends Error {}

/**
 * Presign a GET for the object at a stored `s3://` URI.
 *
 * @throws SourceFileSigningError when the URI is malformed, its bucket is not allowlisted,
 *   or credentials for that bucket are not configured.
 */
export async function createSourceFileViewUrl(uri: string): Promise<string> {
  const parsed = parseS3Uri(uri);
  if (!parsed) {
    throw new SourceFileSigningError(`Not an s3:// URI: ${uri}`);
  }

  const config = ALLOWED_BUCKETS[parsed.bucket];
  if (!config) {
    throw new SourceFileSigningError(`Bucket is not allowlisted for signing: ${parsed.bucket}`);
  }

  const accessKeyId = readFirstEnv(config.accessKeyIdVars);
  const secretAccessKey = readFirstEnv(config.secretAccessKeyVars);
  if (!accessKeyId || !secretAccessKey) {
    throw new SourceFileSigningError(
      `Missing read credentials for ${parsed.bucket}. Set ${config.accessKeyIdVars[0]} / ${config.secretAccessKeyVars[0]}.`,
    );
  }

  const client = new S3Client({
    region: readFirstEnv(config.regionVars) ?? 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
  });

  return getSignedUrl(client, new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }), {
    expiresIn: SOURCE_FILE_URL_TTL_SECONDS,
  });
}
