import { Globe, Terminal } from 'lucide-react';

import { WebSearchApiTester } from '~/components/admin/web-search/WebSearchApiTester';
import { WebSearchCacheTable } from '~/components/admin/web-search/WebSearchCacheTable';
import { WebSearchTester } from '~/components/admin/web-search/WebSearchTester';
import { listWebSearchCacheEntries } from '~/lib/websearch/db-cache';

export const metadata = {
  title: 'Web search tester | Betco BEX Admin',
  description:
    'Exercise the generic WebSearchService (Tavily by default) by hand before wiring it into agent flows.',
};

export const dynamic = 'force-dynamic';

export default async function WebSearchTesterPage() {
  const cacheEntries = await listWebSearchCacheEntries(100);

  return (
    <main className="min-w-0 space-y-6 p-4 sm:p-6">
      <div className="rounded-[2rem] border border-border/60 bg-background p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Globe className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-muted-foreground">Tools</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
              Web search
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Run ad-hoc queries against the generic{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">WebSearchService</code>{' '}
              (provider set by <code className="rounded bg-muted px-1.5 py-0.5 text-xs">WEBSEARCH_PROVIDER</code>,
              Tavily by default). Results are normalized to Bex&apos;s own shape; latency and
              estimated cost are shown per run.
            </p>
          </div>
        </div>

        <div className="mt-8">
          <WebSearchTester />
        </div>
      </div>

      <div className="rounded-[2rem] border border-border/60 bg-background p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Terminal className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-muted-foreground">Tools</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
              API test
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Exercise the client-facing endpoint{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">POST /api/v1/tools/web-search</code>{' '}
              exactly as an external API client would — server-to-server, authenticated with a
              per-client bearer token (<code className="rounded bg-muted px-1.5 py-0.5 text-xs">bex_&lt;env&gt;_…</code>).
              Same normalized response as above; use the seeded &quot;Local Dev&quot; token locally.
            </p>
          </div>
        </div>

        <div className="mt-8">
          <WebSearchApiTester />
        </div>
      </div>

      <WebSearchCacheTable entries={cacheEntries} />
    </main>
  );
}
