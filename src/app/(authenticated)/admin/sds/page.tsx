import Link from 'next/link';
import { connection } from 'next/server';

import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import { getSdsSyncStatus } from '~/lib/rag/sds-sync-actions';

import { SdsControls } from './SdsControls';
import { getSdsDashboardStatus } from './pipeline';

export const metadata = {
  title: 'SDS Ingestion | Betco BEX',
  description: 'Ingest and monitor SDS documents in the RAG schema.',
};

export default async function AdminSdsPage() {
  await requirePagePermission(PERMISSIONS.NAVIGATION_SIDEBAR_SDS, 'GET /admin/sds');
  await connection();
  const [status, syncStatus] = await Promise.all([
    getSdsDashboardStatus(),
    getSdsSyncStatus(),
  ]);

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
                This flow maps pre-converted SDS markdown from the BEX S3 bucket onto
                existing `rag.document` rows, then creates `rag.document_chunk` rows with
                `document_kind = &quot;sds&quot;` while retaining the original PDF source links.
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

        <SdsControls initialStatus={status} initialSyncStatus={syncStatus} />
      </main>
    </div>
  );
}
