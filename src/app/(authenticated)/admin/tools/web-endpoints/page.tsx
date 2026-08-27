import { Globe } from 'lucide-react';
import Link from 'next/link';

import { EndpointDocumentation } from '~/components/admin/EndpointDocumentation';
import { webEndpoints } from '~/lib/endpoints/definitions';

export const metadata = {
  title: 'Web Endpoints | Betco BEX Admin',
  description: 'Complete documentation for all API endpoints and web services.',
};

export default function WebEndpointsPage() {
  const endpointsByCategory = webEndpoints.reduce(
    (acc, endpoint) => {
      if (!acc[endpoint.category]) {
        acc[endpoint.category] = [];
      }
      acc[endpoint.category].push(endpoint);
      return acc;
    },
    {} as Record<string, typeof webEndpoints>,
  );

  const categories = Object.keys(endpointsByCategory).sort();

  return (
    <main className="min-w-0 p-4 sm:p-6">
      <div className="rounded-[2rem] border border-border/60 bg-background p-6 shadow-sm sm:p-8">
        <div className="mb-8">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Globe className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-muted-foreground">Tools</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
                Web Endpoints
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Complete documentation for all API endpoints and web services. Includes Bex chat,
                orchestrator, SME agents, tools, RAG search, and admin utilities. Each endpoint shows
                its HTTP method, parameters, authentication requirements, and usage patterns.
              </p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2 rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground">
            <span className="font-semibold">Total endpoints:</span>
            <code className="rounded bg-muted px-2 py-1 font-mono">{webEndpoints.length}</code>
            <span className="ml-2">
              These endpoints power the Bex UI, orchestrator, agent invocation, and admin testing.
            </span>
          </div>
        </div>

        <Link href="/admin/tools" className="inline-flex gap-2 text-sm text-primary hover:underline mb-6">
          <span>← Back to tools</span>
        </Link>

        <div className="space-y-8">
          {categories.map((category) => (
            <div key={category}>
              <h2 className="mb-4 text-lg font-semibold text-foreground">{category}</h2>
              <div className="space-y-3">
                {endpointsByCategory[category].map((endpoint, index) => (
                  <div key={`${endpoint.path}-${endpoint.method}-${index}`}>
                    <EndpointDocumentation endpoint={endpoint} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
