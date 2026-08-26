/**
 * B0-684 — resolve a RAG document to the source data behind it.
 *
 * Every `rag.document` is derived from something: a legacy `prod_line` row, an S3 label
 * markdown file, an SDS PDF. This maps each supported `document_kind` / `document_key`
 * shape onto the in-app page for that source, so the document viewer can link out to it
 * instead of pointing back at itself.
 *
 * A `legacy:product_line:<GUID>` key is the case that matters most: the GUID is the legacy
 * `prod_line.ProdLineKey`, NOT a `rag.document.id`. Resolving it as a document id lands back
 * on the product_line_profile document that owns the key — i.e. the page you are already on.
 */

import { isSignableSourceUri } from '~/lib/rag/source-file-signing';

/** Legacy source references embedded in a `document_key` (or chunk text). */
export const LEGACY_REF_PATTERN =
  /legacy:(\w+):([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/gi;

/**
 * Legacy sources we can link to. Keyed by BOTH spellings of the same table, because the two
 * places we read it from disagree: a `document_key` segment says `product_line` while
 * `rag.source_record.source_table` carries the real legacy table name `prod_line`.
 */
const LEGACY_TABLE_ROUTES: Record<string, (pk: string) => string> = {
  product_line: (pk) => `/admin/products/legacy/line/${pk}`,
  prod_line: (pk) => `/admin/products/legacy/line/${pk}`,
};

/**
 * In-app href for a `legacy:<table>:<pk>` reference, or null when that table has no page.
 * Exported so the same mapping backs both inline linkification and the source panel.
 */
export function legacyReferenceHref(table: string, pk: string): string | null {
  return LEGACY_TABLE_ROUTES[table.toLowerCase()]?.(pk) ?? null;
}

export type DocumentSourceLink = {
  /** Row label, e.g. "Legacy product line". */
  label: string;
  /** Value to display — a key, a SKU, or an `s3://` URI. */
  value: string;
  /** Destination, or null when the source cannot be reached (e.g. an unsignable bucket). */
  href: string | null;
  /**
   * True when `href` leaves the app — currently only the ingested-file row, which redirects
   * to a time-limited signed S3 URL and so must open in a new tab rather than client-navigate.
   */
  external?: boolean;
};

export type DocumentSourceInput = {
  /** `rag.document.id` — used to address the ingested file without exposing bucket/key. */
  documentId: string;
  documentKind: string;
  documentKey: string;
  sourceRecord: {
    source_schema: string | null;
    source_table: string | null;
    source_pk: string | null;
    source_type: string | null;
    source_uri: string | null;
  } | null;
  entity: {
    product_key: string | null;
    product_line_key: string | null;
  } | null;
};

/**
 * Every source pointer for a document, most specific first. Rows without an `href` are still
 * returned so the viewer can show *where* the data came from even when it is an S3 object
 * with no in-app viewer.
 */
export function resolveDocumentSourceLinks(
  input: DocumentSourceInput,
): DocumentSourceLink[] {
  const links: DocumentSourceLink[] = [];
  const { sourceRecord, entity } = input;

  // Legacy relational source (product_line_profile): the source_pk IS the route param.
  if (sourceRecord?.source_schema === 'legacy' && sourceRecord.source_table && sourceRecord.source_pk) {
    const href = legacyReferenceHref(sourceRecord.source_table, sourceRecord.source_pk);
    if (href) {
      links.push({
        label: `Legacy ${sourceRecord.source_table.replaceAll('_', ' ')}`,
        value: sourceRecord.source_pk,
        href,
      });
    }
  }

  // Entity linkage — the product line / product this document describes.
  if (entity?.product_line_key) {
    links.push({
      label: 'RAG product line',
      value: entity.product_line_key,
      href: `/admin/products/rag/${entity.product_line_key}`,
    });
  }

  if (entity?.product_key) {
    links.push({
      label: 'Legacy product',
      value: entity.product_key,
      href: `/admin/products/legacy/${entity.product_key}`,
    });
  }

  // Raw ingested file (labels, SDS, efficacy, knowledge). Addressed by document id so the
  // bucket/key never round-trips through the client; the route presigns on each request.
  if (sourceRecord?.source_uri) {
    const signable = isSignableSourceUri(sourceRecord.source_uri);
    links.push({
      label: 'Ingested file',
      value: sourceRecord.source_uri,
      href: signable
        ? `/api/admin/rag/document-source-file?documentId=${encodeURIComponent(input.documentId)}`
        : null,
      external: signable,
    });
  }

  return links;
}
