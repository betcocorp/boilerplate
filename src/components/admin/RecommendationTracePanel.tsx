import { ExternalLink } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '~/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import type { RecommendationStatus, RecommendationWithCandidates } from '~/lib/recommendations/recommendation-schemas';

/**
 * B0-1055 (Solution item 5) — full evidence trace for a single recommendation.
 *
 * `recommendation.evidence` is untyped jsonb produced by `runWebGroundedPath`
 * (`~/lib/recommendations/recommend-cross-reference.ts`); every field here is read defensively
 * since the exact shape varies by path (web-grounded answer/decline, legacy match, self-reference
 * backstop, latency-ceiling fallback) and can gain fields over time (e.g. `spec.manufacturer`).
 * This is a read-only audit view — no edit/verify/reject actions live here; those stay on the
 * list page (`RecommendationRowPanel.tsx`).
 */

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

type WebSearchTelemetry = {
  searchesUsed?: number | null;
  estimatedCostUsd?: number | null;
  escalated?: boolean | null;
  budgetExceeded?: boolean | null;
};

type WebSearchResult = { url: string; title?: string | null; snippet?: string | null };

type WebSearchResults = { query?: string | null; results?: WebSearchResult[] | null };

type SelfReference = { url?: string | null; title?: string | null };

type Validation = {
  approved?: boolean | null;
  confidence?: number | null;
  requiresHumanReview?: boolean | null;
  issues?: unknown[] | null;
  unsupportedClaims?: unknown[] | null;
  gatePassed?: boolean | null;
  reasons?: string[] | null;
};

type TimingBreakdown = {
  totalMs?: number | null;
  legacyLookupMs?: number | null;
  webSearchMs?: number | null;
  enrichMs?: number | null;
  retrieveMs?: number | null;
  filterGroundedMs?: number | null;
  validateMs?: number | null;
  stepsRun?: string[] | null;
  searchesUsed?: number | null;
  escalated?: boolean | null;
  legacyCacheHit?: boolean | null;
  timedOutStep?: string | null;
};

type TraceEvidence = {
  source?: string | null;
  traceId?: string | null;
  webSearchResults?: WebSearchResults | null;
  webSearch?: WebSearchTelemetry | null;
  score?: Record<string, unknown> | null;
  validation?: Validation | null;
  selfReference?: SelfReference | null;
  timingBreakdown?: TimingBreakdown | null;
  spec?: Record<string, unknown> | null;
  sources?: Array<{ url: string; title?: string | null; score?: number | null }> | null;
  droppedCandidates?: number | null;
  cappedCount?: number | null;
  normalizedInput?: unknown;
  totalCandidates?: number | null;
  timeout?: Record<string, unknown> | null;
};

function formatPercent(value: number | null | undefined) {
  return value == null ? 'not recorded' : `${(value * 100).toFixed(1)}%`;
}

