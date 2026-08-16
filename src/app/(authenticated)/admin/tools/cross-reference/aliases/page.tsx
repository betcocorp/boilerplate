import { AliasReviewQueue } from '~/components/admin/AliasReviewQueue';
import { listUnverifiedProductAliasesForReview } from '~/lib/rag/product-alias-review-repository';
import { readSearchParam } from '~/lib/utils/params';

/**
 * B0-487 — this route is auth-gated the same way as every other `/admin/*` page: `src/proxy.ts`
 * (`withAuth`, matcher excludes only `api`/`_next`/`favicon`/`/`) requires a valid NextAuth session
 * before this ever renders, which is also why sibling pages in this area (lookup/page.tsx,
 * recommendations/page.tsx) have no session check of their own. The mutation server actions
 * (`~/lib/rag/product-alias-review-actions.ts`) additionally call `getServerSession(authOptions)`
 * directly — the same explicit pattern the `/api/admin/tools/*` routes use — since that identity is
 * also what gets stamped into `reviewed_by`.
 */
export const metadata = {
  title: 'Cross-reference · Alias review | Betco BEX Admin',
  description:
    'Review, edit, approve, or reject unverified rag.product_alias rows before they can anchor product resolution.',
};

const PAGE_SIZE = 25;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function CrossReferenceAliasesPage({ searchParams }: PageProps) {
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
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Rows from{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">rag.product_alias</code> with{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">verified = false</code> — mostly
        seeded by the corpus-scan alias discovery job. Rows whose{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">alias_norm</code> maps to more than
        one product line (
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">rag.product_alias_conflicts</code>)
        are flagged and sorted first, since a wrong resolution there silently anchors the wrong
        product in chat and lookup tools. Approving stamps{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">reviewed_by</code>/
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">reviewed_at</code> and takes effect
        immediately — <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          resolveProductLineKeyByName
        </code>{' '}
        reads this table directly on every call, with no cache to invalidate.
      </p>

      <AliasReviewQueue
        items={result?.items ?? []}
        loadError={loadError}
        page={result?.page ?? page}
        pageSize={result?.pageSize ?? PAGE_SIZE}
        total={result?.total ?? 0}
        truncated={result?.truncated ?? false}
      />
    </div>
  );
}
