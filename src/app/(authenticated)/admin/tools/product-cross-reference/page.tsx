import { GitCompareArrows } from 'lucide-react';

import { ProductCrossReferenceTester } from '~/components/admin/ProductCrossReferenceTester';

export const metadata = {
  title: 'Product cross-reference tester | Betco BEX Admin',
  description:
    'Test lookup_cross_reference against legacy competitor mapping (same logic as Bex agents).',
};

export default async function ProductCrossReferenceTesterPage() {
  return (
    <main className="min-w-0 p-4 sm:p-6">
      <div className="rounded-[2rem] border border-border/60 bg-background p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <GitCompareArrows className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-muted-foreground">Tools</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
              Product cross-reference
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Exercise only the competitor → Betco mapping tool. Results mirror
              what{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                lookup_cross_reference
              </code>{' '}
              returns in chat—no other product tools are invoked.
            </p>
          </div>
        </div>

        <div className="mt-8">
          <ProductCrossReferenceTester />
        </div>
      </div>
    </main>
  );
}
