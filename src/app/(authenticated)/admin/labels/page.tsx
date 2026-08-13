import { connection } from 'next/server';

import { LabelControls } from './LabelControls';
import { getLabelDashboardStatus } from './pipeline';

export const metadata = {
  title: 'Product Label Ingestion | Betco BEX',
  description: 'Ingest the curated product label markdown corpus into the RAG corpus.',
};

export default async function AdminLabelsPage() {
  await connection();
  const status = await getLabelDashboardStatus();

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Label ingestion
          </p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-950">
            Product label markdown into the RAG corpus
          </h1>
          <p className="mt-4 max-w-4xl text-base leading-7 text-slate-600">
            Ingests the curated Betco, EnviroZyme, Basic Coatings, and 1950
            Brands label markdown from the `retool-360/labels` S3 prefix into
            `rag.source_record`, `rag.document`, and `rag.document_chunk` with
            `document_kind = &quot;label&quot;`. Brand and SKU are inferred from
            the S3 folder + filename; documents link to the existing
            SKU-bootstrapped `rag.entity` rows where available. Register
            discovered files, ingest (parse frontmatter + heading-aware
            chunk), then embed to fill vectors.
          </p>
        </section>

        <LabelControls initialStatus={status} />
      </main>
    </div>
  );
}
