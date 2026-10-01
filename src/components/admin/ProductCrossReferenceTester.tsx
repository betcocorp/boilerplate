'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Skeleton } from '~/components/ui/skeleton';
import {
  logSearchResultClick,
  logSearchSubmit,
} from '~/lib/event-logging/search-events';
import { lookupCrossReferenceInputSchema } from '~/lib/tools/tool-schemas';

/** B0-761 — stable analytics surface id for this tester. */
const XREF_SEARCH_SURFACE = 'cross-reference-tester';

type MatchRow = {
  legacyRowId?: string | null;
  competitorBrand: string | null;
  competitorProductName: string | null;
  productKey: string | null;
  matchType: string;
  confidence: number;
  productUrl: string | null;
  productUrlSource: string;
  betcoProduct: {
    title: string | null;
    sku: string | null;
    shortLabel: string | null;
    inventoryId: string | null;
  } | null;
};

type LookupOk = {
  ok: true;
  brandCandidates: string[];
  totalCandidates: number;
  fallbackRecommended: boolean;
  matches: MatchRow[];
};

type RecommendationCandidate = {
  betcoProductKey: string | null;
  betcoTitle: string | null;
  confidence: number | null;
  rank: number;
  url: string | null;
  rationale: string | null;
};

type RecommendationSpec = {
  chemistryClass: string | null;
  epaRegistration: string | null;
  contactTimeSeconds: number | null;
  dilutionOzPerGal: number | null;
  productCategory: string | null;
  primaryUse: string | null;
  formFactor: string | null;
  keyClaims: string[];
};

type RecommendationEvidence = {
  source?: string;
  spec?: RecommendationSpec | null;
  sources?: Array<{ url: string; title?: string; score?: number }>;
  webSearch?: {
    searchesUsed: number;
    estimatedCostUsd: number;
    escalated: boolean;
    budgetExceeded: boolean;
  } | null;
  validation?: { gatePassed?: boolean; reasons?: string[] } | null;
  droppedCandidates?: number;
};

type RecommendationOk = {
  ok: true;
  source: 'legacy' | 'web';
  answered: boolean;
  status: 'pending' | 'answered' | 'declined' | 'verified' | 'rejected';
  overallConfidence: number;
  thresholdUsed: number;
  candidates: RecommendationCandidate[];
  evidence: RecommendationEvidence;
  declineReason: string | null;
  recommendationId: string | null;
};

const STATUS_STYLES: Record<RecommendationOk['status'], string> = {
  answered: 'text-emerald-600 dark:text-emerald-500',
  verified: 'text-emerald-600 dark:text-emerald-500',
  declined: 'text-amber-600 dark:text-amber-500',
  rejected: 'text-amber-600 dark:text-amber-500',
  pending: 'text-sky-600 dark:text-sky-500',
};

/** One match/candidate row: title + meta, secondary line, URL line. */
function MatchRowSkeleton() {
  return (
    <li className="rounded-2xl border border-border/60 bg-muted/30 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Skeleton className="h-5 w-2/5 rounded-md" />
        <Skeleton className="h-4 w-28 rounded-md" />
      </div>
      <Skeleton className="mt-2 h-4 w-3/5 rounded-md" />
      <Skeleton className="mt-3 h-4 w-1/2 rounded-md" />
      <Skeleton className="mt-3 h-3 w-40 rounded-md" />
    </li>
  );
}

