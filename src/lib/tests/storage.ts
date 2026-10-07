import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const TEST_BUCKET = 'retool-360';
const TEST_PREFIX = 'bex';

function getAwsCredentials() {
  const accessKeyId = process.env.AWS_360_WRITE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_360_WRITE_SECRET_ACCESS_KEY?.trim();

  if (!accessKeyId || !secretAccessKey) {
    return undefined;
  }

  return { accessKeyId, secretAccessKey };
}

function getS3Client() {
  const region = process.env.AWS_360_REGION?.trim() || 'us-east-1';
  const credentials = getAwsCredentials();

  return new S3Client({
    region,
    ...(credentials ? { credentials } : {}),
  });
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function uploadTestCsvToS3(params: {
  testId: string;
  fileName: string;
  bytes: Uint8Array;
  contentType?: string;
}) {
  const safeFileName = sanitizeFileName(params.fileName || 'dataset.csv');
  const key = `${TEST_PREFIX}/${params.testId}/${safeFileName}`;
  const client = getS3Client();

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: TEST_BUCKET,
        Key: key,
        Body: params.bytes,
        ContentType: params.contentType || 'text/csv',
      }),
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown S3 upload credentials failure.';
    throw new Error(
      `Unable to upload test CSV to s3://${TEST_BUCKET}/${key}. Configure AWS credentials (AWS_360_WRITE_ACCESS_KEY_ID / AWS_360_WRITE_SECRET_ACCESS_KEY). Original error: ${message}`,
    );
  }

  return {
    bucket: TEST_BUCKET,
    key,
  };
}

export async function getSignedTestFileUrl(params: {
  bucket: string;
  key: string;
  expiresInSeconds?: number;
}) {
  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
  });

  return getSignedUrl(client, command, {
    expiresIn: params.expiresInSeconds ?? 900,
  });
}
