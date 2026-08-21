/**
 * B0-577 — Bex Health page header (epic B0-569). Server component: names the app version, the
 * prompt bundle, and the UTC window in force, so a screenshot of the dashboard is self-describing.
 */

import { APP_VERSION } from '~/lib/app-version';
import { PROMPT_BUNDLE_VERSION_SHORT } from '~/lib/workflows/product-support/prompt-version';

import type { HealthPanelProps } from '~/lib/bex-health/search-params';

const dayFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

export function HealthHeader({ window, version }: HealthPanelProps) {
  // The version selector lands in a later story; until then the running app version is in force.
  const versionInForce = version ?? APP_VERSION;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
        Observability
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
        Bex health
      </h1>
      <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
        Version {versionInForce} · prompt bundle{' '}
        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-sm">
          {PROMPT_BUNDLE_VERSION_SHORT}
        </code>{' '}
        · {dayFormatter.format(window.from)} – {dayFormatter.format(window.to)} (UTC)
      </p>
    </section>
  );
}
