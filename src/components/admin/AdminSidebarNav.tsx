'use client';

import {
  ChevronRight,
  FileText,
  KeyRound,
  LayoutDashboard,
  Library,
  MessageSquare,
  Search,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

type NavItem = {
  type: 'link';
  label: string;
  href: string;
  icon?: typeof LayoutDashboard;
};

type NavGroup = {
  type: 'group';
  label: string;
  icon: typeof LayoutDashboard;
  items: Array<{
    label: string;
    href: string;
  }>;
};

type NavEntry = NavItem | NavGroup;

type NavSectionModel = {
  title: string;
  items: NavEntry[];
};

const sidebarSections: NavSectionModel[] = [
  {
    title: 'Workspace',
    items: [
      {
        type: 'link',
        label: 'Dashboard',
        href: '/admin',
        icon: LayoutDashboard,
      },
      {
        type: 'group',
        label: 'Bex',
        icon: MessageSquare,
        items: [
          { label: 'Bex chat', href: '/admin/bex' },
          { label: 'Test runner', href: '/admin/tests' },
          { label: 'Failure Queue', href: '/admin/tests/failure-queue' },
        ],
      },
      {
        type: 'group',
        label: 'Tools',
        icon: Search,
        items: [
          { label: 'Tools home', href: '/admin/tools' },
          {
            label: 'Product cross-reference',
            href: '/admin/tools/product-cross-reference',
          },
          { label: 'Web Search', href: '/admin/tools/web-search' },
          { label: 'RAG semantic search', href: '/admin/products/rag' },
        ],
      },
    ],
  },
  {
    title: 'Document Corpus',
    items: [
      {
        type: 'group',
        label: 'Products',
        icon: Library,
        items: [
          { label: 'RAG generate', href: '/admin/products/rag/generate' },
          { label: 'RAG corpus quality', href: '/admin/products/rag/chunking' },
          { label: 'Legacy products', href: '/admin/products/legacy' },
        ],
      },
      {
        type: 'group',
        label: 'SDS',
        icon: FileText,
        items: [{ label: 'SDS ingestion', href: '/admin/sds' }],
      },
      {
        type: 'group',
        label: 'Markdown',
        icon: FileText,
        items: [{ label: 'Markdown ingestion', href: '/admin/knowledge' }],
      },
    ],
  },
  {
    title: 'API Security',
    items: [
      {
        type: 'group',
        label: 'API access',
        icon: KeyRound,
        items: [
          { label: 'Projects', href: '/admin/projects' },
          { label: 'Analytics', href: '/admin/projects/analytics' },
        ],
      },
    ],
  },
];

const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isActivePath(pathname: string, href: string) {
  if (href === '/admin') {
    return pathname === '/admin';
  }

  if (href === '/admin/tests') {
    if (pathname === '/admin/tests') {
      return true;
    }
    const rest = pathname.startsWith('/admin/tests/')
      ? pathname.slice('/admin/tests/'.length)
      : '';
    const firstSegment = rest.split('/')[0] ?? '';
    return UUID_SEGMENT.test(firstSegment);
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavSection({ items, title }: { items: NavEntry[]; title?: string }) {
  const pathname = usePathname();
  const activeGroupLabels = useMemo(() => {
    return new Set(
      items
        .filter(
          (entry): entry is NavGroup =>
            entry.type === 'group' &&
            entry.items.some((item) => isActivePath(pathname, item.href)),
        )
        .map((entry) => entry.label),
    );
  }, [items, pathname]);
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});

  return (
    <div className="space-y-2">
      {title ? (
        <p className="px-2 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
          {title}
        </p>
      ) : null}
      <nav className="space-y-1">
        {items.map((entry) => {
          if (entry.type === 'link') {
            const Icon = entry.icon;
            const active = isActivePath(pathname, entry.href);
            return (
              <Link
                className={`flex items-center gap-3 rounded-2xl px-3 py-2 text-sm font-medium transition ${
                  active
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-foreground/80 hover:bg-accent hover:text-foreground'
                }`}
                href={entry.href}
                key={entry.label}
              >
                {Icon ? <Icon className="size-4" /> : null}
                <span>{entry.label}</span>
              </Link>
            );
          }

          const Icon = entry.icon;
          const groupActive = activeGroupLabels.has(entry.label);
          const isOpen = groupActive || manualOpen[entry.label] === true;

          return (
            <div className="rounded-2xl" key={entry.label}>
              <Button
                className={cn(
                  'h-auto w-full justify-start rounded-2xl px-3 py-2 text-sm font-medium transition',
                  groupActive
                    ? 'bg-sidebar-accent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
                    : 'text-foreground/80 hover:bg-accent hover:text-foreground',
                )}
                onClick={() =>
                  setManualOpen((current) => ({
                    ...current,
                    [entry.label]: !isOpen,
                  }))
                }
                type="button"
                variant="ghost"
              >
                <Icon className="size-4" />
                <span className="flex-1 text-left">{entry.label}</span>
                <ChevronRight
                  className={`size-4 transition ${isOpen ? 'rotate-90' : ''}`}
                />
              </Button>
              {isOpen ? (
                <div className="mt-1 space-y-1 pl-10">
                  {entry.items.map((item) => {
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
      {sidebarSections.map((section) => (
        <NavSection
          items={section.items}
          key={section.title}
          title={section.title}
        />
      ))}
    </div>
  );
}
