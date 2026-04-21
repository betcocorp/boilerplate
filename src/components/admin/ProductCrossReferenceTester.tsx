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
import { lookupCrossReferenceInputSchema } from '~/lib/tools/tool-schemas';

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

export function ProductCrossReferenceTester() {
  const [brand, setBrand] = useState('');
  const [productName, setProductName] = useState('');
  const [maxResults, setMaxResults] = useState<string>('3');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LookupOk | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

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
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
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

      {result ? (
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
    </div>
  );
}
