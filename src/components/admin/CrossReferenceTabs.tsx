'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Tabs, TabsList, TabsTrigger } from '~/components/ui/tabs';

// Route-driven tabs for the consolidated /admin/tools/cross-reference area. Each tab
// is a real sub-route (so its server-side searchParams state — mapping search/page,
// queue status/minConfidence/page — is preserved and deep-linkable); the Tabs `value`
// is derived from the pathname rather than local state.
const TABS = [
  {
    value: 'lookup',
    label: 'Lookup & mappings',
    href: '/admin/tools/cross-reference/lookup',
  },
  {
    value: 'recommendations',
    label: 'Recommendation queue',
    href: '/admin/tools/cross-reference/recommendations',
  },
] as const;

export function CrossReferenceTabs() {
  const pathname = usePathname();
  const active =
    TABS.find((tab) => pathname === tab.href || pathname.startsWith(`${tab.href}/`))?.value ??
    'lookup';

  return (
    <Tabs value={active} className="w-full">
      <TabsList>
        {TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} asChild>
            <Link href={tab.href}>{tab.label}</Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