/** Stand-in for the whole "Results" card while the legacy lookup is in flight. */
function LookupResultsSkeleton() {
  return (
    <Card
      aria-live="polite"
      className="rounded-3xl border border-border/60 shadow-none"
      role="status"
    >
      <CardHeader>
        <Skeleton className="h-6 w-28 rounded-md" />
        <Skeleton className="h-4 w-4/5 rounded-md" />
        <span className="sr-only">Looking up cross-references…</span>
      </CardHeader>
      <CardContent>
        <ul className="space-y-4">
          {Array.from({ length: 3 }, (_, index) => (
            <MatchRowSkeleton key={index} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Status line + candidate rows while the web-grounded engine is running. */
function RecommendationSkeleton() {
  return (
    <div aria-live="polite" className="space-y-4" role="status">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Skeleton className="h-5 w-24 rounded-md" />
        <Skeleton className="h-4 w-64 rounded-md" />
      </div>
      <ul className="space-y-3">
        {Array.from({ length: 2 }, (_, index) => (
          <MatchRowSkeleton key={index} />
        ))}
      </ul>
      <span className="sr-only">Generating recommendation…</span>
    </div>
  );
}

export function ProductCrossReferenceTester() {
  const [brand, setBrand] = useState('');
  const [productName, setProductName] = useState('');
  const [maxResults, setMaxResults] = useState<string>('3');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LookupOk | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [recommendation, setRecommendation] = useState<RecommendationOk | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setRecError(null);
    setRecommendation(null);

    const maxNum =
      maxResults === '' ? undefined : Number.parseInt(maxResults, 10);
    const maxResultsValid =
      maxNum !== undefined && Number.isFinite(maxNum) && maxNum >= 1 && maxNum <= 10;
    const body = {
      brand: brand.trim(),
      productName: productName.trim(),
      ...(maxResultsValid ? { maxResults: maxNum } : {}),
    };

    const parsed = lookupCrossReferenceInputSchema.safeParse(body);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const first =
        fieldErrors.brand?.[0] ??
        fieldErrors.productName?.[0] ??
        fieldErrors.maxResults?.[0] ??
        'Check competitor brand and product name.';
      setError(first);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/admin/tools/product-cross-reference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(parsed.data),
      });
      const data = (await res.json()) as { error?: string } & Partial<LookupOk>;

      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Request failed');
        return;
      }

      if (data.ok !== true || !Array.isArray(data.matches)) {
        setError('Unexpected response from server');
        return;
      }

      setResult(data as LookupOk);
      // B0-761 — lengths and counts only; the brand/product text is never logged.
      logSearchSubmit({
        entityType: 'cross_reference',
        resultCount: data.matches.length,
        queryLength: parsed.data.brand.length + parsed.data.productName.length,
        surface: XREF_SEARCH_SURFACE,
        extra: { fallbackRecommended: data.fallbackRecommended === true },
      });
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  async function onGetRecommendation() {
    setRecError(null);
    setRecommendation(null);
    setRecLoading(true);
    try {
      const res = await fetch('/api/admin/tools/cross-reference-recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          competitorProduct: productName.trim(),
          ...(brand.trim() ? { competitorBrand: brand.trim() } : {}),
        }),
      });
      const data = (await res.json()) as { error?: string } & Partial<RecommendationOk>;
      if (!res.ok) {
        setRecError(typeof data.error === 'string' ? data.error : 'Request failed');
        return;
      }
      if (data.ok !== true || !Array.isArray(data.candidates)) {
        setRecError('Unexpected response from server');
        return;
      }
      setRecommendation(data as RecommendationOk);
    } catch {
      setRecError('Network error');
    } finally {
      setRecLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="rounded-3xl border border-border/60 shadow-none">
        <CardHeader>
          <CardTitle>Run lookup</CardTitle>
          <CardDescription>
            Uses the same legacy tables and ranking as the agent tool{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">lookup_cross_reference</code>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="xref-brand">Competitor brand</Label>
                <Input
                  id="xref-brand"
                  name="brand"
                  autoComplete="off"
                  placeholder="e.g. Brand name"
                  value={brand}
                  onChange={(ev) => setBrand(ev.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="xref-product">Competitor product name</Label>
                <Input
                  id="xref-product"
                  name="productName"
                  autoComplete="off"
                  placeholder="e.g. Product line or SKU phrase"
                  value={productName}
                  onChange={(ev) => setProductName(ev.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2 sm:max-w-xs">
              <Label htmlFor="xref-max">Max results</Label>
              <Select value={maxResults} onValueChange={setMaxResults}>
                <SelectTrigger id="xref-max">
                  <SelectValue placeholder="Default (3)" />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Could not run lookup</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Looking up…
                </>
              ) : (
                'Run cross-reference'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {loading ? <LookupResultsSkeleton /> : null}

      {!loading && result ? (
        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardHeader>
            <CardTitle>Results</CardTitle>
            <CardDescription>
              Brand candidates: {result.brandCandidates.length > 0 ? result.brandCandidates.join(', ') : '—'} · Raw
              rows scanned: {result.totalCandidates} ·{' '}
              <span className={result.fallbackRecommended ? 'text-amber-600 dark:text-amber-500' : ''}>
                {result.fallbackRecommended
                  ? 'Low confidence or empty — consider manual verification'
                  : 'Top match confidence acceptable for guided answer'}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {result.matches.length === 0 ? (
              <p className="text-sm text-muted-foreground">No matches returned.</p>
            ) : (
              <ul className="space-y-4">
                {result.matches.map((m, i) => (
                  <li
                    key={`${m.legacyRowId ?? m.productKey ?? i}-${i}`}
                    className="rounded-2xl border border-border/60 bg-muted/30 p-4"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-medium text-foreground">
                        {m.betcoProduct?.title ?? m.betcoProduct?.shortLabel ?? 'Betco product'}
                      </p>
                      <span className="text-xs text-muted-foreground">
                        {m.matchType} · {(m.confidence * 100).toFixed(1)}%
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {m.competitorBrand} — {m.competitorProductName}
                    </p>
                    {m.productUrl ? (
                      <p className="mt-2 text-sm">
                        <a
                          href={m.productUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                          onClick={() => {
                            // B0-761 — analytics tag, fire-and-forget.
                            logSearchResultClick({
                              entityType: 'cross_reference',
                              rank: i + 1,
                              resultId:
                                m.legacyRowId ?? m.productKey ?? String(i + 1),
                              resultCount: result.matches.length,
                              surface: XREF_SEARCH_SURFACE,
                            });
                          }}
                        >
                          {m.productUrl}
                        </a>
                        <span className="ml-2 text-xs text-muted-foreground">({m.productUrlSource})</span>
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">No product URL derived</p>
                    )}
                    {m.betcoProduct?.sku || m.betcoProduct?.inventoryId ? (
                      <p className="mt-2 font-mono text-xs text-muted-foreground">
                        {[m.betcoProduct?.sku, m.betcoProduct?.inventoryId].filter(Boolean).join(' · ')}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      {result?.fallbackRecommended ? (
        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardHeader>
            <CardTitle>Web-grounded recommendation</CardTitle>
            <CardDescription>
              The legacy lookup was low-confidence or empty. Run the web-search-grounded engine
              (<code className="rounded bg-muted px-1.5 py-0.5 text-xs">recommend_cross_reference</code>) to
              propose a Betco equivalent from enriched competitor specs.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button type="button" variant="secondary" onClick={onGetRecommendation} disabled={recLoading}>
              {recLoading ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Generating recommendation…
                </>
              ) : (
                'Get web-grounded recommendation'
              )}
            </Button>

            {recError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not generate a recommendation</AlertTitle>
                <AlertDescription>{recError}</AlertDescription>
              </Alert>
            ) : null}

            {recLoading ? <RecommendationSkeleton /> : null}

            {!recLoading && recommendation ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className={`text-sm font-medium capitalize ${STATUS_STYLES[recommendation.status]}`}>
                    {recommendation.status}
                    {recommendation.status === 'pending' ? ' (human review)' : ''}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Confidence {(recommendation.overallConfidence * 100).toFixed(1)}% · threshold{' '}
                    {(recommendation.thresholdUsed * 100).toFixed(0)}% · via {recommendation.source}
                  </span>
                </div>

                {!recommendation.answered && recommendation.declineReason ? (
                  <Alert>
                    <AlertTitle>Declined</AlertTitle>
                    <AlertDescription>{recommendation.declineReason}</AlertDescription>
                  </Alert>
                ) : null}

                {recommendation.candidates.length > 0 ? (
                  <ul className="space-y-3">
                    {recommendation.candidates.map((c, i) => (
                      <li
                        key={`${c.betcoProductKey ?? c.rank}-${i}`}
                        className="rounded-2xl border border-border/60 bg-muted/30 p-4"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="font-medium text-foreground">
                            {c.betcoTitle ?? 'Betco product'}
                          </p>
                          <span className="text-xs text-muted-foreground">
                            #{c.rank}
                            {c.confidence != null ? ` · ${(c.confidence * 100).toFixed(1)}%` : ''}
                          </span>
                        </div>
                        {c.betcoProductKey ? (
                          <p className="mt-1 font-mono text-xs text-muted-foreground">{c.betcoProductKey}</p>
                        ) : null}
                        {c.rationale ? (
                          <p className="mt-2 text-sm text-muted-foreground">{c.rationale}</p>
                        ) : null}
                        {c.url ? (
                          <p className="mt-2 text-sm">
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noreferrer"
                              className="font-medium text-primary underline-offset-4 hover:underline"
                            >
                              {c.url}
                            </a>
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No grounded candidates.</p>
                )}

                {recommendation.evidence?.spec ? (
                  <div className="rounded-2xl border border-border/60 p-4">
                    <p className="text-sm font-medium text-foreground">Extracted competitor spec</p>
                    <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                      {(
                        [
                          ['Chemistry', recommendation.evidence.spec.chemistryClass],
                          ['EPA reg.', recommendation.evidence.spec.epaRegistration],
                          ['Category', recommendation.evidence.spec.productCategory],
                          ['Primary use', recommendation.evidence.spec.primaryUse],
                          ['Form factor', recommendation.evidence.spec.formFactor],
                          [
                            'Contact time',
                            recommendation.evidence.spec.contactTimeSeconds != null
                              ? `${recommendation.evidence.spec.contactTimeSeconds}s`
                              : null,
                          ],
                          [
                            'Dilution',
                            recommendation.evidence.spec.dilutionOzPerGal != null
                              ? `${recommendation.evidence.spec.dilutionOzPerGal} oz/gal`
                              : null,
                          ],
                        ] as Array<[string, string | null]>
                      ).map(([label, value]) => (
                        <div key={label} className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="text-foreground">{value ?? '—'}</dd>
                        </div>
                      ))}
                    </dl>
                    {recommendation.evidence.spec.keyClaims.length > 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Claims: {recommendation.evidence.spec.keyClaims.join('; ')}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {recommendation.evidence?.sources && recommendation.evidence.sources.length > 0 ? (
                  <div className="rounded-2xl border border-border/60 p-4">
                    <p className="text-sm font-medium text-foreground">Web evidence</p>
                    <ul className="mt-2 space-y-1">
                      {recommendation.evidence.sources.map((s, i) => (
                        <li key={`${s.url}-${i}`} className="truncate text-sm">
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary underline-offset-4 hover:underline"
                          >
                            {s.title ?? s.url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <p className="text-xs text-muted-foreground">
                  {recommendation.evidence?.webSearch
                    ? `${recommendation.evidence.webSearch.searchesUsed} search(es)${
                        recommendation.evidence.webSearch.escalated ? ' · escalated' : ''
                      } · est. $${recommendation.evidence.webSearch.estimatedCostUsd.toFixed(3)} · `
                    : ''}
                  {recommendation.recommendationId
                    ? `recommendation ${recommendation.recommendationId}`
                    : 'not persisted'}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
