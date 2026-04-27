'use client';

import * as React from 'react';
import * as RechartsPrimitive from 'recharts';

import { cn } from '~/lib/utils';

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    color?: string;
  }
>;

type ChartContextProps = {
  config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextProps | null>(null);

/** Recharts’ first pass uses -1×-1 before ResizeObserver; positive defaults avoid console noise on the client. */
const RESPONSIVE_INITIAL_DIMENSION = { width: 800, height: 240 } as const;

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />');
  }
  return context;
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const cssVars = Object.entries(config)
    .map(([key, value]) =>
      value.color ? `  --color-${key}: ${value.color};` : null,
    )
    .filter(Boolean)
    .join('\n');

  if (!cssVars) {
    return null;
  }

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `[data-chart="${id}"] {\n${cssVars}\n}`,
      }}
    />
  );
}

export function ChartContainer({
  id,
  className,
  config,
  children,
}: React.ComponentProps<'div'> & {
  config: ChartConfig;
  children: React.ComponentProps<
    typeof RechartsPrimitive.ResponsiveContainer
  >['children'];
}) {
  const uniqueId = React.useId().replaceAll(':', '');
  const chartId = `chart-${id || uniqueId}`;
  const [chartsReady, setChartsReady] = React.useState(false);

  React.useLayoutEffect(() => {
    setChartsReady(true);
  }, []);

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        className={cn(
          'relative w-full min-w-0 text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke="#ccc"]]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke="#fff"]]:stroke-transparent [&_.recharts-layer]:outline-none [&_.recharts-legend-item-text]:text-foreground [&_.recharts-polar-grid_[stroke="#ccc"]]:stroke-border/50 [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-reference-line_[stroke="#ccc"]]:stroke-border [&_.recharts-sector[stroke="#fff"]]:stroke-transparent [&_.recharts-sector]:outline-none',
          className,
        )}
        data-chart={chartId}
      >
        <ChartStyle config={config} id={chartId} />
        {chartsReady ? (
          <RechartsPrimitive.ResponsiveContainer
            height="100%"
            initialDimension={RESPONSIVE_INITIAL_DIMENSION}
            minWidth={0}
            width="100%"
          >
            {children}
          </RechartsPrimitive.ResponsiveContainer>
        ) : (
          <div aria-hidden className="h-full min-h-0 w-full" />
        )}
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;
export const ChartLegend = RechartsPrimitive.Legend;

export function ChartTooltipContent({
  active,
  payload,
  className,
  labelFormatter,
  formatter,
}: React.ComponentProps<'div'> & {
  active?: boolean;
  payload?: Array<{
    name?: string;
    value?: number | string;
    color?: string;
    dataKey?: string;
  }>;
  label?: string | number;
  labelFormatter?: (label: string | number) => React.ReactNode;
  formatter?: (value: number | string, name: string) => React.ReactNode;
}) {
  const { config } = useChart();

  if (!active || !payload?.length) {
    return null;
  }

  const rows = payload.filter((row) => row.dataKey && row.value !== undefined);

  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 bg-background px-3 py-2 text-xs shadow-sm',
        className,
      )}
    >
      {typeof payload[0]?.name !== 'undefined' ? (
        <p className="mb-1 font-medium">
          {labelFormatter ? labelFormatter(payload[0].name as string) : payload[0].name}
        </p>
      ) : null}
      <div className="space-y-1">
        {rows.map((item, idx) => {
          const key = String(item.dataKey);
          const configured = config[key];
          const label = configured?.label ?? item.name ?? key;
          return (
            <div className="flex items-center justify-between gap-3" key={`${key}-${idx}`}>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{
                    backgroundColor:
                      item.color || configured?.color || `var(--color-${key})`,
                  }}
                />
                {label}
              </span>
              <span className="font-medium text-foreground">
                {formatter
                  ? formatter(item.value as number | string, String(label))
                  : item.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ChartLegendContent({
  payload,
  className,
}: React.ComponentProps<'div'> & {
  payload?: Array<{
    dataKey?: string;
    color?: string;
    value?: string;
  }>;
}) {
  const { config } = useChart();
  if (!payload?.length) {
    return null;
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-4 text-xs', className)}>
      {payload.map((item, idx) => {
        const key = item.dataKey || item.value || `series-${idx}`;
        const configured = config[key];
        const label = configured?.label ?? item.value ?? key;
        return (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground" key={key}>
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{
                backgroundColor: item.color || configured?.color || `var(--color-${key})`,
              }}
            />
            {label}
          </span>
        );
      })}
    </div>
  );
}
