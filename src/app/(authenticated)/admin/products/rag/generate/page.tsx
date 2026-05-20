import Link from 'next/link';
import { connection } from 'next/server';

import { GenerateControls } from '~/components/admin/GenerateControls';
import { getRagGenerationStatus } from '~/lib/rag/pipeline';
import { formatEasternTimestamp } from '~/lib/utils/time';

export const maxDuration = 300;

export const metadata = {
  title: 'RAG Pipeline Generate | Betco BEX',
  description: 'Run and monitor RAG document sync, chunking, and embedding generation.',
};

function formatTimestamp(value: string | null) {
  if (!value) {
    return 'Not available';
  }

  return formatEasternTimestamp(value);
}

export default async function RagGeneratePage() {
  await connection();

  const status = await getRagGenerationStatus();

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            className="inline-flex items-center rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"
            href="/admin/products/rag"
          >
            Back to RAG search
          </Link>
          <Link
            className="inline-flex items-center rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"
            href="/admin/products/rag"
          >
            Open RAG search
          </Link>
        </div>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
              RAG Generation
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
              Generate and monitor the RAG pipeline
            </h1>
            <p className="max-w-3xl text-base leading-7 text-slate-600">
              This dashboard lets you run the end-to-end product-profile pipeline:
              sync legacy records into `rag` in batches, process chunk batches,
              and process pending embeddings until the corpus is retrieval-ready.
            </p>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Source records</p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">
              {status.counts.sourceRecords}
            </p>
            <p className="mt-2 text-sm text-slate-600">
              {status.counts.activeSourceRecords} active,{' '}
              {status.counts.inactiveSourceRecords} inactive
            </p>
          </article>
          <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Entities</p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">
              {status.counts.entities}
            </p>
            <p className="mt-2 text-sm text-slate-600">
              Canonical business records available for filtering.
            </p>
          </article>
          <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Documents / Chunks</p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">
              {status.counts.documents} / {status.counts.chunks}
            </p>
            <p className="mt-2 text-sm text-slate-600">
              Retrieval-ready documents and chunk records.
            </p>
          </article>
          <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Embeddings</p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">
              {status.counts.embeddedChunks}
            </p>
            <p className="mt-2 text-sm text-slate-600">
              {status.counts.pendingChunks} pending chunks remain
            </p>
          </article>
        </section>

        {status.warnings.length > 0 ? (
          <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
            <p className="font-semibold">Status warnings</p>
            <div className="mt-3 flex flex-col gap-2">
              {status.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          </section>
        ) : null}

        <section className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <GenerateControls />

          <div className="flex flex-col gap-4">
            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Environment readiness
              </h2>
              <div className="mt-6 flex flex-col gap-3 text-sm text-slate-700">
                <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3">
                  <span>OpenAI API key</span>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      status.env.openAiConfigured
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-rose-50 text-rose-700'
                    }`}
                  >
                    {status.env.openAiConfigured ? 'Configured' : 'Missing'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3">
                  <span>Supabase service-role key</span>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      status.env.serviceRoleConfigured
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-rose-50 text-rose-700'
                    }`}
                  >
                    {status.env.serviceRoleConfigured ? 'Configured' : 'Missing'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3">
                  <span>Sync API key</span>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      status.env.syncApiKeyConfigured
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-amber-50 text-amber-700'
                    }`}
                  >
                    {status.env.syncApiKeyConfigured ? 'Configured' : 'Optional'}
                  </span>
                </div>
              </div>
            </section>

            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Latest activity
              </h2>
              <dl className="mt-6 flex flex-col gap-4 text-sm text-slate-700">
                <div className="rounded-2xl bg-slate-50 px-4 py-3">
                  <dt className="font-medium text-slate-500">
                    Source record update
                  </dt>
                  <dd className="mt-1">{formatTimestamp(status.latest.sourceRecordUpdatedAt)}</dd>
                </div>
                <div className="rounded-2xl bg-slate-50 px-4 py-3">
                  <dt className="font-medium text-slate-500">Document update</dt>
                  <dd className="mt-1">{formatTimestamp(status.latest.documentUpdatedAt)}</dd>
                </div>
                <div className="rounded-2xl bg-slate-50 px-4 py-3">
                  <dt className="font-medium text-slate-500">Chunk update</dt>
                  <dd className="mt-1">{formatTimestamp(status.latest.chunkUpdatedAt)}</dd>
                </div>
              </dl>
            </section>

            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Recommended order
              </h2>
              <ol className="mt-6 flex list-decimal flex-col gap-3 pl-5 text-sm leading-6 text-slate-700">
                <li>Sync document batches from legacy into `rag.source_record`, `rag.entity`, and `rag.document` until remaining source rows reach zero.</li>
                <li>Generate chunk batches from the retrieval-ready documents until remaining documents reach zero.</li>
                <li>Run embeddings until pending chunk count reaches zero.</li>
                <li>Open RAG search and validate the results.</li>
              </ol>
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}
