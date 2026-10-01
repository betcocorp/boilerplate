import { Tags } from 'lucide-react';

import { AliasReviewQueue } from '~/components/admin/AliasReviewQueue';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import { listUnverifiedProductAliasesForReview } from '~/lib/rag/product-alias-review-repository';
import { readSearchParam } from '~/lib/utils/params';

/**
 * B0-1058 — split out of the Cross-reference tabs into its own standalone tool page. Auth-gated
 * the same way as every other `/admin/*` page (`src/proxy.ts`, `withAuth`), plus the explicit
 * `requirePagePermission` call below since this route no longer inherits a shared layout's check.
 * The mutation server actions (`~/lib/rag/product-alias-review-actions.ts`) additionally call
 * `getServerSession(authOptions)` directly — the same explicit pattern the `/api/admin/tools/*`
 * routes use — since that identity is also what gets stamped into `reviewed_by`.
 */
export const metadata = {
  title: 'Aliases | Betco BEX Admin',
  description:
    'Review, edit, approve, or reject unverified rag.product_alias rows before they can anchor product resolution.',
};

const PAGE_SIZE = 25;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AliasesPage({ searchParams }: PageProps) {
  await requirePagePermission(PERMISSIONS.NAVIGATION_SIDEBAR_TOOLS, 'GET /admin/tools/aliases');

  const params = await searchParams;
  const pageRaw = Number.parseInt(readSearchParam(params.page, '1'), 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  let loadError: string | null = null;
  let result: Awaited<ReturnType<typeof listUnverifiedProductAliasesForReview>> | null = null;

  try {
    result = await listUnverifiedProductAliasesForReview({ page, pageSize: PAGE_SIZE });
  } catch (error) {
    loadError = error instanceof Error ? error.message : 'Unable to load unverified aliases.';
  }

  return (
    <main className="min-w-0 space-y-6 p-4 sm:p-6">
      <div className="rounded-[2rem] border border-border/60 bg-background p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Tags className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-muted-foreground">Tools</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
              Aliases
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Rows from{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">rag.product_alias</code>{' '}
              with <code className="rounded bg-muted px-1.5 py-0.5 text-xs">verified = false</code>{' '}
              — mostly seeded by the corpus-scan alias discovery job. Rows whose{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">alias_norm</code> maps to
              more than one product line (
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                rag.product_alias_conflicts
              </code>
              ) are flagged and sorted first, since a wrong resolution there silently anchors the
              wrong product in chat and lookup tools. Approving stamps{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">reviewed_by</code>/
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">reviewed_at</code> and
              takes effect immediately —{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                resolveProductLineKeyByName
              </code>{' '}
              reads this table directly on every call, with no cache to invalidate.
            </p>
          </div>
        </div>

        <div className="mt-8">
          <AliasReviewQueue
            items={result?.items ?? []}
            loadError={loadError}
            page={result?.page ?? page}
            pageSize={result?.pageSize ?? PAGE_SIZE}
            total={result?.total ?? 0}
            truncated={result?.truncated ?? false}
          />
        </div>
      </div>
    </main>
  );
}
