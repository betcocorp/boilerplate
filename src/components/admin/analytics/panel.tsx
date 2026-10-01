/**
 * B0-761 — shared shell for every event-analytics panel.
 *
 * The `public.event_logging` table is brand new, so the realistic first view of this page is a page
 * with NOTHING in it. Rather than each panel inventing its own "no data" treatment (or worse,
 * handing recharts an empty array and rendering an empty grid), every panel renders through
 * `AnalyticsPanel` and passes `isEmpty` + `emptyMessage`; the shell swaps the chart for a plain
 * message and keeps the card height stable so the page does not jump as data arrives.
 */

import type { ReactNode } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import { cn } from '~/lib/utils';

export type AnalyticsPanelProps = {
  /** Panel body — a chart, a table, whatever the panel renders when it has data. */
  children: ReactNode;
  className?: string;
  /** Sub-heading under the title. */
  description?: ReactNode;
  /** Shown in place of `children` when `isEmpty`. */
  emptyMessage?: ReactNode;
  /**
   * Minimum height of the empty state, so an empty card is not a sliver. Should roughly match the
   * height of the chart it stands in for.
   */
  emptyMinHeightClassName?: string;
  /** True when the panel has nothing meaningful to draw. */
  isEmpty?: boolean;
  title: ReactNode;
};

export function AnalyticsPanel({
  children,
  className,
  description,
  emptyMessage = 'No events recorded yet.',
  emptyMinHeightClassName = 'min-h-[220px]',
  isEmpty = false,
  title,
}: AnalyticsPanelProps) {
  return (
    <Card className={cn('rounded-3xl border-border/60 shadow-none', className)}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? (
          <CardDescription className="text-xs leading-relaxed">{description}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="min-w-0">
        {isEmpty ? (
          <div
            className={cn(
              'flex items-center justify-center rounded-2xl border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground',
              emptyMinHeightClassName,
            )}
          >
            {emptyMessage}
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
