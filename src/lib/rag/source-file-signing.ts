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

function readFirstEnv(names: readonly string[]): string | undefined {
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

/**
 * Ingestion corpora whose admin panels list raw S3 keys discovered in the bucket. Those rows
 * are pre-ingestion — there is no `rag.document` yet — so they cannot be addressed by document
 * id like `createSourceFileViewUrl` callers are. Instead the corpus name selects the bucket
 * server-side and constrains which keys may be signed, so a request can never name a bucket.
 *
 * Bucket/prefix resolution mirrors each corpus's own pipeline module so this stays in step
 * with wherever those panels actually read from.
 */
const CORPUS_SOURCES = {
  sds: {
    bucketVars: ['AWS_S3_BUCKET_NAME'],
    bucketDefault: 'betco-sds',
    prefixVars: ['SDS_S3_PREFIX'],
    // Dedicated single-purpose bucket, so the whole bucket is the corpus.
    prefixDefault: '',
  },
  label: {
    bucketVars: ['LABEL_S3_BUCKET'],
    bucketDefault: 'retool-360',
    prefixVars: ['LABEL_S3_PREFIX'],
    prefixDefault: 'labels/',
  },
  knowledge: {
    bucketVars: ['KNOWLEDGE_S3_BUCKET'],
    bucketDefault: 'retool-360',
    prefixVars: ['KNOWLEDGE_S3_PREFIX'],
    prefixDefault: 'v1-markdown-files/',
  },
  efficacy: {
    bucketVars: ['AWS_EFFICACY_S3_BUCKET'],
    bucketDefault: 'retool-360',
    prefixVars: ['EFFICACY_S3_PREFIX'],
    prefixDefault: 'efficacy/',
  },
} as const satisfies Record<
  string,
  {
    bucketVars: readonly string[];
    bucketDefault: string;
    prefixVars: readonly string[];
    prefixDefault: string;
  }
>;

export type SourceCorpus = keyof typeof CORPUS_SOURCES;

export const SOURCE_CORPORA = Object.keys(CORPUS_SOURCES) as [SourceCorpus, ...SourceCorpus[]];

function normalizePrefix(prefix: string): string {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

/** The `s3://` URI for a key listed under a corpus, or null if the key escapes its prefix. */
export function corpusSourceUri(corpus: SourceCorpus, key: string): string | null {
  const config = CORPUS_SOURCES[corpus];
  const trimmedKey = key.trim();

  // Reject traversal and absolute-looking keys outright rather than relying on the prefix
  // check alone, since `..` segments could otherwise climb out of an allowed prefix.
  if (!trimmedKey || trimmedKey.startsWith('/') || trimmedKey.split('/').includes('..')) {
    return null;
  }

  const prefix = normalizePrefix(readFirstEnv(config.prefixVars) ?? config.prefixDefault);
  if (prefix && !trimmedKey.startsWith(prefix)) {
    return null;
  }

  const bucket = readFirstEnv(config.bucketVars) ?? config.bucketDefault;
  return `s3://${bucket}/${trimmedKey}`;
}

/**
 * Presign a key listed by a corpus ingestion panel.
 *
 * @throws SourceFileSigningError when the key falls outside the corpus prefix, or when the
 *   resolved bucket is not allowlisted / has no credentials.
 */
export async function createCorpusFileViewUrl(
  corpus: SourceCorpus,
  key: string,
): Promise<string> {
  const uri = corpusSourceUri(corpus, key);
  if (!uri) {
    throw new SourceFileSigningError(`Key is not inside the ${corpus} corpus prefix.`);
  }

  return createSourceFileViewUrl(uri);
}
