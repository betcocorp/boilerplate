import Link from 'next/link';
import { connection } from 'next/server';

import { SdsControls } from './SdsControls';
import { getSdsDashboardStatus } from './pipeline';

export default async function AdminSdsPage() {
  await connection();
  const status = await getSdsDashboardStatus();

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-4xl">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                SDS ingestion
              </p>
              <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-950">
                Initial SDS import into the RAG schema
              </h1>
              <p className="mt-4 text-base leading-7 text-slate-600">
                This flow ingests local PDF paths into `rag.source_record`, `rag.document`,
                and `rag.document_chunk` with `document_kind = &quot;sds&quot;`. It is
                designed for first-pass loading while S3 webhook sync is still being built.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Link
                className="inline-flex h-11 items-center justify-center rounded-2xl bg-white px-5 text-sm font-medium text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-50"
                href="/admin/products/rag/search"
              >
                Open semantic search
              </Link>
              <Link
                className="inline-flex h-11 items-center justify-center rounded-2xl bg-white px-5 text-sm font-medium text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-50"
                href="/admin/products/rag/generate"
              >
                Open RAG generate
              </Link>
            </div>
          </div>
        </section>

        <SdsControls initialStatus={status} />
      </main>
    </div>
  );
}
