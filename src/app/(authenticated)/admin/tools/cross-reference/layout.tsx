import { GitCompareArrows } from 'lucide-react';
import type { ReactNode } from 'react';

import { CrossReferenceTabs } from '~/components/admin/CrossReferenceTabs';

export const metadata = {
  title: 'Cross-reference | Betco BEX Admin',
  description:
    'Competitor → Betco cross-reference: fast-path lookup, the 1:1 mapping browser, the web-grounded recommendation review queue, and unverified alias review.',
};

export default function CrossReferenceLayout({ children }: { children: ReactNode }) {
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
              Cross-reference
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Competitor → Betco mapping. Test the fast-path lookup and browse the 1:1 mappings,
              review web-grounded recommendations before they are promoted into the fast-path table,
              or review unverified product aliases before they can anchor product resolution.
            </p>
          </div>
        </div>

        <div className="mt-6">
          <CrossReferenceTabs />
        </div>
      </div>

      <div className="mt-6">{children}</div>
    </main>
  );
}
