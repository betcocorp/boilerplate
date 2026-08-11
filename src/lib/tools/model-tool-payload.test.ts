import { describe, expect, it } from 'vitest';

import {
  MODEL_BODY_OMISSION_MARKER,
  MODEL_DOCUMENT_BODY_MAX_CHARS,
  buildModelToolPayload,
  truncateDocumentBodyForModel,
} from '~/lib/tools/model-tool-payload';

const section = (heading: string, chars: number) => `## ${heading}\n${'x'.repeat(chars)}`;

/** Shape produced by `sourcePayload` in `~/lib/tools/product-tools`. */
function fullSource(overrides: Record<string, unknown> = {}) {
  const documentBody = 'Directions for use: 2 oz per gallon. Keep out of reach of children.';
  return {
    documentId: 'doc-1',
    chunkId: 'chunk-7',
    title: 'pH7Q Dual Label',
    snippet: 'Directions for use: 2 oz per gallon.',
    documentBody,
    documentBodyChars: documentBody.length,
    documentBodyChunkCount: 3,
    documentBodyTruncated: false,
    documentBodyTokenEstimate: 900,
    documentBodyChunkIds: ['chunk-7', 'chunk-8', 'chunk-9'],
    matchedChunkText: 'Directions for use: 2 oz per gallon.',
    confidence: 0.81,
    documentKind: 'label',
    productLineKey: 'ph7q-dual',
    productKey: null,
    s3Key: 'labels/betco/ph7q.md',
    sourceUri: 's3://retool-360/labels/betco/ph7q.md',
    freshness: null,
    ...overrides,
  };
}

describe('buildModelToolPayload — model vs full payload split (B0-437)', () => {
  it('drops snippet and matchedChunkText, which are already inside documentBody', () => {
    const payload = { ok: true, sources: [fullSource()] };
    const model = buildModelToolPayload(payload);
    const source = (model?.sources as Record<string, unknown>[])[0]!;

    expect('snippet' in source).toBe(false);
    expect('matchedChunkText' in source).toBe(false);
    expect(source.documentBody).toBe(payload.sources[0]!.documentBody);
  });

  it('keeps every field a citation depends on', () => {
    const model = buildModelToolPayload({ ok: true, sources: [fullSource()] });
    const source = (model?.sources as Record<string, unknown>[])[0]!;

    expect(source).toMatchObject({
      documentId: 'doc-1',
      chunkId: 'chunk-7',
      title: 'pH7Q Dual Label',
      confidence: 0.81,
      documentKind: 'label',
      productLineKey: 'ph7q-dual',
      productKey: null,
      s3Key: 'labels/betco/ph7q.md',
      sourceUri: 's3://retool-360/labels/betco/ph7q.md',
    });
  });

  it('never mutates the full payload the validator and guardrail read', () => {
    const payload = { ok: true, sources: [fullSource()] };
    const before = JSON.stringify(payload);
    buildModelToolPayload(payload);

    expect(JSON.stringify(payload)).toBe(before);
  });

  it('returns null when there is nothing to slim (no sources array)', () => {
    expect(buildModelToolPayload({ ok: true, policy: { summary: 'x' } })).toBeNull();
    expect(buildModelToolPayload({ ok: true, sources: [] })).toBeNull();
  });

  it('caps an oversized body and reports metadata that is honest about THAT body', () => {
    const documentBody = [
      section('Section 1. Identification', 5_000),
      section('Section 12. Ecological information', 9_000),
      section('Section 4. First-aid measures', 1_000),
    ].join('\n\n');

    const model = buildModelToolPayload({
      ok: true,
      sources: [
        fullSource({
          documentBody,
          documentBodyChars: documentBody.length,
          documentBodyChunkCount: 3,
          documentBodyChunkIds: ['a', 'b', 'c'],
          documentBodyTokenEstimate: 4_000,
        }),
      ],
    });
    const source = (model?.sources as Record<string, unknown>[])[0]!;

    expect(String(source.documentBody).length).toBeLessThanOrEqual(
      MODEL_DOCUMENT_BODY_MAX_CHARS,
    );
    // Accurate for the body it carries, not copied from the full one.
    expect(source.documentBodyChars).toBe(String(source.documentBody).length);
    expect(source.documentBodyTruncated).toBe(true);
    expect(source.documentBodyFullChars).toBe(documentBody.length);
    // Chunk composition cannot be restated once sections are dropped, so it is omitted rather than
    // asserted falsely (B0-13 auditability).
    expect('documentBodyChunkIds' in source).toBe(false);
    expect('documentBodyChunkCount' in source).toBe(false);
    expect('documentBodyTokenEstimate' in source).toBe(false);
  });

  it('keeps the accurate chunk metadata when the body fits and nothing was dropped', () => {
    const model = buildModelToolPayload({ ok: true, sources: [fullSource()] });
    const source = (model?.sources as Record<string, unknown>[])[0]!;

    expect(source.documentBodyChunkCount).toBe(3);
    expect(source.documentBodyChunkIds).toEqual(['chunk-7', 'chunk-8', 'chunk-9']);
    expect(source.documentBodyTokenEstimate).toBe(900);
    expect(source.documentBodyTruncated).toBe(false);
    expect('documentBodyFullChars' in source).toBe(false);
  });

  it('still reports truncated:true when the upstream 30k assembly was already truncated', () => {
    const model = buildModelToolPayload({
      ok: true,
      sources: [fullSource({ documentBodyTruncated: true })],
    });
    const source = (model?.sources as Record<string, unknown>[])[0]!;

    expect(source.documentBodyTruncated).toBe(true);
  });
});

