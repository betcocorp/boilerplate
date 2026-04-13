'use client';

import {
  ChevronRight,
  FileText,
  LayoutDashboard,
  Library,
  MessageSquare,
  Search,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';

type NavItem = {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
};

type NavGroup = {
  label: string;
  icon: typeof LayoutDashboard;
  items: Array<{
    label: string;
    href: string;
  }>;
};

const workspaceNavItems: NavItem[] = [
  { label: 'Dashboard', href: '/admin', icon: LayoutDashboard },
  { label: 'Bex', href: '/admin/bex', icon: MessageSquare },
  { label: 'RAG semantic search', href: '/admin/products/rag', icon: Search },
];

const productsNavItems: NavGroup[] = [
  {
    label: 'Products',
    icon: Library,
    items: [
      { label: 'RAG generate', href: '/admin/products/rag/generate' },
      { label: 'Legacy products', href: '/admin/products/legacy' },
    ],
  },
  {
    label: 'SDS',
    icon: FileText,
    items: [{ label: 'SDS ingestion', href: '/admin/sds' }],
  },
];

function isActivePath(pathname: string, href: string) {
  if (href === '/admin') {
    return pathname === '/admin';
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavSection({ items, title }: { items: NavItem[]; title?: string }) {
  const pathname = usePathname();

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
          const active = isActivePath(pathname, item.href);

          return (
            <Link
              className={`flex items-center gap-3 rounded-2xl px-3 py-2 text-sm font-medium transition ${
                active
                  ? 'bg-sidebar-accent text-sidebar-foreground'
                  : 'text-foreground/80 hover:bg-accent hover:text-foreground'
              }`}
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
  groups: NavGroup[];
  title?: string;
}) {
  const pathname = usePathname();
  const activeGroupLabels = useMemo(() => {
    return new Set(
      groups
        .filter((group) =>
          group.items.some((item) => isActivePath(pathname, item.href)),
        )
        .map((group) => group.label),
    );
  }, [groups, pathname]);
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});

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
          const groupActive = activeGroupLabels.has(group.label);
          const isOpen = groupActive || manualOpen[group.label] === true;

          return (
            <div className="rounded-2xl" key={group.label}>
              <button
                className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-sm font-medium transition ${
                  groupActive
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-foreground/80 hover:bg-accent hover:text-foreground'
                }`}
                onClick={() =>
                  setManualOpen((current) => ({
                    ...current,
                    [group.label]: !isOpen,
                  }))
                }
                type="button"
              >
                <Icon className="size-4" />
                <span className="flex-1 text-left">{group.label}</span>
                <ChevronRight
                  className={`size-4 transition ${isOpen ? 'rotate-90' : ''}`}
                />
              </button>
              {isOpen ? (
                <div className="mt-1 space-y-1 pl-10">
                  {group.items.map((item) => {
                    const itemActive = isActivePath(pathname, item.href);
                    return (
                      <Link
                        className={`block rounded-xl px-3 py-1.5 text-sm transition ${
                          itemActive
                            ? 'bg-sidebar-accent text-sidebar-foreground'
                            : 'text-foreground/70 hover:bg-accent hover:text-foreground'
                        }`}
                        href={item.href}
                        key={item.label}
                      >
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

export function AdminSidebarNav() {
  return (
    <div className="space-y-6">
      <NavSection items={workspaceNavItems} title="Workspace" />
      <NavGroupedSection groups={productsNavItems} title="Products & RAG" />
    </div>
  );
}