function formatDate(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function formatMs(value: number | null | undefined) {
  return value == null ? '—' : `${value.toLocaleString()} ms`;
}

function formatValue(value: unknown): string {
  if (value == null) return 'not recorded';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value || 'not recorded';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function KeyValueList({ data }: { data: Record<string, unknown> | null | undefined }) {
  const entries = data ? Object.entries(data) : [];
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Not recorded.</p>;
  }
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <div className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-1" key={key}>
          <dt className="text-xs text-muted-foreground">{key}</dt>
          <dd className="truncate text-right text-sm text-foreground">{formatValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RecommendationTracePanel({
  recommendation,
  matchingWorkflowRunId,
}: {
  recommendation: RecommendationWithCandidates;
  /** Best-effort `public.workflow_runs.id` match for the traceId, or null when there isn't one. */
  matchingWorkflowRunId: string | null;
}) {
  const evidence = recommendation.evidence as TraceEvidence;
  const normalizedInput = recommendation.normalizedInput as { traceId?: string | null } | null;
  const traceId = evidence?.traceId ?? normalizedInput?.traceId ?? null;

  const timing = evidence?.timingBreakdown ?? null;
  const timingEntries = timing
    ? ([
        ['totalMs', timing.totalMs],
        ['legacyLookupMs', timing.legacyLookupMs],
        ['webSearchMs', timing.webSearchMs],
        ['enrichMs', timing.enrichMs],
        ['retrieveMs', timing.retrieveMs],
        ['filterGroundedMs', timing.filterGroundedMs],
        ['validateMs', timing.validateMs],
      ] as const)
    : [];

  return (
    <div className="space-y-4">
      <Card className="rounded-3xl border border-border/60 shadow-none">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="text-xl">
                {recommendation.competitorBrand ? `${recommendation.competitorBrand} — ` : ''}
                {recommendation.competitorProduct}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Created {formatDate(recommendation.createdAt)} · Updated{' '}
                {formatDate(recommendation.updatedAt)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS_BADGE_VARIANT[recommendation.status]}>
                {recommendation.status}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {formatPercent(recommendation.overallConfidence)} conf. · threshold{' '}
                {formatPercent(recommendation.thresholdUsed)}
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Source: <span className="text-foreground">{evidence?.source ?? 'unknown'}</span>
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            traceId: {traceId ?? 'not recorded'}
          </p>
          {!recommendation.answerGiven && recommendation.declineReason ? (
            <p className="rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
              Declined: {recommendation.declineReason}
            </p>
          ) : null}
          {matchingWorkflowRunId ? (
            <Link
              className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
              href={`/admin/observability/${matchingWorkflowRunId}`}
            >
              View full chat workflow trace
              <ExternalLink className="size-3" />
            </Link>
          ) : null}
        </CardContent>
      </Card>

      <Card className="rounded-3xl border border-border/60 shadow-none">
        <CardHeader>
          <CardTitle>Web search</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-foreground">
            Query: <span className="text-muted-foreground">{evidence?.webSearchResults?.query ?? 'not recorded'}</span>
          </p>
          {evidence?.webSearch ? (
            <p className="text-xs text-muted-foreground">
              {evidence.webSearch.searchesUsed ?? 0} search(es)
              {evidence.webSearch.escalated ? ' · escalated' : ''}
              {evidence.webSearch.budgetExceeded ? ' · budget exceeded' : ''} · est. $
              {(evidence.webSearch.estimatedCostUsd ?? 0).toFixed(3)}
            </p>
          ) : null}
          {evidence?.webSearchResults?.results && evidence.webSearchResults.results.length > 0 ? (
            <ul className="space-y-2">
              {evidence.webSearchResults.results.map((r, i) => (
                <li className="rounded-xl border border-border/50 p-3" key={`${r.url}-${i}`}>
                  <a
                    className="text-sm text-primary underline-offset-4 hover:underline"
                    href={r.url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {r.title ?? r.url}
                  </a>
                  {r.snippet ? (
                    <p className="mt-1 text-xs text-muted-foreground">{r.snippet}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No web search results recorded.</p>
          )}
        </CardContent>
      </Card>

      {evidence?.score ? (
        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardHeader>
            <CardTitle>Scoring</CardTitle>
          </CardHeader>
          <CardContent>
            <KeyValueList data={evidence.score} />
          </CardContent>
        </Card>
      ) : null}

      {evidence?.validation ? (
        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardHeader>
            <CardTitle>Validation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>Approved: {formatValue(evidence.validation.approved)}</span>
              <span>Confidence: {formatPercent(evidence.validation.confidence)}</span>
              <span>Requires human review: {formatValue(evidence.validation.requiresHumanReview)}</span>
              <span>Gate passed: {formatValue(evidence.validation.gatePassed)}</span>
            </div>
            {evidence.validation.reasons && evidence.validation.reasons.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-foreground">Reasons</p>
                <ul className="list-inside list-disc text-xs text-muted-foreground">
                  {evidence.validation.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {evidence.validation.issues && evidence.validation.issues.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-foreground">Issues</p>
                <ul className="list-inside list-disc text-xs text-muted-foreground">
                  {evidence.validation.issues.map((issue, i) => (
                    <li key={i}>{formatValue(issue)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {evidence.validation.unsupportedClaims && evidence.validation.unsupportedClaims.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-foreground">Unsupported claims</p>
                <ul className="list-inside list-disc text-xs text-muted-foreground">
                  {evidence.validation.unsupportedClaims.map((claim, i) => (
                    <li key={i}>{formatValue(claim)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {evidence?.selfReference ? (
        <Card className="rounded-3xl border border-amber-300/60 bg-amber-50 shadow-none dark:border-amber-900/60 dark:bg-amber-950/40">
          <CardHeader>
            <CardTitle className="text-amber-800 dark:text-amber-200">
              Self-reference backstop fired (B0-876)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-amber-800 dark:text-amber-200">
              The top web result pointed back to betco.com — this is a Betco product, not a
              competitor, so no cross-reference candidates were retrieved.
            </p>
            <a
              className="mt-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
              href={evidence.selfReference.url ?? undefined}
              rel="noreferrer"
              target="_blank"
            >
              {evidence.selfReference.title ?? evidence.selfReference.url}
            </a>
          </CardContent>
        </Card>
      ) : null}

      {timing ? (
        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardHeader>
            <CardTitle>Timing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
              {timingEntries.map(([key, value]) => (
                <div key={key}>
                  <dt className="text-xs text-muted-foreground">{key}</dt>
                  <dd className="text-sm text-foreground">{formatMs(value)}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              Steps run: {timing.stepsRun && timing.stepsRun.length > 0 ? timing.stepsRun.join(' → ') : 'not recorded'}
            </p>
            {timing.timedOutStep ? (
              <p className="text-xs text-destructive">Timed out at step: {timing.timedOutStep}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {evidence?.spec ? (
        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardHeader>
            <CardTitle>Enriched competitor spec</CardTitle>
          </CardHeader>
          <CardContent>
            <KeyValueList data={evidence.spec} />
          </CardContent>
        </Card>
      ) : null}

      <Card className="rounded-3xl border border-border/60 shadow-none">
        <CardHeader>
          <CardTitle>Candidates</CardTitle>
        </CardHeader>
        <CardContent>
          {recommendation.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No candidates were retrieved.</p>
          ) : (
            <ul className="space-y-3">
              {recommendation.candidates.map((c) => (
                <li className="rounded-2xl border border-border/60 bg-muted/30 p-4" key={c.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium text-foreground">{c.betcoTitle ?? 'Betco product'}</p>
                    <span className="text-xs text-muted-foreground">
                      #{c.rank ?? '—'}
                      {c.candidateConfidence != null ? ` · ${formatPercent(c.candidateConfidence)}` : ''}
                    </span>
                  </div>
                  {c.betcoProductKey ? (
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {c.betcoProductKey}
                      {c.betcoProdId ? ` · ${c.betcoProdId}` : ''}
                    </p>
                  ) : null}
                  {c.rationale ? <p className="mt-2 text-sm text-muted-foreground">{c.rationale}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
