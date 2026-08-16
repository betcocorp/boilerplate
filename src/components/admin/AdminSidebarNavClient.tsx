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
import { PERMISSIONS } from '~/lib/permissions/constants';
import { cn } from '~/lib/utils';

type NavItem = {
  type: 'link';
  label: string;
  href: string;
  icon?: typeof LayoutDashboard;
  /** Selector that must be granted for this link to show. Omitted = always visible. */
  permission?: string;
};

type NavGroup = {
  type: 'group';
  label: string;
  icon: typeof LayoutDashboard;
  items: Array<{
    label: string;
    href: string;
    /** Selector that must be granted for this sub-link to show. */
    permission?: string;
  }>;
};

type NavEntry = NavItem | NavGroup;

type NavSectionModel = {
  title: string;
  items: NavEntry[];
};

/**
 * The permission catalog is per **surface**, not per visible link, so several sub-links can share a
 * selector (Test runner + Failure Queue) and one visual group can span two selectors (Bex, Tools,
 * Markdown). The Dashboard link is deliberately ungated — it is the admin landing page.
 */
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
          {
            label: 'Bex chat',
            href: '/admin/bex',
          },
          {
            label: 'Test runner',
            href: '/admin/tests',
          },
          {
            label: 'Failure Queue',
            href: '/admin/tests/failure-queue',
          },
          {
            label: 'Routing comparison',
            href: '/admin/tests/routing-comparison',
          },
          {
            label: 'Prompt observability',
            href: '/admin/observability',
          },
        ],
      },
      {
        type: 'group',
        label: 'Tools',
        icon: Search,
        items: [
          {
            label: 'Tools home',
            href: '/admin/tools',
          },
          {
            label: 'Cross-reference',
            href: '/admin/tools/cross-reference',
          },
          {
            label: 'Web Search',
            href: '/admin/tools/web-search',
          },
          {
            label: 'RAG semantic search',
            href: '/admin/products/rag',
          },
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
          {
            label: 'RAG corpus quality',
            href: '/admin/products/rag/chunking',
            permission: PERMISSIONS.NAVIGATION_SIDEBAR_PRODUCTS,
          },
          {
            label: 'Orphan Monitor',
            href: '/admin/products/orphans',
            permission: PERMISSIONS.NAVIGATION_SIDEBAR_PRODUCTS,
          },
          {
            label: 'Legacy products',
            href: '/admin/products/legacy',
            permission: PERMISSIONS.NAVIGATION_SIDEBAR_PRODUCTS,
          },
        ],
      },
      {
        type: 'group',
        label: 'Ingestion',
        icon: FileText,
        items: [
          {
            label: 'Product',
            href: '/admin/products/rag/generate',
            permission: PERMISSIONS.NAVIGATION_SIDEBAR_PRODUCTS,
          },
          {
            label: 'SDS',
            href: '/admin/sds',
            permission: PERMISSIONS.NAVIGATION_SIDEBAR_SDS,
          },
          {
            label: 'Efficacy',
            href: '/admin/efficacy',
            permission: PERMISSIONS.NAVIGATION_SIDEBAR_EFFICACY,
          },
          {
            label: 'Knowledge',
            href: '/admin/knowledge',
            permission: PERMISSIONS.NAVIGATION_SIDEBAR_KNOWLEDGE,
          },
          {
            label: 'Product Label',
            href: '/admin/labels',
            permission: PERMISSIONS.NAVIGATION_SIDEBAR_LABELS,
          },
        ],
      },
    ],
  },
];

/**
 * Drops links whose selector is denied, then groups and sections left empty. `hiddenSelectors` is
 * always empty while `BEX_PERMISSIONS_ENFORCED` is off, so shadow mode hides nothing.
 */
function visibleSections(hiddenSelectors: string[]): NavSectionModel[] {
  if (hiddenSelectors.length === 0) return sidebarSections;
  const hidden = new Set(hiddenSelectors);

  return sidebarSections
    .map((section) => ({
      ...section,
      items: section.items.flatMap<NavEntry>((entry) => {
        if (entry.type === 'link') {
          return entry.permission && hidden.has(entry.permission)
            ? []
            : [entry];
        }
        const items = entry.items.filter(
          (item) => !(item.permission && hidden.has(item.permission)),
        );
        return items.length > 0 ? [{ ...entry, items }] : [];
      }),
    }))
    .filter((section) => section.items.length > 0);
}

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
  const groupActive = entry.items.some((item) =>
    isActivePath(pathname, item.href),
  );
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
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={entry.label}
                >
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

/**
 * Renders the admin sidebar from the nav model. Only selectors passed in `hiddenSelectors` are
 * removed — the permission verdicts themselves are computed server-side in `AdminSidebarNav`.
 */
export function AdminSidebarNavClient({
  hiddenSelectors = [],
}: {
  hiddenSelectors?: string[];
}) {
  return (
    <>
      {visibleSections(hiddenSelectors).map((section) => (
        <NavSection key={section.title} section={section} />
      ))}
    </>
  );
}
