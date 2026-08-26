import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

type PageProps = {
  params: Promise<{ id: string }>;
};

/**
 * Linkify legacy:*:<id> references in text
 * Converts patterns like legacy:product_line:UUID to clickable links
 */
function linkifyLegacyReferences(text: string) {
  const legacyRefPattern = /legacy:(\w+):([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})/gi;
  const parts: Array<{ type: 'text' | 'link'; value: string; table?: string; id?: string }> = [];
  let lastIndex = 0;
  let match;

  // Reset regex lastIndex for global match iteration
  legacyRefPattern.lastIndex = 0;

  while ((match = legacyRefPattern.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        value: text.slice(lastIndex, match.index),
      });
    }

    // Add the link
    parts.push({
      type: 'link',
      value: match[0],
      table: match[1],
      id: match[2],
    });

    lastIndex = legacyRefPattern.lastIndex;
  }

  // Add remaining text after last match
  if (lastIndex < text.length) {
    parts.push({
      type: 'text',
      value: text.slice(lastIndex),
    });
  }

  // If no matches, return original text
  if (parts.length === 0) {
    return text;
  }

  // Render mixed text and links
  return parts.map((part, idx) => {
    if (part.type === 'text') {
      return part.value;
    }
    return (
      <Link
        key={idx}
        href={`/admin/products/rag/documents/${part.id}`}
        className="inline-flex items-center gap-1 font-mono text-sky-600 hover:text-sky-700 hover:underline transition"
        title={`Navigate to ${part.table} document ${part.id}`}
      >
        {part.value}
        <ExternalLink className="size-3" />
      </Link>
    );
  });
}

export const metadata = {
  title: 'Document Viewer | Betco BEX',
};

export default async function DocumentViewerPage({ params }: PageProps) {
  const { id } = await params;
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
            } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .select('id, document_key, title, document_kind, language_code, metadata')
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
    .select('chunk_index, heading, chunk_text, token_count')
    .eq('document_id', id)
    .order('chunk_index', { ascending: true });

  const chunkData = chunks.data ?? [];
  const epaReg = doc.metadata?.epa_reg_no;
  const dinNo = doc.metadata?.din_no;
  const brand = doc.metadata?.brand;

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-6 px-6 py-10 sm:px-8">
        {/* Back button */}
        <Link
          href="/admin/products/rag/chunking"
          className="inline-flex w-fit items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"
        >
          <ArrowLeft className="size-4" />
          Back to domain metadata
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
              <p className="mt-1 font-mono text-sm text-slate-500">{doc.document_key}</p>
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

        {/* Chunks */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Chunks ({chunkData.length})</h2>
          <div className="mt-6 space-y-4">
            {chunkData.length === 0 ? (
              <p className="text-sm text-slate-400">No chunks found.</p>
            ) : (
              chunkData.map((chunk) => (
                <div key={chunk.chunk_index} className="rounded-2xl border border-slate-200 p-4">
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
                  </div>
                  <div className="mt-3 overflow-auto rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-700 max-h-64">
                    {linkifyLegacyReferences(chunk.chunk_text)}
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
