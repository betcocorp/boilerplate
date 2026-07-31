import Link from 'next/link';

import { Button } from '~/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { fetchCrossReferenceMappings } from '~/lib/tools/cross-reference-mappings';

const ROUTE = '/admin/tools/cross-reference/lookup';
const SEARCH_PARAM = 'xrefQ';
const PAGE_PARAM = 'xrefPage';
const PAGE_LINK_WINDOW = 5;

function buildHref(search: string, page: number) {
  const params = new URLSearchParams();
  if (search) {
    params.set(SEARCH_PARAM, search);
  }
  if (page > 1) {
    params.set(PAGE_PARAM, String(page));
  }
  const qs = params.toString();
  return qs ? `${ROUTE}?${qs}` : ROUTE;
}

function buildPagination(currentPage: number, totalPages: number) {
  const half = Math.floor(PAGE_LINK_WINDOW / 2);
  const end = Math.min(totalPages, Math.max(currentPage + half, PAGE_LINK_WINDOW));
  const start = Math.max(1, end - PAGE_LINK_WINDOW + 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

export async function CrossReferenceMappingsTable({
  search,
  page,
}: {
  search: string;
  page: number;
}) {
  let errorMessage: string | null = null;
  let result: Awaited<ReturnType<typeof fetchCrossReferenceMappings>> | null = null;

  try {
    result = await fetchCrossReferenceMappings({ search, page });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : 'Unable to load cross-reference mappings.';
  }

  const rows = result?.rows ?? [];
  const total = result?.total ?? 0;
  const currentPage = result?.page ?? 1;
  const totalPages = result?.totalPages ?? 1;
  const paginationPages = buildPagination(currentPage, totalPages);

  return (
    <Card className="rounded-3xl border border-border/60 shadow-none">
      <CardHeader>
        <CardTitle>Cross-reference mappings</CardTitle>
        <CardDescription>
          The complete competitor → Betco 1:1 matchings from the legacy tool (
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">legacy.competitor_products</code>
          ) — the ground truth behind the B0-99 recommendation eval set.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form action={ROUTE} method="get" className="flex flex-col gap-3 sm:flex-row">
          <Input
            type="search"
            name={SEARCH_PARAM}
            defaultValue={search}
            placeholder="Search by competitor brand or product name"
            className="flex-1"
          />
          <Button type="submit" className="shrink-0">
            Search
          </Button>
          {search ? (
            <Button asChild type="button" variant="ghost" className="shrink-0">
              <Link href={ROUTE}>Clear</Link>
            </Button>
          ) : null}
        </form>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {search
              ? `${total.toLocaleString()} matchings for "${search}"`
              : `${total.toLocaleString()} matchings`}
          </span>
          <span>
            Page {currentPage} of {totalPages}
          </span>
        </div>

        {errorMessage ? (
          <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : (
          <div className="rounded-2xl border border-border/60">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Competitor brand</TableHead>
                  <TableHead>Competitor product</TableHead>
                  <TableHead>Betco product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Line</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No matchings found.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id ?? `${row.competitorId}-${row.productKey}-${row.competitorProductName}`}>
                      <TableCell className="font-medium text-foreground">
                        {row.competitorBrand ?? '—'}
                      </TableCell>
                      <TableCell className="max-w-xs whitespace-normal">
                        {row.competitorProductName ?? '—'}
                      </TableCell>
                      <TableCell className="max-w-xs whitespace-normal">
                        {row.betcoTitle ?? (
                          <span className="text-muted-foreground">Unmatched</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {row.betcoSku ?? row.betcoInventoryId ?? '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {row.betcoProductLineId ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {!errorMessage && totalPages > 1 ? (
          <nav className="flex flex-wrap items-center justify-center gap-2" aria-label="Mappings pagination">
            <Button
              asChild
              variant="outline"
              size="sm"
              className={currentPage === 1 ? 'pointer-events-none opacity-50' : undefined}
            >
              <Link href={buildHref(search, Math.max(1, currentPage - 1))}>Previous</Link>
            </Button>
            {paginationPages.map((pageNumber) => (
              <Button
                key={pageNumber}
                asChild
                size="sm"
                variant={pageNumber === currentPage ? 'default' : 'outline'}
              >
                <Link href={buildHref(search, pageNumber)}>{pageNumber}</Link>
              </Button>
            ))}
            <Button
              asChild
              variant="outline"
              size="sm"
              className={currentPage === totalPages ? 'pointer-events-none opacity-50' : undefined}
            >
              <Link href={buildHref(search, Math.min(totalPages, currentPage + 1))}>Next</Link>
            </Button>
          </nav>
        ) : null}
      </CardContent>
    </Card>
  );
}
