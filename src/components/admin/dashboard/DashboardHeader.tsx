/**
 * B0-629 — the `/admin` Mission Control filter row.
 *
 * Async server component. Deliberately NOT a page header: the admin layout
 * (`src/app/(authenticated)/admin/layout.tsx`) already renders the app version, the "Dashboard"
 * title and the act-as switcher, which is exactly what the mockup's sticky top bar drew. Only its
 * two filter chips were new, so only those are built here — rebuilding the rest would duplicate
 * the layout chrome.
 *
 * What it adds beyond the chips is a self-describing line, for the same reason `HealthHeader`
 * carries one: a screenshot of this dashboard should say which selection, prompt bundle and EST
 * window produced its numbers, rather than being undatable.
 *
 * The version option list is derived from data every render — `listAvailableVersions()` (an RPC
 * over `workflow_runs` + golden-run versions, so nothing selectable lacks rows behind it) plus an
 * "Unversioned" entry only when `hasUnversionedRows()` says such rows exist.
 */

import { APP_VERSION } from '~/lib/app-version';
import {
  describeVersionSelection,
  utcDay,
  type HealthPanelProps,
} from '~/lib/bex-health/search-params';
import { UNVERSIONED_TRAFFIC } from '~/lib/observability/aggregates';
import { hasUnversionedRows, listAvailableVersions } from '~/lib/tests/versions';
import { PROMPT_BUNDLE_VERSION_SHORT } from '~/lib/workflows/product-support/prompt-version';

import { DashboardFilters, type DashboardVersionOption } from './DashboardFilters';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function DashboardHeader({ window, version }: HealthPanelProps) {
  const [versions, unversionedExists] = await Promise.all([
    listAvailableVersions(),
    hasUnversionedRows(),
  ]);

  const versionOptions: DashboardVersionOption[] = [
    { value: '', label: 'All traffic' },
    ...versions.map((value) => ({ value, label: `v${value}` })),
    ...(unversionedExists
      ? [{ value: UNVERSIONED_TRAFFIC, label: 'Unversioned (pre-instrumentation)' }]
      : []),
  ];
  // A pasted URL may name a selection the data no longer (or never) backs; keep the select
  // truthful by echoing it, labelled as such, rather than silently showing "All traffic".
  const selectedVersion = version ?? '';
  if (
    selectedVersion &&
    !versionOptions.some((option) => option.value === selectedVersion)
  ) {
    versionOptions.push({
      value: selectedVersion,
      label: `${selectedVersion} (no data)`,
    });
  }

  const fromDay = utcDay(window.from);
  const toDay = utcDay(window.to);
  const windowDays =
    Math.round(
      (Date.parse(`${toDay}T00:00:00.000Z`) -
        Date.parse(`${fromDay}T00:00:00.000Z`)) /
        DAY_MS,
    ) + 1;
  const windowEndsToday = toDay === utcDay(new Date());

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 text-xs text-muted-foreground">
        {describeVersionSelection(version)} · running v{APP_VERSION} · bundle{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
          {PROMPT_BUNDLE_VERSION_SHORT}
        </code>{' '}
        · <span className="tabular-nums">{fromDay}</span> →{' '}
        <span className="tabular-nums">{toDay}</span> (EST)
      </p>
      <DashboardFilters
        selectedVersion={selectedVersion}
        versionOptions={versionOptions}
        windowDays={windowDays}
        windowEndsToday={windowEndsToday}
      />
    </div>
  );
}
