import Link from 'next/link';

import { Badge } from '~/components/ui/badge';
import {
  ORPHAN_DATA_TYPE_LABELS,
  type OrphanDataType,
  type OrphanSummaryRow,
} from '~/types/orphans';

/**
 * Dashboard cards, one per data type, showing active/ignored orphan counts.
 * Server component — receives summary rows fetched by the page.
 */
export function OrphanSummaryCards({ summary }: { summary: OrphanSummaryRow[] }) {
  const byType = new Map<OrphanDataType, { active: number; ignored: number; total: number }>();
  for (const row of summary) {
    const acc = byType.get(row.data_type) ?? { active: 0, ignored: 0, total: 0 };
    acc.active += row.active;
    acc.ignored += row.ignored;
    acc.total += row.total;
    byType.set(row.data_type, acc);
  }

  const types = Object.keys(ORPHAN_DATA_TYPE_LABELS) as OrphanDataType[];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {types.map((type) => {
        const counts = byType.get(type) ?? { active: 0, ignored: 0, total: 0 };
        return (
          <Link
            key={type}
            href={`/admin/products/orphans/${type}`}
            className="group rounded-2xl border border-border bg-card p-5 ring-1 ring-transparent transition hover:ring-ring"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">
                {ORPHAN_DATA_TYPE_LABELS[type]}
              </span>
              <Badge variant={counts.active > 0 ? 'destructive' : 'secondary'}>{counts.active}</Badge>
            </div>
            <div className="mt-3 text-3xl font-semibold tabular-nums">{counts.active}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {counts.ignored} acknowledged · {counts.total} detected
            </div>
          </Link>
        );
      })}
    </div>
  );
}
