'use client';

import { ChevronRight, LayoutDashboard } from 'lucide-react';
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
 * Add your app's navigation here. An entry with no `permission` is always visible; one with a
 * `permission` selector (see `~/lib/permissions/constants`) is hidden when that selector is denied.
 * Groups collapse and are dropped entirely when all of their items are hidden. A group looks like:
 *
 *   { type: 'group', label: 'Reports', icon: FileText,
 *     items: [{ label: 'Monthly', href: '/admin/reports/monthly', permission: PERMISSIONS.X }] }
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
    ],
  },
];

/**
 * Drops links whose selector is denied, then groups and sections left empty. `hiddenSelectors` is
 * always empty while `PERMISSIONS_ENFORCED` is off, so shadow mode hides nothing.
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

function isActivePath(pathname: string, href: string) {
  if (href === '/admin') {
    return pathname === '/admin';
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
