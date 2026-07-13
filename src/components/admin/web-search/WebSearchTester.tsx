'use client';

import { ExternalLink, Loader2, Search } from 'lucide-react';
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
import { apiWebSearch } from '~/lib/websearch/websearch-api-client';
import { getErrorMessage } from '~/lib/utils';
import type {
  WebSearchDepth,
  WebSearchResponse,
} from '~/lib/websearch/websearch-schemas';

export function WebSearchTester() {
  const [query, setQuery] = useState('');
  const [depth, setDepth] = useState<WebSearchDepth>('basic');
  const [domains, setDomains] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<WebSearchResponse | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  const run = async (raw?: string) => {
    const q = (raw ?? query).trim();
    if (!q || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    const parsedDomains = domains
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    try {
      const result = await apiWebSearch({
        query: q,
        depth,
        domains: parsedDomains.length > 0 ? parsedDomains : undefined,
      });
      setResponse(result);
      setRecent((prev) => [q, ...prev.filter((item) => item !== q)].slice(0, 8));
    } catch (err) {
      setError(getErrorMessage(err, 'Web search failed'));
      setResponse(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="web-search-query">Query</Label>
          <Input
            id="web-search-query"
            className="h-10 rounded-2xl"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. Spartan Chemical BNC-15 disinfectant specs"
            value={query}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="web-search-depth">Depth</Label>
          <Select onValueChange={(v) => setDepth(v as WebSearchDepth)} value={depth}>
            <SelectTrigger className="h-10 w-full rounded-2xl sm:w-36" id="web-search-depth">
              <SelectValue placeholder="Depth" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="basic">Basic</SelectItem>
              <SelectItem value="advanced">Advanced</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0 space-y-1.5 sm:w-56">
          <Label htmlFor="web-search-domains">Include domains</Label>
          <Input
            id="web-search-domains"
            className="h-10 rounded-2xl"
            onChange={(event) => setDomains(event.target.value)}
            placeholder="betco.com, epa.gov"
            value={domains}
          />
        </div>
        <Button className="h-10 rounded-2xl" disabled={loading || !query.trim()} type="submit">
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          Run
        </Button>
      </form>

      {recent.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Recent:</span>
          {recent.map((item) => (
            <Button
              className="h-auto rounded-full px-2.5 py-1 text-xs font-normal"
              key={item}
              onClick={() => {
                setQuery(item);
                void run(item);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {item}
            </Button>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="rounded-xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground">
          Searching…
        </p>
      ) : null}

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
                    <Badge className="shrink-0 rounded-full text-[0.62rem]" variant="outline">
                      {result.score.toFixed(2)}
                    </Badge>
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
