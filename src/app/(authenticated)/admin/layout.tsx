import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  Layers,
  LayoutDashboard,
  Library,
  MessageSquare,
  Search,
  Sparkles,
  Wand2,
} from 'lucide-react';

import { AdminAccountMenu } from '~/components/admin/AdminAccountMenu';
import { Button } from '~/components/ui/button';

const workspaceNavItems = [
  { label: 'Dashboard', href: '/admin', icon: LayoutDashboard },
  { label: 'Bex', href: '/admin/bex', icon: MessageSquare },
];

const productsNavItems = [
  { label: 'Legacy products', href: '/admin/products/legacy', icon: Library },
  { label: 'RAG search', href: '/admin/products/rag', icon: Layers },
  {
    label: 'RAG generate',
    href: '/admin/products/rag/generate',
    icon: Wand2,
  },
];

type AdminLayoutProps = {
  children: ReactNode;
};

function NavSection({
  items,
  title,
}: {
  items: Array<{
    label: string;
    href: string;
    icon: typeof LayoutDashboard;
  }>;
  title?: string;
}) {
  return (
    <div className="space-y-2">
      {title ? (
        <p className="px-2 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
          {title}
        </p>
      ) : null}
      <nav className="space-y-1">
        {items.map((item) => {
          const Icon = item.icon;

          return (
            <Link
              className="flex items-center gap-3 rounded-2xl px-3 py-2 text-sm font-medium text-foreground/80 transition hover:bg-accent hover:text-foreground"
              href={item.href}
              key={item.label}
            >
              <Icon className="size-4" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

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

          <div className="mt-8 space-y-6">
            <NavSection items={workspaceNavItems} title="Workspace" />
            <NavSection items={productsNavItems} title="Products & RAG" />
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
                    <Link href="/admin/products/rag">
                      <Search className="size-4" />
                      Search
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/admin/products/rag/generate">
                      <Sparkles className="size-4" />
                      Generate
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
