import Link from 'next/link';
import { connection } from 'next/server';

import { BoostRulesCard } from '~/components/admin/rag/BoostRulesCard';
import { ChunkingConfigCard } from '~/components/admin/rag/ChunkingConfigCard';
import { DomainMetadataCard } from '~/components/admin/rag/DomainMetadataCard';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import {
  getBoostFieldCoverage,
  getChunkTokenStats,
  getCorpusImprovementStatus,
  listEnrichmentDocuments,
  type CorpusImprovementState,
} from '~/lib/rag/corpus-stats';
import { getRagBoostWeights } from '~/lib/settings/settings-service';

/** Amber is reserved for "not built"; slate marks built-but-switched-off, emerald marks live. */
const STATE_BADGE: Record<CorpusImprovementState, string> = {
  active: 'bg-emerald-50 text-emerald-700',
  migrated: 'bg-slate-100 text-slate-600',
  inactive: 'bg-amber-50 text-amber-700',
};

export const maxDuration = 300;

export const metadata = {
  title: 'RAG Corpus Quality | Betco BEX',
  description: 'Configure chunking strategy, domain metadata, and similarity boost rules.',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const PAGE_SIZE = 25;

export default async function RagChunkingPage({ searchParams }: PageProps) {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_PRODUCTS,
    'GET /admin/products/rag/chunking',
  );

  await connection();

  const params = await searchParams;
  const page = Math.max(1, parseInt(String(params.page ?? '1'), 10) || 1);

  const [chunkStats, { documents, total }, status, boostWeights, boostCoverage] = await Promise.all([
    getChunkTokenStats(),
    listEnrichmentDocuments(page, PAGE_SIZE),
    getCorpusImprovementStatus(),
    getRagBoostWeights(),
    getBoostFieldCoverage(),
  ]);

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        {/* Nav breadcrumbs */}
        <div className="flex flex-wrap items-center gap-3">
          <Link
            className="inline-flex items-center rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"
            href="/admin/products/rag/generate"
          >
            Back to RAG generate
          </Link>
          <Link
            className="inline-flex items-center rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"
            href="/admin/products/rag"
          >
            Open RAG search
          </Link>
        </div>

        {/* Header */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
              RAG corpus quality
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
              Corpus quality improvements
            </h1>
            <p className="max-w-3xl text-base leading-7 text-slate-600">
              Four targeted improvements to raise average similarity from the current ~54% baseline.
              Every setting on this page is stored in the <code className="font-mono text-sm">settings</code>{' '}
              table and applied by the retrieval layer — nothing here generates SQL to paste
              elsewhere. The shipped defaults are deliberately inert, so a corpus only changes once
              an operator opts in.
            </p>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {status.improvements.map(({ label, status: statusLabel, state }) => (
              <div className="rounded-2xl bg-slate-50 px-4 py-3" key={label}>
                <p className="text-xs font-medium text-slate-700">{label}</p>
                <span
                  className={`mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_BADGE[state]}`}
                >
                  {statusLabel}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Card 1: Chunking config + token budget */}
        <ChunkingConfigCard chunkStats={chunkStats} config={status.chunking} />

        {/* Card 2: Domain metadata enrichment */}
        <DomainMetadataCard
          documents={documents}
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
        />

        {/* Card 3: Boost rules */}
        <BoostRulesCard
          coverage={boostCoverage}
          enabled={status.boost.enabled}
          weights={boostWeights}
        />
      </main>
    </div>
  );
}
