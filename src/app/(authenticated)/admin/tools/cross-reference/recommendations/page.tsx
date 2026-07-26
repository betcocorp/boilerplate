import { GitCompareArrows } from 'lucide-react';

import { RecommendationsQueue } from '~/components/admin/RecommendationsQueue';
import { recommendationStatusSchema } from '~/lib/recommendations/recommendation-schemas';
import {
  countRecommendationsByStatus,
  listRecommendationsWithCandidates,
} from '~/lib/recommendations/repository';
import { readSearchParam } from '~/lib/utils/params';

export const metadata = {
  title: 'Cross-reference recommendations | Betco BEX Admin',
  description:
    'Review, verify, reject, or correct web-grounded cross-reference recommendations.',
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

  try {
    [listResult, statusCounts] = await Promise.all([
      listRecommendationsWithCandidates({ status, minConfidence, page, pageSize: PAGE_SIZE }),
      countRecommendationsByStatus(),
    ]);
  } catch (error) {
    loadError =
      error instanceof Error ? error.message : 'Unable to load cross-reference recommendations.';
  }

  return (
    <main className="min-w-0 p-4 sm:p-6">
      <div className="rounded-[2rem] border border-border/60 bg-background p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <GitCompareArrows className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-muted-foreground">Tools</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
              Cross-reference recommendations
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Human-in-the-loop review of{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">recommend_cross_reference</code>{' '}
              output — verify, reject with a reason, or correct the chosen Betco candidate.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6">
        <RecommendationsQueue
          currentMinConfidence={minConfidence}
          currentStatus={status}
          items={listResult?.items ?? []}
          loadError={loadError}
          page={listResult?.page ?? page}
          pageSize={listResult?.pageSize ?? PAGE_SIZE}
          statusCounts={statusCounts}
          total={listResult?.total ?? 0}
        />
      </div>
    </main>
  );
}
