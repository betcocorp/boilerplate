'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Tabs, TabsList, TabsTrigger } from '~/components/ui/tabs';

/**
 * B0-834 — route-driven tabs between the two documents a run's report is published as: the
 * detailed case-by-case report (`/report`) and the leadership one-pager (`/exec`). Each tab is a
 * real sub-route, so the active value is derived from the pathname rather than local state —
 * the same pattern as `CrossReferenceTabs`. Rendered at the very top of both pages and never
 * inside either page's PDF capture root.
 */
const REPORT_TABS = [
  { value: 'report', label: 'Detailed report', segment: 'report' },
  { value: 'exec', label: 'Executive summary', segment: 'exec' },
] as const;

type RunReportTabsProps = {
  testId: string;
  runId: string;
};

export function RunReportTabs({ testId, runId }: RunReportTabsProps) {
  const pathname = usePathname();
  const base = `/admin/tests/${testId}/runs/${runId}`;
  const active =
    REPORT_TABS.find((tab) => {
      const href = `${base}/${tab.segment}`;
      return pathname === href || pathname.startsWith(`${href}/`);
    })?.value ?? 'report';

  return (
    <Tabs className="w-full" value={active}>
      <TabsList aria-label="Report views">
        {REPORT_TABS.map((tab) => (
          <TabsTrigger asChild key={tab.value} value={tab.value}>
            <Link href={`${base}/${tab.segment}`}>{tab.label}</Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
