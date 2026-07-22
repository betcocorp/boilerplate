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
import { useState } from 'react';

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '~/components/ui/sidebar';
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
          { label: 'Orphan Monitor', href: '/admin/products/orphans' },
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
        items: [
          { label: 'Markdown ingestion', href: '/admin/knowledge' },
          { label: 'Product label ingestion', href: '/admin/labels' },
        ],
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

/**
 * A collapsible nav group. When the sidebar is collapsed to the icon rail, only the group icon
 * shows (with a hover tooltip); clicking it expands the rail and opens the group so its links
 * become reachable. The active group stays open and can't be manually collapsed.
 */
function NavGroupItem({ entry }: { entry: NavGroup }) {
  const pathname = usePathname();
  const { state, isMobile, setOpen } = useSidebar();
  const [manualOpen, setManualOpen] = useState(false);

  const Icon = entry.icon;
  const groupActive = entry.items.some((item) => isActivePath(pathname, item.href));
  const isOpen = groupActive || manualOpen;
  const collapsed = state === 'collapsed' && !isMobile;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={groupActive}
        onClick={() => {
          if (collapsed) {
            setOpen(true);
            setManualOpen(true);
          } else {
            setManualOpen(!isOpen);
          }
        }}
        tooltip={entry.label}
      >
        <Icon />
        <span>{entry.label}</span>
        <ChevronRight
          className={cn('ml-auto transition-transform', isOpen && 'rotate-90')}
        />
      </SidebarMenuButton>
      {isOpen ? (
        <SidebarMenuSub>
          {entry.items.map((item) => (
            <SidebarMenuSubItem key={item.href}>
              <SidebarMenuSubButton
                asChild
                isActive={isActivePath(pathname, item.href)}
              >
                <Link href={item.href}>{item.label}</Link>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  );
}

function NavSection({ section }: { section: NavSectionModel }) {
  const pathname = usePathname();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{section.title}</SidebarGroupLabel>
      <SidebarMenu>
        {section.items.map((entry) => {
          if (entry.type === 'link') {
            const Icon = entry.icon;
            const active = isActivePath(pathname, entry.href);
            return (
              <SidebarMenuItem key={entry.label}>
                <SidebarMenuButton asChild isActive={active} tooltip={entry.label}>
                  <Link href={entry.href}>
                    {Icon ? <Icon /> : null}
                    <span>{entry.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          }

          return <NavGroupItem entry={entry} key={entry.label} />;
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

export function AdminSidebarNav() {
  return (
    <>
      {sidebarSections.map((section) => (
        <NavSection key={section.title} section={section} />
      ))}
    </>
  );
}
