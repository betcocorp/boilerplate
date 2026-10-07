/**
 * B0-577 / B0-578 — Bex Health page header (epic B0-569). Async server component: names the
 * SELECTION in force (all traffic / a specific version / the unversioned bucket), the running
 * app version, the prompt bundle, and the EST window — so a screenshot is self-describing —
 * and hosts the searchParams-driven window/version selectors.
 *
 * The version option list is derived from data every render: `listAvailableVersions()` (an RPC
 * over `workflow_runs` + golden-run versions — nothing selectable without rows behind it) plus
 * an "Unversioned" entry only when `hasUnversionedRows()` says such rows actually exist.
 */

import { APP_VERSION } from '~/lib/app-version';
import { describeVersionSelection, utcDay, type HealthPanelProps } from '~/lib/bex-health/search-params';
import { UNVERSIONED_TRAFFIC } from '~/lib/observability/aggregates';
import { hasUnversionedRows, listAvailableVersions } from '~/lib/tests/versions';
import { PROMPT_BUNDLE_VERSION_SHORT } from '~/lib/workflows/product-support/prompt-version';

import { HealthFilters, type HealthVersionOption } from './HealthFilters';

const DAY_MS = 24 * 60 * 60 * 1000;

const dayFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'EST',
});

export async function HealthHeader({ window, version }: HealthPanelProps) {
  const [versions, unversionedExists] = await Promise.all([
    listAvailableVersions(),
    hasUnversionedRows(),
  ]);

  const versionOptions: HealthVersionOption[] = [
    { value: '', label: 'All traffic' },
    ...versions.map((value) => ({ value, label: `v${value}` })),
    ...(unversionedExists
      ? [{ value: UNVERSIONED_TRAFFIC, label: 'Unversioned (pre-instrumentation)' }]
      : []),
  ];
  // A pasted URL may name a selection the data no longer (or never) backs; keep the select
  // truthful by echoing it, labelled as such, rather than silently showing "All traffic".
  const selectedVersion = version ?? '';
  if (selectedVersion && !versionOptions.some((option) => option.value === selectedVersion)) {
    versionOptions.push({ value: selectedVersion, label: `${selectedVersion} (no data)` });
  }

  const fromDay = utcDay(window.from);
  const toDay = utcDay(window.to);
  const windowDays =
    Math.round(
      (Date.parse(`${toDay}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`)) / DAY_MS,
    ) + 1;
  const windowEndsToday = toDay === utcDay(new Date());

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Observability
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Bex health
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
            {describeVersionSelection(version)} · running v{APP_VERSION} · prompt bundle{' '}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-sm">
              {PROMPT_BUNDLE_VERSION_SHORT}
            </code>{' '}
            · {dayFormatter.format(window.from)} – {dayFormatter.format(window.to)} (EST)
          </p>
        </div>
        <HealthFilters
          selectedVersion={selectedVersion}
          versionOptions={versionOptions}
          windowDays={windowDays}
          windowEndsToday={windowEndsToday}
        />
      </div>
    </section>
  );
}
