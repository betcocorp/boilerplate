import Link from 'next/link';

import { AliasReviewRowPanel } from '~/components/admin/AliasReviewRowPanel';
import { Button } from '~/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import type { ProductAliasReviewRow } from '~/lib/rag/product-alias-review-schemas';

const ROUTE = '/admin/tools/cross-reference/aliases';
const PAGE_LINK_WINDOW = 5;

function buildHref(page: number) {
  return page > 1 ? `${ROUTE}?page=${page}` : ROUTE;
}

function buildPagination(currentPage: number, totalPages: number) {
  const half = Math.floor(PAGE_LINK_WINDOW / 2);
  const end = Math.min(totalPages, Math.max(currentPage + half, PAGE_LINK_WINDOW));
  const start = Math.max(1, end - PAGE_LINK_WINDOW + 1);
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);
}

export function AliasReviewQueue({
  loadError,
  items,
  page,
  pageSize,
  total,
  truncated,
}: {
  loadError: string | null;
  items: ProductAliasReviewRow[];
  page: number;
  pageSize: number;
  total: number;
  truncated: boolean;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const paginationPages = buildPagination(page, totalPages);
  const conflictCount = items.filter((i) => i.isConflict).length;

  return (
    <div className="space-y-6">
      {loadError ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {loadError}
        </div>
      ) : (
        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Unverified aliases</CardTitle>
              <CardDescription>
                Conflict rows (spanning more than one product line) sort first · oldest first
                otherwise · {total.toLocaleString()} total
                {truncated ? ' (showing a capped subset — narrow the underlying data first)' : ''}
              </CardDescription>
            </div>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
          </CardHeader>
          <CardContent className="space-y-3">
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No unverified aliases on this page. Nothing waiting for review right now.
              </p>
            ) : (
              <ul className="space-y-3">
                {items.map((row) => (
                  <AliasReviewRowPanel key={row.id} row={row} />
                ))}
              </ul>
            )}
            {conflictCount > 0 ? (
              <p className="text-xs text-muted-foreground">
                {conflictCount} of {items.length} rows on this page span multiple product lines.
              </p>
            ) : null}
          </CardContent>
        </Card>
      )}

      {!loadError && totalPages > 1 ? (
        <nav
          aria-label="Alias review pagination"
          className="flex flex-wrap items-center justify-center gap-2"
        >
          <Button
            asChild
            variant="outline"
            size="sm"
            className={page === 1 ? 'pointer-events-none opacity-50' : undefined}
          >
            <Link href={buildHref(Math.max(1, page - 1))}>Previous</Link>
          </Button>
          {paginationPages.map((p) => (
            <Button key={p} asChild size="sm" variant={p === page ? 'default' : 'outline'}>
              <Link href={buildHref(p)}>{p}</Link>
            </Button>
          ))}
          <Button
            asChild
            variant="outline"
            size="sm"
            className={page === totalPages ? 'pointer-events-none opacity-50' : undefined}
          >
            <Link href={buildHref(Math.min(totalPages, page + 1))}>Next</Link>
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
