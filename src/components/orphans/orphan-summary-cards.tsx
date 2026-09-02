import Link from 'next/link';

import { Badge } from '~/components/ui/badge';
import {
  ORPHAN_DATA_TYPE_LABELS,
  type OrphanDataType,
  type OrphanSummaryRow,
} from '~/types/orphans';

interface TypeCounts {
  active: number;
  ignored: number;
  total: number;
  activeTranslated: number;
}

const EMPTY_COUNTS: TypeCounts = { active: 0, ignored: 0, total: 0, activeTranslated: 0 };

/**
 * Dashboard cards, one per data type. The headline is the count the queue table actually
 * shows by default — active minus translated (B0-804) — with the translated remainder
 * spelled out underneath so nothing is silently dropped.
 * Server component — receives summary rows fetched by the page.
 */
export function OrphanSummaryCards({ summary }: { summary: OrphanSummaryRow[] }) {
  const byType = new Map<OrphanDataType, TypeCounts>();
  for (const row of summary) {
    const acc = byType.get(row.data_type) ?? { ...EMPTY_COUNTS };
    acc.active += row.active;
    acc.ignored += row.ignored;
    acc.total += row.total;
    acc.activeTranslated += row.active_translated;
    byType.set(row.data_type, acc);
  }

  const types = Object.keys(ORPHAN_DATA_TYPE_LABELS) as OrphanDataType[];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {types.map((type) => {
        const counts = byType.get(type) ?? EMPTY_COUNTS;
        const visible = Math.max(0, counts.active - counts.activeTranslated);
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
              <Badge variant={visible > 0 ? 'destructive' : 'secondary'}>{visible}</Badge>
            </div>
            <div className="mt-3 text-3xl font-semibold tabular-nums">{visible}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {`${counts.activeTranslated > 0 ? `${counts.activeTranslated} translated · ` : ''}${
                counts.ignored
              } acknowledged · ${counts.total} detected`}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
