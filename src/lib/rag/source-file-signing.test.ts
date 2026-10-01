import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  corpusSourceUri,
  createSourceFileViewUrl,
  isSignableSourceUri,
  parseS3Uri,
  SOURCE_CORPORA,
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

describe('corpusSourceUri', () => {
  it('maps each corpus onto its bucket and prefix', () => {
    expect(corpusSourceUri('label', 'labels/betco/07090_rest-stop.md')).toBe(
      's3://retool-360/labels/betco/07090_rest-stop.md',
    );
    expect(corpusSourceUri('knowledge', 'v1-markdown-files/product/guide.md')).toBe(
      's3://retool-360/v1-markdown-files/product/guide.md',
    );
    expect(corpusSourceUri('efficacy', 'efficacy/manifest/x.md')).toBe(
      's3://retool-360/efficacy/manifest/x.md',
    );
    // SDS has no prefix — it is a dedicated bucket.
    expect(corpusSourceUri('sds', 'Betco SDS/226.pdf')).toBe('s3://betco-sds/Betco SDS/226.pdf');
  });

  it('refuses a key outside the corpus prefix', () => {
    // A labels-corpus request must not be able to read the knowledge tree, or vice versa.
    expect(corpusSourceUri('label', 'v1-markdown-files/product/guide.md')).toBeNull();
    expect(corpusSourceUri('knowledge', 'labels/betco/07090_rest-stop.md')).toBeNull();
    expect(corpusSourceUri('efficacy', 'labels/betco/x.md')).toBeNull();
  });

  it('refuses traversal and absolute keys', () => {
    for (const key of [
      'labels/../v1-markdown-files/product/guide.md',
      '../labels/betco/x.md',
      '/labels/betco/x.md',
      '',
      '   ',
    ]) {
      expect(corpusSourceUri('label', key)).toBeNull();
    }
  });

  it('only ever produces URIs in buckets we can sign', () => {
    const validKeyPerCorpus: Record<(typeof SOURCE_CORPORA)[number], string> = {
      sds: 'Betco SDS/226.pdf',
      label: 'labels/betco/07090_rest-stop.md',
      knowledge: 'v1-markdown-files/product/guide.md',
      efficacy: 'efficacy/manifest/x.md',
    };

    // Guards against adding a corpus pointing at a bucket the signer would then reject.
    for (const corpus of SOURCE_CORPORA) {
      const uri = corpusSourceUri(corpus, validKeyPerCorpus[corpus]);
      expect(uri, `${corpus} should resolve`).not.toBeNull();
      expect(isSignableSourceUri(uri), `${corpus} bucket must be allowlisted`).toBe(true);
    }
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
