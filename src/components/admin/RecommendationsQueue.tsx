import Link from 'next/link';

import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { FormSelectField } from '~/components/admin/FormSelectField';
import { RecommendationRowPanel } from '~/components/admin/RecommendationRowPanel';
import type { RecommendationMetrics } from '~/lib/recommendations/repository';
import type {
  RecommendationStatus,
  RecommendationWithCandidates,
} from '~/lib/recommendations/recommendation-schemas';

/**
 * B0-95 — human review queue for `recommend_cross_reference` output, mirrors the failure-queue
 * triage page's layout (filters → status counts → list → pagination). B0-96 adds the "Engine
 * performance" metrics strip and wires `RecommendationRowPanel`'s Verify action to promote into
 * the fast-path override.
 */

const ROUTE = '/admin/tools/cross-reference/recommendations';
const PAGE_LINK_WINDOW = 5;

const STATUS_OPTIONS: Array<{ value: RecommendationStatus; label: string }> = [
  { value: 'pending', label: 'Pending' },
  // B0-353 — the validator-forced-review outcome; distinct from a fresh, undecided `pending` row.
  { value: 'escalated', label: 'Escalated' },
  { value: 'answered', label: 'Answered' },
  { value: 'declined', label: 'Declined' },
  { value: 'verified', label: 'Verified' },
  { value: 'rejected', label: 'Rejected' },
];

const STATUS_BADGE_VARIANT: Record<
  RecommendationStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  pending: 'outline',
  escalated: 'destructive',
  answered: 'secondary',
  declined: 'outline',
  verified: 'default',
  rejected: 'destructive',
};

function buildHref(status: string, minConfidence: string, page: number) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (minConfidence) params.set('minConfidence', minConfidence);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `${ROUTE}?${qs}` : ROUTE;
}

function buildPagination(currentPage: number, totalPages: number) {
  const half = Math.floor(PAGE_LINK_WINDOW / 2);
  const end = Math.min(totalPages, Math.max(currentPage + half, PAGE_LINK_WINDOW));
  const start = Math.max(1, end - PAGE_LINK_WINDOW + 1);
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);
}

function formatPercent(value: number | null) {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function MetricTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-foreground">{value}</dd>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function RecommendationsQueue({
  loadError,
  items,
  page,
  pageSize,
  total,
  statusCounts,
  metrics,
  currentStatus,
  currentMinConfidence,
}: {
  loadError: string | null;
  items: RecommendationWithCandidates[];
  page: number;
  pageSize: number;
  total: number;
  statusCounts: Record<RecommendationStatus, number> | null;
  metrics: RecommendationMetrics | null;
  currentStatus?: RecommendationStatus;
  currentMinConfidence?: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const paginationPages = buildPagination(page, totalPages);
  const statusValue = currentStatus ?? '';
  const minConfidenceValue = currentMinConfidence != null ? String(currentMinConfidence) : '';
  const hasFilters = Boolean(currentStatus) || currentMinConfidence != null;

  return (
    <div className="space-y-6">
      {metrics ? (
        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardHeader>
            <CardTitle>Engine performance</CardTitle>
            <CardDescription>Aggregates across every recommendation ever generated.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <MetricTile label="Total" value={metrics.total.toLocaleString()} />
              <MetricTile label="Answer rate" value={formatPercent(metrics.answerRate)} />
              <MetricTile label="Decline rate" value={formatPercent(metrics.declineRate)} />
              <MetricTile label="Avg confidence" value={formatPercent(metrics.avgConfidence)} />
              <MetricTile
                label="Verification accuracy"
                value={formatPercent(metrics.verificationAccuracy)}
                hint={`${metrics.verifiedCount} verified · ${metrics.rejectedCount} rejected`}
              />
              <MetricTile
                label="Pending review"
                value={(statusCounts?.pending ?? 0).toLocaleString()}
              />
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card className="rounded-3xl border border-border/60 shadow-none">
        <CardContent className="pt-6">
          <form action={ROUTE} method="get" className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <Label htmlFor="rec-status">Status</Label>
              <FormSelectField
                className="w-40"
                defaultValue={statusValue}
                id="rec-status"
                name="status"
                options={[
                  { value: '', label: 'All statuses' },
                  ...STATUS_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label })),
                ]}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rec-min-confidence">Min confidence</Label>
              <Input
                id="rec-min-confidence"
                name="minConfidence"
                type="number"
                min={0}
                max={1}
                step={0.05}
                defaultValue={minConfidenceValue}
                placeholder="e.g. 0.8"
                className="w-32"
              />
            </div>
            <Button type="submit">Apply</Button>
            {hasFilters ? (
              <Button asChild type="button" variant="ghost">
                <Link href={ROUTE}>Clear</Link>
              </Button>
            ) : null}
            <div className="ml-auto flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((opt) => (
                <Badge key={opt.value} variant={STATUS_BADGE_VARIANT[opt.value]}>
                  {opt.label}: {statusCounts?.[opt.value] ?? 0}
                </Badge>
              ))}
            </div>
          </form>
        </CardContent>
      </Card>

      {loadError ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {loadError}
        </div>
      ) : (
        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Recommendations</CardTitle>
              <CardDescription>Newest first · {total.toLocaleString()} total</CardDescription>
            </div>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
          </CardHeader>
          <CardContent className="space-y-3">
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recommendations match this filter.</p>
            ) : (
              items.map((rec) => <RecommendationRowPanel key={rec.id} recommendation={rec} />)
            )}
          </CardContent>
        </Card>
      )}

      {!loadError && totalPages > 1 ? (
        <nav
          aria-label="Recommendations pagination"
          className="flex flex-wrap items-center justify-center gap-2"
        >
          <Button
            asChild
            variant="outline"
            size="sm"
            className={page === 1 ? 'pointer-events-none opacity-50' : undefined}
          >
            <Link href={buildHref(statusValue, minConfidenceValue, Math.max(1, page - 1))}>
              Previous
            </Link>
          </Button>
          {paginationPages.map((p) => (
            <Button key={p} asChild size="sm" variant={p === page ? 'default' : 'outline'}>
              <Link href={buildHref(statusValue, minConfidenceValue, p)}>{p}</Link>
            </Button>
          ))}
          <Button
            asChild
            variant="outline"
            size="sm"
            className={page === totalPages ? 'pointer-events-none opacity-50' : undefined}
          >
            <Link href={buildHref(statusValue, minConfidenceValue, Math.min(totalPages, page + 1))}>
              Next
            </Link>
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
