import Link from 'next/link';
import { notFound } from 'next/navigation';

import { OrphanQueueTable } from '~/components/orphans/orphan-queue-table';
import { getOrphanQueue } from '~/lib/orphans/orphan-queue-actions';
import { ORPHAN_DATA_TYPE_LABELS, orphanDataTypeSchema } from '~/types/orphans';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ dataType: string }>;
  searchParams: Promise<{ page?: string; q?: string; includeIgnored?: string }>;
}

export default async function OrphanDataTypePage({ params, searchParams }: PageProps) {
  const { dataType: raw } = await params;
  const parsed = orphanDataTypeSchema.safeParse(raw);
  if (!parsed.success) notFound();
  const dataType = parsed.data;

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? '1') || 1);
  const search = sp.q ?? '';
  const includeIgnored = sp.includeIgnored === '1';

  const { rows, total, pageSize } = await getOrphanQueue({
    dataType,
    page,
    search,
    includeIgnored,
  });

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-2">
        <Link href="/admin/products/orphans" className="text-sm text-muted-foreground hover:underline">
          ← Orphan Monitor
        </Link>
        <h1 className="text-2xl font-semibold">{ORPHAN_DATA_TYPE_LABELS[dataType]} — Orphans</h1>
      </div>

      <OrphanQueueTable
        dataType={dataType}
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        includeIgnored={includeIgnored}
        search={search}
      />
    </div>
  );
}
