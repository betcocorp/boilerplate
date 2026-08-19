import { ArrowRight, GitCompareArrows, Globe, Search } from 'lucide-react';
import Link from 'next/link';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';

export const metadata = {
  title: 'Tools | Betco BEX Admin',
  description: 'Landing page for admin tools and utilities.',
};

const tools = [
  {
    title: 'Cross-reference',
    description:
      'Test competitor → Betco lookups against legacy tables, browse the 1:1 mappings, and review web-grounded recommendations before promotion—the pipeline behind lookup_cross_reference and recommend_cross_reference.',
    href: '/admin/tools/cross-reference',
    icon: GitCompareArrows,
  },
  {
    title: 'Web search',
    description:
      'Run external web searches through the provider abstraction—source-trust tiers, cost/rate guardrails, and caching, the same WebSearchService agents use.',
    href: '/admin/tools/web-search',
    icon: Globe,
  },
  {
    title: 'RAG semantic search',
    description:
      'Search retrieval chunks, inspect similarity matches, and validate tool retrieval quality.',
    href: '/admin/products/rag',
    icon: Search,
  },
];

export default function AdminToolsPage() {
  return (
    <main className="min-w-0 p-4 sm:p-6">
      <div className="rounded-[2rem] border border-border/60 bg-background p-6 shadow-sm sm:p-8">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Admin workspace</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            Tools
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Central home for agent-callable tools. Use this area to view, test, and validate
            the tool surfaces available to Bex agents.
          </p>
        </div>

        <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {tools.map((tool) => {
            const Icon = tool.icon;
            return (
              <Link href={tool.href} key={tool.title}>
                <Card className="h-full rounded-3xl border border-border/60 shadow-none transition hover:bg-accent/40">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Icon className="size-5 text-primary" />
                      {tool.title}
                    </CardTitle>
                    <CardDescription>{tool.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                      Open
                      <ArrowRight className="size-4" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </section>
      </div>
    </main>
  );
}
