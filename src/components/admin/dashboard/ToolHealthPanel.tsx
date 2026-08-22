/**
 * B0-629 — "Tool health" panel of the `/admin` Mission Control dashboard.
 *
 * Async server component; presentation only. `rows` arrive from
 * `~/lib/observability/tool-health.ts` already sorted desc by call count — rendered verbatim.
 *
 * Two live-data facts (verified 2026-08-22) shape what this panel prints:
 *
 *  - **Speculative entries are ~63% of all trace entries and sit almost entirely in
 *    `search_product_docs`** (2,821 → 727 ordinary calls once excluded). The reader drops them
 *    because a pre-emptive retrieval is not a call the model made, but that means this table's
 *    top row disagrees with any surface counting every trace entry — by ~2,094 calls. So
 *    `speculativeExcludedCount` is printed as a footnote rather than left implicit.
 *  - **Zero traffic is not proof a tool is dead.** `productSupportToolsForRoute` offers
 *    route-dependent SUBSETS of the registry (`dilution`/`recommendations` get 11 of the 14), so
 *    an absent tool may simply never have been offered on the routes this window's traffic took.
 *    The footnote says that; the panel never renders an "unused" verdict.
 */

import Link from 'next/link';

import { Badge } from '~/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { getToolHealthData, type ToolHealthRow } from '~/lib/observability/tool-health';

import type { HealthPanelProps } from '~/lib/bex-health/search-params';

import { formatCount, formatMs, formatRatePercent } from './format';

/**
 * B0-629 — hand-verified against `getToolHealthData` and the scans it composes; keep in sync with
 * them. Composed into the page's consolidated provenance footer, not rendered here.
 */
export const TOOL_HEALTH_SOURCES = [
  'Calls, failures and durations: workflow_steps.output.toolTrace on the openai_responses_agent step, scoped to the window’s workflow_runs; speculative and reused-speculative entries excluded',
  'Registry denominator: PRODUCT_TOOL_NAMES (~/lib/tools/tool-schemas); per-route offered subsets come from productSupportToolsForRoute (~/lib/tools/definitions), which is why a tool can be absent without being retired',
];

/**
 * Failure-rate tinting. A `0` is a real measurement ("no failures on any of this tool's calls"),
 * never missing data, so it stays in normal text. Thresholds chosen against the live spread
 * (0%, 1.2%, 2.1%, 4.9%): anything above zero is worth an operator's eye, and 4% separates the
 * one genuinely bad tool from the merely imperfect ones.
 */
const FAILURE_RATE_ELEVATED_ABOVE = 0;
const FAILURE_RATE_CRITICAL_AT_OR_ABOVE = 0.04;

/** Colour is never the only signal — the severity word rides along in the cell's title/label. */
function failureSeverity(rate: number): { className: string; word: string } {
  if (rate >= FAILURE_RATE_CRITICAL_AT_OR_ABOVE) {
    return { className: 'text-destructive font-medium', word: 'critical' };
  }
  if (rate > FAILURE_RATE_ELEVATED_ABOVE) {
    return { className: 'text-amber-600 dark:text-amber-400', word: 'elevated' };
  }
  return { className: 'text-foreground', word: 'no failures' };
}

function ToolRow({ row }: { row: ToolHealthRow }) {
  const severity = failureSeverity(row.failureRate);

  return (
    <TableRow>
      <TableCell className="max-w-[16rem] truncate font-mono text-[11px] text-foreground">
        <span title={row.toolName}>{row.toolName}</span>
        {row.known ? null : (
          <Badge className="ml-2 align-middle" variant="destructive">
            unknown tool
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums text-foreground">
        {formatCount(row.callCount)}
      </TableCell>
      <TableCell className={`text-right text-xs tabular-nums ${severity.className}`}>
        <span title={`${formatCount(row.failureCount)} of ${formatCount(row.callCount)} failed — ${severity.word}`}>
          {formatRatePercent(row.failureRate)}
        </span>
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
        <span
          title={
            row.durationSampleSize === 0
              ? 'No call carried a usable duration, so no percentile can be computed'
              : `n=${formatCount(row.durationSampleSize)} timed calls`
          }
        >
          {formatMs(row.p95DurationMs)}
        </span>
      </TableCell>
    </TableRow>
  );
}

export async function ToolHealthPanel({ window, version }: HealthPanelProps) {
  const data = await getToolHealthData(
    { from: window.from.toISOString(), to: window.to.toISOString() },
    version,
  );

  return (
    <section className="rounded-3xl border border-border/60 bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">Tool health</h2>
        <Link
          className="text-xs font-medium text-primary underline-offset-4 hover:underline"
          href="/admin/tools"
        >
          All tools →
        </Link>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {formatCount(data.toolsWithTraffic)} of the {formatCount(data.totalRegisteredTools)}{' '}
        product-support tools saw traffic in this window.
        {data.unknownToolCount > 0
          ? ` ${formatCount(data.unknownToolCount)} unrecognised tool name${
              data.unknownToolCount === 1 ? '' : 's'
            } also appeared — flagged below.`
          : ''}
      </p>

      {data.rows.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No tool calls were recorded in this window.
        </p>
      ) : (
        <div className="mt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 px-2 text-xs font-medium text-muted-foreground">
                  Tool
                </TableHead>
                <TableHead className="h-8 px-2 text-right text-xs font-medium text-muted-foreground">
                  Calls
                </TableHead>
                <TableHead className="h-8 px-2 text-right text-xs font-medium text-muted-foreground">
                  Fail
                </TableHead>
                <TableHead className="h-8 px-2 text-right text-xs font-medium text-muted-foreground">
                  p95
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:px-2 [&_td]:py-1.5">
              {data.rows.map((row) => (
                <ToolRow key={row.toolName} row={row} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mt-4 space-y-1 border-t border-border/60 pt-3 text-[11px] leading-5 text-muted-foreground">
        <p>
          {formatCount(data.speculativeExcludedCount)} speculative call
          {data.speculativeExcludedCount === 1 ? '' : 's'} excluded — pre-emptive retrievals and
          reused speculative results, concentrated in <span className="font-mono">
            search_product_docs
          </span>
          . Surfaces that count every trace entry will show correspondingly higher call counts.
        </p>
        <p>
          A tool missing from this table is not necessarily unused: the model is offered
          route-dependent subsets of the registry, so a tool may never have been available on the
          routes this window&rsquo;s traffic took.
        </p>
        {data.entriesMissingDuration > 0 ? (
          <p>
            {formatCount(data.entriesMissingDuration)} retained call
            {data.entriesMissingDuration === 1 ? '' : 's'} carried no usable duration and sit
            outside the p95 denominator.
          </p>
        ) : null}
      </div>
    </section>
  );
}
