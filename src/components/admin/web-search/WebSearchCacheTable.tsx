import { Database } from 'lucide-react';

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

export function WebSearchCacheTable({
  entries,
  ttlMs,
}: {
  entries: WebSearchCacheEntry[];
  ttlMs: number;
}) {
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
            still active).
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
                <tr key={entry.cacheKey} className="align-top">
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
    </section>
  );
}
