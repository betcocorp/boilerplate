import { connection } from 'next/server';

import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';

import { KnowledgeControls } from './KnowledgeControls';
import { getKnowledgeDashboardStatus } from './pipeline';

export const metadata = {
  title: 'Knowledge Ingestion | Betco BEX',
  description: 'Ingest curated v1 markdown knowledge into the RAG corpus.',
};

export default async function AdminKnowledgePage() {
  await requirePagePermission(PERMISSIONS.NAVIGATION_SIDEBAR_KNOWLEDGE, 'GET /admin/knowledge');
  await connection();
  const status = await getKnowledgeDashboardStatus();

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Knowledge ingestion
          </p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-950">
            v1 markdown knowledge into the RAG corpus
          </h1>
          <p className="mt-4 max-w-4xl text-base leading-7 text-slate-600">
            Ingests curated markdown from the `retool-360/v1-markdown-files` S3
            prefix into `rag.source_record`, `rag.document`, and
            `rag.document_chunk` with `document_kind = &quot;knowledge&quot;`.
            Specialist and doc-type are inferred from the folder + filename.
            Register discovered files, ingest (parse + heading-aware chunk), then
            embed to fill vectors.
          </p>
        </section>

        <KnowledgeControls initialStatus={status} />
      </main>
    </div>
  );
}
