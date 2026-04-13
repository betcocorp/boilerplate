import { FileText, Search, Sparkles } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { AdminAccountMenu } from '~/components/admin/AdminAccountMenu';
import { AdminSidebarNav } from '~/components/admin/AdminSidebarNav';
import { Button } from '~/components/ui/button';

type AdminLayoutProps = {
  children: ReactNode;
};

export default function AdminLayout({ children }: AdminLayoutProps) {
  return (
    <div className="h-screen overflow-hidden bg-muted/40">
      <div className="grid h-screen lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="hidden h-screen overflow-hidden border-r border-border/60 bg-sidebar px-5 py-6 text-sidebar-foreground lg:flex lg:flex-col">
          <Link
            className="flex items-center gap-3 rounded-2xl px-2 py-2 text-sm font-semibold text-sidebar-foreground"
            href="/admin"
          >
            <div className="flex size-8 items-center justify-center rounded-2xl bg-sidebar-primary text-sidebar-primary-foreground">
              <Sparkles className="size-4" />
            </div>
            <span>Acme Inc.</span>
          </Link>

          <div className="mt-8">
            <AdminSidebarNav />
          </div>

          <div className="mt-auto">
            <AdminAccountMenu />
          </div>
        </aside>

        <div className="min-w-0">
          <div className="flex h-screen flex-col overflow-hidden">
            <header className="supports-backdrop-filter:bg-background/80 sticky top-0 z-20 border-b border-border/60 bg-background/95 px-6 py-4 backdrop-blur sm:px-8">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Admin workspace
                  </p>
                  <h2 className="text-lg font-semibold text-foreground">
                    Product and RAG operations
                  </h2>
                </div>
                <div className="flex items-center gap-3">
                  <Button asChild size="sm" variant="outline">
                    <Link href="/admin/sds">
                      <FileText className="size-4" />
                      <span className="hidden md:block">SDS</span>
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/admin/products/rag">
                      <Search className="size-4" />
                      <span className="hidden md:block">Search</span>
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/admin/products/rag/generate">
                      <Sparkles className="size-4" />
                      <span className="hidden md:block">Generate</span>
                    </Link>
                  </Button>
                </div>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
