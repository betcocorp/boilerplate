/**
 * B0-577 — searchParams resolution for `/admin/bex/health` (epic B0-569).
 *
 * Mirrors the day handling established on `/admin/observability`: `YYYY-MM-DD` params validated
 * against a strict pattern, UTC day bounds, and an inverted range clamped to a single day rather
 * than rejected. A later story adds the version selector; until then `version` is always `null`.
 */

import { readSearchParam } from '~/lib/utils/params';

/** Inclusive UTC window the health panels report over. */
export type HealthWindow = { from: Date; to: Date };

/**
 * Shared props contract for every Bex Health panel component. Panels whose data source has no
 * version dimension still accept `version` and ignore it, so the page can compose them uniformly.
 */
export type HealthPanelProps = {
  window: HealthWindow;
  version: string | null;
};

export type HealthSearchParams = {
  window: HealthWindow;
  version: string | null;
};

/** Inclusive default window: today plus the previous 6 UTC days (matches `/admin/observability`). */
const DEFAULT_WINDOW_DAYS = 7;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` in UTC. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function readDay(value: string, fallback: string): string {
  return DAY_PATTERN.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    ? value
    : fallback;
}

/**
 * Resolves the health page's searchParams into a typed window plus the version in force.
 * `now` is injectable so the resolved default window is deterministic in tests.
 */
export function resolveHealthSearchParams(
  params: Record<string, string | string[] | undefined>,
  now: Date = new Date(),
): HealthSearchParams {
  const defaultTo = utcDay(now);
  const defaultFrom = utcDay(new Date(now.getTime() - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS));

  const fromDay = readDay(readSearchParam(params.from), defaultFrom);
  const toDayRequested = readDay(readSearchParam(params.to), defaultTo);
  // Guard against an inverted range typed into the date inputs.
  const toDay = toDayRequested < fromDay ? fromDay : toDayRequested;

  return {
    window: {
      from: new Date(`${fromDay}T00:00:00.000Z`),
      to: new Date(`${toDay}T23:59:59.999Z`),
    },
    // B0-577 ships without the version selector; a later story reads `?version=` here.
    version: null,
  };
}
