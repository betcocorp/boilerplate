'use client';

/**
 * B0-761 — tooltip body shared by the analytics charts.
 *
 * `ChartTooltipContent` (`~/components/ui/chart`) derives its heading from `payload[0].name`, i.e.
 * the SERIES name, which is right for a single-series chart and wrong for every chart on this page:
 * the heading that matters here is the bucket (a calendar day, an hour of the day). So these charts
 * keep `ChartContainer`/`ChartTooltip` from the shared wrapper and supply this body, which titles
 * itself from the hovered ROW and can rank multi-series rows by value — a ten-user line chart is
 * unreadable if the legend order and the tooltip order disagree.
 */

import { cn } from '~/lib/utils';

type TooltipRow = {
  color?: string;
  dataKey?: unknown;
  name?: number | string;
  payload?: unknown;
  value?: number | string;
};

export type AnalyticsTooltipContentProps = {
  /** Injected by recharts. */
  active?: boolean;
  className?: string;
  /** Rows with a zero value are noise on a ten-series chart; drop them by default. */
  hideZeroRows?: boolean;
  /** Injected by recharts. */
  payload?: TooltipRow[];
  /** Cap the number of rows rendered (after sorting), so a busy day cannot overflow the viewport. */
  maxRows?: number;
  /** Sort rows by value, highest first. */
  sortByValue?: boolean;
  /** Heading, derived from the hovered row's underlying datum. */
  title?: (row: Record<string, unknown>) => string;
};

function toNumber(value: number | string | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function AnalyticsTooltipContent({
  active,
  className,
  hideZeroRows = false,
  maxRows,
  payload,
  sortByValue = false,
  title,
}: AnalyticsTooltipContentProps) {
  if (!active || !payload?.length) return null;

  const datum = (payload[0]?.payload ?? {}) as Record<string, unknown>;
  const heading = title?.(datum) ?? '';

  let rows = payload.filter((row) => row.value !== undefined);
  if (hideZeroRows) {
    const nonZero = rows.filter((row) => toNumber(row.value) !== 0);
    // Keep at least one row so hovering an all-zero day still explains itself.
    rows = nonZero.length > 0 ? nonZero : rows.slice(0, 1);
  }
  if (sortByValue) {
    rows = [...rows].sort((a, b) => toNumber(b.value) - toNumber(a.value));
  }
  if (maxRows != null && rows.length > maxRows) {
    rows = rows.slice(0, maxRows);
  }

  return (
    <div
      className={cn(
        'max-w-xs rounded-lg border border-border/60 bg-background px-3 py-2 text-xs shadow-sm',
        className,
      )}
    >
      {heading ? <p className="mb-1 font-medium text-foreground">{heading}</p> : null}
      <div className="space-y-1">
        {rows.map((row, index) => (
          <div
            className="flex items-center justify-between gap-3"
            key={`${String(row.name ?? row.dataKey ?? index)}-${index}`}
          >
            <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span
                className="inline-block size-2 shrink-0 rounded-full"
                style={{ backgroundColor: row.color }}
              />
              <span className="truncate">{row.name}</span>
            </span>
            <span className="font-medium tabular-nums text-foreground">
              {toNumber(row.value).toLocaleString('en-US')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
