import {
  ChevronRight,
  FileText,
  Layers,
  LayoutDashboard,
  Library,
  MessageSquare,
  Search,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { AdminAccountMenu } from '~/components/admin/AdminAccountMenu';
import { Button } from '~/components/ui/button';

const workspaceNavItems = [
  { label: 'Dashboard', href: '/admin', icon: LayoutDashboard },
  { label: 'Bex', href: '/admin/bex', icon: MessageSquare },
];

const productsNavItems = [
  {
    label: 'Products',
    icon: Library,
    items: [
      { label: 'RAG generate', href: '/admin/products/rag/generate' },
      { label: 'RAG products', href: '/admin/products/rag' },
      { label: 'Legacy products', href: '/admin/products/legacy' },
    ],
  },
  {
    label: 'Rag',
    icon: Layers,
    items: [{ label: 'RAG similarity search', href: '/admin/products/rag' }],
  },
  {
    label: 'SDS',
    icon: FileText,
    items: [{ label: 'SDS ingestion', href: '/admin/sds' }],
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

function NavGroupedSection({
  groups,
  title,
}: {
  groups: Array<{
    label: string;
    icon: typeof LayoutDashboard;
    items: Array<{
      label: string;
      href: string;
    }>;
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
        {groups.map((group) => {
          const Icon = group.icon;
          return (
            <details className="group rounded-2xl" key={group.label}>
              <summary className="flex cursor-pointer list-none items-center gap-3 rounded-2xl px-3 py-2 text-sm font-medium text-foreground/80 transition hover:bg-accent hover:text-foreground">
                <Icon className="size-4" />
                <span className="flex-1">{group.label}</span>
                <ChevronRight className="size-4 transition group-open:rotate-90" />
              </summary>
              <div className="mt-1 space-y-1 pl-10">
                {group.items.map((item) => (
                  <Link
                    className="block rounded-xl px-3 py-1.5 text-sm text-foreground/70 transition hover:bg-accent hover:text-foreground"
                    href={item.href}
                    key={item.label}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </details>
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
            <NavGroupedSection
              groups={productsNavItems}
              title="Products & RAG"
            />
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
                      SDS
                    </Link>
                  </Button>
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