describe('truncateDocumentBodyForModel — section-aware cap (B0-437)', () => {
  it('leaves a body that fits completely untouched', () => {
    const body = section('Directions for use', 100);
    expect(truncateDocumentBodyForModel(body)).toEqual({ body, truncated: false });
  });

  it('retains regulated sections that sit late in a long SDS', () => {
    const body = [
      section('Section 1. Identification', 3_000),
      section('Section 9. Physical and chemical properties', 6_000),
      section('Section 12. Ecological information', 6_000),
      section('Section 4. First-aid measures', 800),
      section('Section 15. Regulatory information', 800),
    ].join('\n\n');

    const result = truncateDocumentBodyForModel(body);

    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(MODEL_DOCUMENT_BODY_MAX_CHARS);
    // The two sections a regulated claim must be transcribed from survive; plain head-truncation
    // at 8k would have dropped both.
    expect(result.body).toContain('## Section 4. First-aid measures');
    expect(result.body).toContain('## Section 15. Regulatory information');
    expect(result.body).toContain(MODEL_BODY_OMISSION_MARKER);
  });

  it('keeps the surviving sections in original document order', () => {
    const body = [
      section('Section 2. Hazard identification', 1_000),
      section('Section 9. Physical properties', 9_000),
      section('Section 4. First-aid measures', 1_000),
    ].join('\n\n');

    const result = truncateDocumentBodyForModel(body);
    expect(result.body.indexOf('Hazard identification')).toBeLessThan(
      result.body.indexOf('First-aid measures'),
    );
  });

  it('falls back to head-truncation for a body with no section headings', () => {
    const body = 'y'.repeat(MODEL_DOCUMENT_BODY_MAX_CHARS + 500);
    const result = truncateDocumentBodyForModel(body);

    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(MODEL_DOCUMENT_BODY_MAX_CHARS);
    expect(result.body.endsWith(MODEL_BODY_OMISSION_MARKER)).toBe(true);
  });

  it('falls back to head-truncation when not even one section fits', () => {
    const body = [section('Directions for use', 20_000), section('Hazards', 20_000)].join('\n\n');
    const result = truncateDocumentBodyForModel(body);

    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(MODEL_DOCUMENT_BODY_MAX_CHARS);
  });

  it('honours an explicit smaller cap', () => {
    const body = [section('Hazards', 300), section('Ecology', 300)].join('\n\n');
    const result = truncateDocumentBodyForModel(body, 400);

    expect(result.truncated).toBe(true);
    expect(result.body).toContain('## Hazards');
    expect(result.body).not.toContain('## Ecology');
  });
});
