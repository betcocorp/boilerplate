'use client';

import { ExternalLink, Loader2, Terminal } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { WebSearchResultsSkeleton } from '~/components/admin/web-search/WebSearchResultsSkeleton';
import { apiWebSearchV1Tool } from '~/lib/websearch/websearch-api-client';
import { getErrorMessage } from '~/lib/utils';
import type {
  WebSearchDepth,
  WebSearchResponse,
} from '~/lib/websearch/websearch-schemas';

/**
 * Exercises the token-authenticated v1 tool endpoint (`/api/v1/tools/web-search`)
 * — the same surface external API clients call. Mirrors {@link WebSearchTester},
 * but posts a per-client bearer token instead of relying on the admin session.
 */
export function WebSearchApiTester() {
  const [token, setToken] = useState('');
  const [query, setQuery] = useState('');
  const [depth, setDepth] = useState<WebSearchDepth>('basic');
  const [domains, setDomains] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<WebSearchResponse | null>(null);

  const run = async () => {
    const q = query.trim();
    const t = token.trim();
    if (!q || !t || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    const parsedDomains = domains
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    try {
      const result = await apiWebSearchV1Tool(
        {
          query: q,
          depth,
          domains: parsedDomains.length > 0 ? parsedDomains : undefined,
        },
        t,
      );
      setResponse(result);
    } catch (err) {
      setError(getErrorMessage(err, 'API request failed'));
      setResponse(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="api-test-token">API token</Label>
          <Input
            autoComplete="off"
            className="h-10 rounded-2xl font-mono"
            id="api-test-token"
            onChange={(event) => setToken(event.target.value)}
            placeholder="bex_dev_…"
            type="password"
            value={token}
          />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="api-test-query">Query</Label>
            <Input
              id="api-test-query"
              className="h-10 rounded-2xl"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="e.g. Spartan Chemical BNC-15 disinfectant specs"
              value={query}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="api-test-depth">Depth</Label>
            <Select onValueChange={(v) => setDepth(v as WebSearchDepth)} value={depth}>
              <SelectTrigger className="h-10 w-full rounded-2xl sm:w-36" id="api-test-depth">
                <SelectValue placeholder="Depth" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="basic">Basic</SelectItem>
                <SelectItem value="advanced">Advanced</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 space-y-1.5 sm:w-56">
            <Label htmlFor="api-test-domains">Include domains</Label>
            <Input
              id="api-test-domains"
              className="h-10 rounded-2xl"
              onChange={(event) => setDomains(event.target.value)}
              placeholder="betco.com, epa.gov"
              value={domains}
            />
          </div>
          <Button
            className="h-10 rounded-2xl"
            disabled={loading || !query.trim() || !token.trim()}
            type="submit"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Terminal className="size-4" />}
            Call API
          </Button>
        </div>
      </form>

      {error ? (
        <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading ? <WebSearchResultsSkeleton /> : null}

      {!loading && response ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge className="rounded-full" variant="secondary">
              provider: {response.provider}
            </Badge>
            <Badge className="rounded-full" variant="outline">
              {response.metrics.resultCount} results
            </Badge>
            <Badge className="rounded-full" variant="outline">
              {response.metrics.latencyMs}ms
            </Badge>
            <Badge className="rounded-full" variant="outline">
              ~${response.metrics.estimatedCostUsd.toFixed(3)}
            </Badge>
            {response.metrics.cached ? (
              <Badge className="rounded-full" variant="secondary">
                cached
              </Badge>
            ) : null}
          </div>

          {response.answer ? (
            <div className="rounded-2xl border border-border/60 bg-muted/30 p-3 text-sm">
              <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Answer
              </p>
              <p className="whitespace-pre-wrap wrap-break-word text-foreground">
                {response.answer}
              </p>
            </div>
          ) : null}

          {response.results.length === 0 ? (
            <p className="rounded-xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground">
              No results for this query.
            </p>
          ) : (
            <ul className="space-y-2">
              {response.results.map((result) => (
                <li
                  className="rounded-2xl border border-border/60 bg-background p-3"
                  key={result.url}
                >
                  <div className="flex items-start justify-between gap-2">
                    <a
                      className="flex min-w-0 items-center gap-1 font-medium text-foreground hover:underline"
                      href={result.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <span className="truncate">{result.title || result.url}</span>
                      <ExternalLink className="size-3.5 shrink-0 opacity-60" />
                    </a>
                    <div className="flex shrink-0 items-center gap-1">
                      {result.trustTier ? (
                        <Badge
                          className="rounded-full text-[0.62rem]"
                          variant={result.trustTier === 'authoritative' ? 'default' : 'secondary'}
                        >
                          {result.trustTier}
                        </Badge>
                      ) : null}
                      <Badge className="rounded-full text-[0.62rem]" variant="outline">
                        {result.score.toFixed(2)}
                      </Badge>
                    </div>
                  </div>
                  <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
                    {result.snippet}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground/70">{result.url}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
