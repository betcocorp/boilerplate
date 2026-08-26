import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSourceFileViewUrl,
  isSignableSourceUri,
  parseS3Uri,
  SOURCE_FILE_URL_TTL_SECONDS,
  SourceFileSigningError,
} from '~/lib/rag/source-file-signing';

describe('parseS3Uri', () => {
  it('splits bucket from key, keeping spaces and slashes in the key', () => {
    expect(parseS3Uri('s3://betco-sds/Betco SDS/226.pdf')).toEqual({
      bucket: 'betco-sds',
      key: 'Betco SDS/226.pdf',
    });
    expect(parseS3Uri('s3://retool-360/labels/betco/07090_rest-stop.md')).toEqual({
      bucket: 'retool-360',
      key: 'labels/betco/07090_rest-stop.md',
    });
  });

  it('rejects anything that is not a bucket-plus-key s3 URI', () => {
    for (const uri of [
      'https://retool-360.s3.amazonaws.com/labels/x.md',
      's3://retool-360',
      's3://retool-360/',
      's3:///labels/x.md',
      'labels/x.md',
      '',
    ]) {
      expect(parseS3Uri(uri)).toBeNull();
    }
  });
});

describe('isSignableSourceUri', () => {
  it('accepts the two ingestion buckets', () => {
    expect(isSignableSourceUri('s3://retool-360/labels/betco/07090_rest-stop.md')).toBe(true);
    expect(isSignableSourceUri('s3://betco-sds/Betco SDS/226.pdf')).toBe(true);
  });

  it('rejects unknown buckets and non-S3 values', () => {
    expect(isSignableSourceUri('s3://some-other-bucket/x.md')).toBe(false);
    expect(isSignableSourceUri('https://example.com/x.md')).toBe(false);
    expect(isSignableSourceUri(null)).toBe(false);
    expect(isSignableSourceUri(undefined)).toBe(false);
  });
});

describe('createSourceFileViewUrl', () => {
  const CRED_VARS = [
    'AWS_360_READ_ACCESS_KEY_ID',
    'AWS_360_WRITE_ACCESS_KEY_ID',
    'AWS_ACCESS_READ_KEY_ID',
    'AWS_360_READ_SECRET_ACCESS_KEY',
    'AWS_360_WRITE_SECRET_ACCESS_KEY',
    'AWS_SECRET_READ_ACCESS_KEY',
  ] as const;

  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(CRED_VARS.map((name) => [name, process.env[name]]));
    for (const name of CRED_VARS) delete process.env[name];
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('signs a GET with the configured expiry', async () => {
    process.env.AWS_360_READ_ACCESS_KEY_ID = 'AKIAEXAMPLE';
    process.env.AWS_360_READ_SECRET_ACCESS_KEY = 'secret';

    const url = await createSourceFileViewUrl('s3://retool-360/labels/betco/07090_rest-stop.md');
    const parsed = new URL(url);

    expect(parsed.hostname).toContain('retool-360');
    expect(parsed.pathname).toContain('07090_rest-stop.md');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe(String(SOURCE_FILE_URL_TTL_SECONDS));
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
    // The secret itself must never end up in the URL.
    expect(url).not.toContain('secret');
  });

  it('refuses a bucket that is not allowlisted', async () => {
    process.env.AWS_360_READ_ACCESS_KEY_ID = 'AKIAEXAMPLE';
    process.env.AWS_360_READ_SECRET_ACCESS_KEY = 'secret';

    await expect(createSourceFileViewUrl('s3://not-ours/x.md')).rejects.toThrow(
      SourceFileSigningError,
    );
  });

  it('refuses a malformed URI', async () => {
    await expect(createSourceFileViewUrl('https://example.com/x.md')).rejects.toThrow(
      SourceFileSigningError,
    );
  });

  it('reports missing credentials instead of emitting an unsigned URL', async () => {
    await expect(
      createSourceFileViewUrl('s3://retool-360/labels/betco/07090_rest-stop.md'),
    ).rejects.toThrow(/Missing read credentials for retool-360/);
  });
});
