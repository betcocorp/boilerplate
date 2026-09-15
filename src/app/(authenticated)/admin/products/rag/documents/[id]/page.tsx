import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { LegacyReferenceText } from '~/components/admin/rag/LegacyReferenceText';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import {
  ragChunkHref,
  sanitizeRagReturnHref,
} from '~/lib/rag/document-detail-links';
import { resolveDocumentSourceLinks } from '~/lib/rag/document-source-links';
import { SOURCE_FILE_URL_TTL_SECONDS } from '~/lib/rag/source-file-signing';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export const metadata = {
  title: 'Document Viewer | Betco BEX',
};

export default async function DocumentViewerPage({ params, searchParams }: PageProps) {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_TOOLS,
    'GET /admin/products/rag/documents/[id]',
  );

  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const rawFrom = resolvedSearchParams.from;
  const returnHref = sanitizeRagReturnHref(
    Array.isArray(rawFrom) ? rawFrom[0] : rawFrom,
  );
  const supabase = getSupabaseServiceRoleClient();

  const { data: doc, error } = await (
    supabase.schema('rag').from('document') as unknown as {
      select(cols: string): {
        eq(col: string, val: string): {
          single(): Promise<{
            data: {
              id: string;
              document_key: string;
              title: string;
              document_kind: string;
              language_code: string;
              metadata: Record<string, unknown> | null;
              source_record_id: string | null;
              entity_id: string | null;
            } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .select(
      'id, document_key, title, document_kind, language_code, metadata, source_record_id, entity_id',
    )
    .eq('id', id)
    .single();

  if (error || !doc) {
    notFound();
  }

  const chunks = await (
    supabase.schema('rag').from('document_chunk') as unknown as {
      select(cols: string): {
        eq(col: string, val: string): {
          order(
            col: string,
            opts: { ascending: boolean }
          ): Promise<{
            data: Array<{
              id: string;
              chunk_index: number;
              heading: string | null;
              chunk_text: string;
              token_count: number | null;
            }> | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .select('id, chunk_index, heading, chunk_text, token_count')
    .eq('document_id', id)
    .order('chunk_index', { ascending: true });

  const chunkData = chunks.data ?? [];
  const epaReg = doc.metadata?.epa_reg_no;
  const dinNo = doc.metadata?.din_no;
  const brand = doc.metadata?.brand;

  // Source provenance: where this document was derived from, and the product/line it
  // describes. Both are optional — efficacy/knowledge documents have no entity linkage.
  type SingleRowSelect<T> = {
    select(cols: string): {
      eq(col: string, val: string): {
        maybeSingle(): Promise<{ data: T | null; error: { message: string } | null }>;
      };
    };
  };

  const [sourceRecordResult, entityResult] = await Promise.all([
    doc.source_record_id
      ? (
          supabase.schema('rag').from('source_record') as unknown as SingleRowSelect<{
            source_schema: string | null;
            source_table: string | null;
            source_pk: string | null;
            source_type: string | null;
            source_uri: string | null;
          }>
        )
          .select('source_schema, source_table, source_pk, source_type, source_uri')
          .eq('id', doc.source_record_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    doc.entity_id
      ? (
          supabase.schema('rag').from('entity') as unknown as SingleRowSelect<{
            product_key: string | null;
            product_line_key: string | null;
          }>
        )
          .select('product_key, product_line_key')
          .eq('id', doc.entity_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const sourceLinks = resolveDocumentSourceLinks({
    documentId: doc.id,
    documentKind: doc.document_kind,
    documentKey: doc.document_key,
    sourceRecord: sourceRecordResult.data,
    entity: entityResult.data,
  });

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-6 px-6 py-10 sm:px-8">
        {/* Back button — prefer the search results this page was opened from (B0-1019). */}
        <Link
          href={returnHref ?? '/admin/products/rag/chunking'}
          className="inline-flex w-fit items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"
        >
          <ArrowLeft className="size-4" />
          {returnHref ? 'Back to search results' : 'Back to domain metadata'}
        </Link>

        {/* Header */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Document Source
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                {doc.title}
              </h1>
              <p className="mt-1 font-mono text-sm text-slate-500">
                <LegacyReferenceText text={doc.document_key} />
              </p>
            </div>

            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Type', value: doc.document_kind },
                { label: 'Language', value: doc.language_code },
                { label: 'EPA Reg', value: String(epaReg || '—') },
                { label: 'DIN', value: String(dinNo || '—') },
                { label: 'Brand', value: String(brand || '—') },
                { label: 'Chunks', value: chunkData.length.toString() },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-2xl bg-slate-50 px-4 py-3">
                  <p className="text-xs text-slate-500">{label}</p>
                  <p className="mt-1 text-sm font-medium text-slate-900">{value}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Source data */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Source data</h2>
          <p className="mt-1 text-sm text-slate-500">
            Where this document was derived from. Ingested files open via a signed link that
            expires after {SOURCE_FILE_URL_TTL_SECONDS / 60} minutes.
          </p>
          {sourceLinks.length === 0 ? (
            <p className="mt-6 text-sm text-slate-400">No source linkage on file.</p>
          ) : (
            <dl className="mt-6 divide-y divide-slate-100">
              {sourceLinks.map((link) => (
                <div className="flex flex-wrap gap-x-4 gap-y-1 py-3" key={`${link.label}-${link.value}`}>
                  <dt className="w-44 shrink-0 text-sm font-medium text-slate-700">{link.label}</dt>
                  <dd className="min-w-0 flex-1 break-all font-mono text-xs text-slate-600">
                    {link.href ? (
                      <Link
                        className="inline-flex items-center gap-1 text-sky-600 transition hover:text-sky-700 hover:underline"
                        href={link.href}
                        // Signed-URL redirects must leave the SPA router, not be prefetched.
                        {...(link.external
                          ? { prefetch: false, rel: 'noopener noreferrer', target: '_blank' }
                          : {})}
                      >
                        {link.value}
                        <ExternalLink className="size-3 shrink-0" />
                      </Link>
                    ) : (
                      link.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        {/* Chunks */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Chunks ({chunkData.length})</h2>
          <div className="mt-6 space-y-4">
            {chunkData.length === 0 ? (
              <p className="text-sm text-slate-400">No chunks found.</p>
            ) : (
              chunkData.map((chunk) => (
                <div key={chunk.id} className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <div>
                      {chunk.heading && (
                        <p className="text-sm font-semibold text-slate-900">{chunk.heading}</p>
                      )}
                      <p className="text-xs text-slate-400">
                        Chunk {chunk.chunk_index}
                        {chunk.token_count && ` • ${chunk.token_count} tokens`}
                      </p>
                    </div>
                    <Link
                      href={ragChunkHref(doc.id, chunk.id, returnHref)}
                      className="shrink-0 text-xs font-medium text-sky-600 transition hover:text-sky-700 hover:underline"
                    >
                      Open chunk
                    </Link>
                  </div>
                  <div className="mt-3 overflow-auto rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-700 max-h-64">
                    <LegacyReferenceText text={chunk.chunk_text} />
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
