import { RecommendationsQueue } from '~/components/admin/RecommendationsQueue';
import { recommendationStatusSchema } from '~/lib/recommendations/recommendation-schemas';
import {
  countRecommendationsByStatus,
  getRecommendationMetrics,
  listRecommendationsWithCandidates,
} from '~/lib/recommendations/repository';
import { readSearchParam } from '~/lib/utils/params';

export const metadata = {
  title: 'Cross-reference · Recommendation queue | Betco BEX Admin',
  description:
    'Review, verify, and correct web-grounded cross-reference recommendations before they are promoted to the fast-path mapping.',
};

const PAGE_SIZE = 20;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function CrossReferenceRecommendationsPage({ searchParams }: PageProps) {
  const params = await searchParams;

  const statusParsed = recommendationStatusSchema.safeParse(readSearchParam(params.status));
  const status = statusParsed.success ? statusParsed.data : undefined;

  const minConfidenceRaw = readSearchParam(params.minConfidence);
  const minConfidenceParsed = minConfidenceRaw ? Number(minConfidenceRaw) : Number.NaN;
  const minConfidence = Number.isFinite(minConfidenceParsed)
    ? Math.min(1, Math.max(0, minConfidenceParsed))
    : undefined;

  const pageRaw = Number.parseInt(readSearchParam(params.page, '1'), 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  let loadError: string | null = null;
  let listResult: Awaited<ReturnType<typeof listRecommendationsWithCandidates>> | null = null;
  let statusCounts: Awaited<ReturnType<typeof countRecommendationsByStatus>> | null = null;
  let metrics: Awaited<ReturnType<typeof getRecommendationMetrics>> | null = null;

  try {
    [listResult, statusCounts, metrics] = await Promise.all([
      listRecommendationsWithCandidates({ status, minConfidence, page, pageSize: PAGE_SIZE }),
      countRecommendationsByStatus(),
      getRecommendationMetrics(),
    ]);
  } catch (error) {
    loadError =
      error instanceof Error ? error.message : 'Unable to load cross-reference recommendations.';
  }

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Human-in-the-loop review of{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">recommend_cross_reference</code>{' '}
        output. Verifying a recommendation promotes its chosen candidate into{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">cross_reference_override</code>, the
        fast-path table{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">lookup_cross_reference</code>{' '}
        consults first — so the same competitor product resolves instantly next time, with no repeat
        web search.
      </p>

      <RecommendationsQueue
        currentMinConfidence={minConfidence}
        currentStatus={status}
        items={listResult?.items ?? []}
        loadError={loadError}
        metrics={metrics}
        page={listResult?.page ?? page}
        pageSize={listResult?.pageSize ?? PAGE_SIZE}
        statusCounts={statusCounts}
        total={listResult?.total ?? 0}
      />
    </div>
  );
}
