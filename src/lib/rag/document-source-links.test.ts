import { describe, expect, it } from 'vitest';

import {
  LEGACY_REF_PATTERN,
  legacyReferenceHref,
  resolveDocumentSourceLinks,
} from '~/lib/rag/document-source-links';

const DOCUMENT_ID = '353e6d63-ef93-40c9-a75e-2e6255d7a537';
const SOURCE_FILE_HREF = `/api/admin/rag/document-source-file?documentId=${DOCUMENT_ID}`;
const PRODUCT_LINE_KEY = '237A29F4-8D3B-45A0-956B-E16F6235E479';
const PRODUCT_KEY = '862F6C97-516C-405D-A1A9-15CC26D920A9';

describe('LEGACY_REF_PATTERN', () => {
  it('captures the table and primary key out of a document_key', () => {
    const matches = Array.from(
      `legacy:product_line:${PRODUCT_LINE_KEY}:en`.matchAll(LEGACY_REF_PATTERN),
    );

    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('product_line');
    expect(matches[0][2]).toBe(PRODUCT_LINE_KEY);
  });

  it('does not match hash-keyed document keys (sds/efficacy/knowledge)', () => {
    for (const key of ['sds:3d4e6f520495e24b3a5f', 'efficacy:0003bc7f7258adc594ab']) {
      expect(Array.from(key.matchAll(LEGACY_REF_PATTERN))).toHaveLength(0);
    }
  });
});

describe('legacyReferenceHref', () => {
  it('points a product_line reference at the legacy source record, not a rag document', () => {
    const href = legacyReferenceHref('product_line', PRODUCT_LINE_KEY);

    expect(href).toBe(`/admin/products/legacy/line/${PRODUCT_LINE_KEY}`);
    // B0-684 regression: the embedded GUID is a legacy PK. Treating it as a rag.document.id
    // resolved back to the product_line_profile that owns it — a link to the current page.
    expect(href).not.toContain('/rag/documents/');
  });

  it('returns null for a legacy table with no in-app page', () => {
    expect(legacyReferenceHref('prod_images', PRODUCT_LINE_KEY)).toBeNull();
  });
});

describe('resolveDocumentSourceLinks', () => {
  it('links a product_line_profile to its legacy row, product line, and product', () => {
    const links = resolveDocumentSourceLinks({
      documentId: DOCUMENT_ID,
      documentKind: 'product_line_profile',
      documentKey: `legacy:product_line:${PRODUCT_LINE_KEY}:en`,
      sourceRecord: {
        source_schema: 'legacy',
        source_table: 'prod_line',
        source_pk: PRODUCT_LINE_KEY,
        source_type: 'product_line_profile',
        source_uri: null,
      },
      entity: { product_key: PRODUCT_KEY, product_line_key: PRODUCT_LINE_KEY },
    });

    expect(links.map((link) => link.href)).toEqual([
      `/admin/products/legacy/line/${PRODUCT_LINE_KEY}`,
      `/admin/products/rag/${PRODUCT_LINE_KEY}`,
      `/admin/products/legacy/${PRODUCT_KEY}`,
    ]);
  });

  it('routes an ingested SDS through the signing endpoint, addressed by document id', () => {
    const links = resolveDocumentSourceLinks({
      documentId: DOCUMENT_ID,
      documentKind: 'sds',
      documentKey: 'sds:3d4e6f520495e24b3a5f',
      sourceRecord: {
        source_schema: 'sds',
        source_table: 'sheet',
        source_pk: '3d4e6f520495e24b3a5f',
        source_type: 's3_pdf',
        source_uri: 's3://betco-sds/Betco SDS/226.pdf',
      },
      entity: { product_key: null, product_line_key: PRODUCT_LINE_KEY },
    });

    expect(links).toEqual([
      {
        label: 'RAG product line',
        value: PRODUCT_LINE_KEY,
        href: `/admin/products/rag/${PRODUCT_LINE_KEY}`,
      },
      {
        label: 'Ingested file',
        value: 's3://betco-sds/Betco SDS/226.pdf',
        href: SOURCE_FILE_HREF,
        external: true,
      },
    ]);

    // The bucket/key must never appear in the href — the endpoint resolves them server-side.
    expect(links[1].href).not.toContain('betco-sds');
  });

  it('returns only the ingested file when there is no entity linkage (efficacy/knowledge)', () => {
    const links = resolveDocumentSourceLinks({
      documentId: DOCUMENT_ID,
      documentKind: 'knowledge',
      documentKey: 'knowledge:002f117fc87050a57e65',
      sourceRecord: {
        source_schema: 'knowledge',
        source_table: 'file',
        source_pk: '002f117fc87050a57e65',
        source_type: 's3_markdown',
        source_uri: 's3://retool-360/v1-markdown-files/product/guide.md',
      },
      entity: null,
    });

    expect(links).toHaveLength(1);
    expect(links[0].href).toBe(SOURCE_FILE_HREF);
  });

  it('leaves an unsignable bucket as a display-only row', () => {
    const links = resolveDocumentSourceLinks({
      documentId: DOCUMENT_ID,
      documentKind: 'label',
      documentKey: 'label_md:betco:33632_x:en',
      sourceRecord: {
        source_schema: 'label_md',
        source_table: 'betco',
        source_pk: '33632_x',
        source_type: 'label',
        source_uri: 's3://some-other-bucket/labels/x.md',
      },
      entity: null,
    });

    expect(links).toEqual([
      {
        label: 'Ingested file',
        value: 's3://some-other-bucket/labels/x.md',
        href: null,
        external: false,
      },
    ]);
  });

  it('returns nothing when a document has no source record or entity', () => {
    expect(
      resolveDocumentSourceLinks({
        documentId: DOCUMENT_ID,
        documentKind: 'label',
        documentKey: 'label_md:betco:33632_x:en',
        sourceRecord: null,
        entity: null,
      }),
    ).toEqual([]);
  });
});
