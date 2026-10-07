'use client';

import { Database, ExternalLink } from 'lucide-react';
import { useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import type { WebSearchCacheEntry } from '~/lib/websearch/db-cache';

function fmtDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Humanize a duration in ms into the largest whole-ish unit, e.g. 600000 → "10 minutes". */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return 'no time';
  }
  const units: Array<[label: string, size: number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1_000],
  ];
  for (const [label, size] of units) {
    if (ms >= size) {
      const value = Math.round((ms / size) * 10) / 10;
      return `${value} ${label}${value === 1 ? '' : 's'}`;
    }
  }
  return `${ms} ms`;
}

function TrustBadge({ tier }: { tier?: string }) {
  if (!tier) {
    return null;
  }
  const styles: Record<string, string> = {
    authoritative: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    standard: 'bg-muted text-muted-foreground',
    low: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[0.65rem] font-medium ${styles[tier] ?? styles.standard}`}
    >
      {tier}
    </span>
  );
}

/** Full cached response for one entry, rendered inside the row-click Dialog. */
function CacheEntryDetail({ entry }: { entry: WebSearchCacheEntry }) {
  const { response } = entry;

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Provider</dt>
          <dd className="font-medium text-foreground">{entry.provider}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Results</dt>
          <dd className="font-medium tabular-nums text-foreground">{entry.resultCount ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cache hits</dt>
          <dd className="font-medium tabular-nums text-foreground">{entry.hitCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cached</dt>
          <dd className="font-medium text-foreground">{fmtDateTime(entry.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Expires</dt>
          <dd className="font-medium text-foreground">{fmtDateTime(entry.expiresAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="font-medium text-foreground">{entry.expired ? 'Expired' : 'Active'}</dd>
        </div>
      </dl>

      {response?.metrics ? (
        <div className="rounded-2xl border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
          Original run: {Math.round(response.metrics.latencyMs)} ms latency ·{' '}
          {response.metrics.resultCount} results · est. $
          {response.metrics.estimatedCostUsd.toFixed(3)}
        </div>
      ) : null}

      {response?.answer ? (
        <div>
          <p className="mb-1 text-xs font-semibold text-muted-foreground">Answer</p>
          <p className="rounded-2xl border border-border/60 bg-muted/30 p-3 text-sm text-foreground">
            {response.answer}
          </p>
        </div>
      ) : null}

      <div>
        <p className="mb-2 text-xs font-semibold text-muted-foreground">
          Results {response ? `(${response.results.length})` : ''}
        </p>
        {!response ? (
          <p className="text-sm text-muted-foreground">
            Stored response could not be parsed — the schema may have changed since it was cached.
          </p>
        ) : response.results.length === 0 ? (
          <p className="text-sm text-muted-foreground">No results in the cached response.</p>
        ) : (
          <ul className="space-y-3">
            {response.results.map((r, i) => (
              <li
                key={`${r.url}-${i}`}
                className="rounded-2xl border border-border/60 bg-background p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:underline"
                  >
                    {r.title || r.url}
                    <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                  </a>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {r.score.toFixed(2)}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground" title={r.url}>
                  {r.sourceDomain ?? r.url}
                </p>
                {r.snippet ? (
                  <p className="mt-2 text-sm text-muted-foreground">{r.snippet}</p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <TrustBadge tier={r.trustTier} />
                  {r.publishedAt ? (
                    <span className="text-[0.65rem] text-muted-foreground">
                      {fmtDateTime(r.publishedAt)}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function WebSearchCacheTable({
  entries,
  ttlMs,
}: {
  entries: WebSearchCacheEntry[];
  ttlMs: number;
}) {
  const [selected, setSelected] = useState<WebSearchCacheEntry | null>(null);
  const activeCount = entries.filter((e) => !e.expired).length;

  return (
    <section className="rounded-[2rem] border border-border/60 bg-background p-6 shadow-sm sm:p-8">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Database className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-muted-foreground">Durable cache</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
            Cached results
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Entries in <code className="rounded bg-muted px-1.5 py-0.5 text-xs">web_search_cache</code>.
            A repeated identical query is served from here instead of re-billing the provider for{' '}
            <span className="font-medium text-foreground">{fmtDuration(ttlMs)}</span> (the cache
            duration), after which it expires. Showing the {entries.length} most recent ({activeCount}{' '}
            still active). Click a row to inspect the cached response.
          </p>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-border/60">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/50">
            <tr>
              {['Query', 'Provider', 'Results', 'Hits', 'Cached', 'Status'].map((h) => (
                <th
                  key={h}
                  className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No cached web searches yet. Run a query above (with{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    WEBSEARCH_DB_CACHE_ENABLED=true
                  </code>
                  ) to populate the cache.
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <tr
                  key={entry.cacheKey}
                  className="cursor-pointer align-top transition-colors hover:bg-muted/40"
                  onClick={() => setSelected(entry)}
                  tabIndex={0}
                  role="button"
                  aria-label={`Inspect cached search: ${entry.query}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(entry);
                    }
                  }}
                >
                  <td className="max-w-[22rem] px-4 py-3">
                    <p className="truncate font-medium text-foreground" title={entry.query}>
                      {entry.query}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                      {entry.provider}
                    </span>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-foreground">
                    {entry.resultCount ?? '—'}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">{entry.hitCount}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                    {fmtDateTime(entry.createdAt)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {entry.expired ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        Expired
                      </span>
                    ) : (
                      <span
                        className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"
                        title={`Expires ${fmtDateTime(entry.expiresAt)}`}
                      >
                        Active
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-hidden sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle className="pr-8 wrap-break-word">{selected?.query}</DialogTitle>
            <DialogDescription>Cached response from the durable web-search cache.</DialogDescription>
          </DialogHeader>
          {selected ? <CacheEntryDetail entry={selected} /> : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
