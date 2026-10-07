/**
 * B0-577 / B0-578 — searchParams resolution for `/admin` (epic B0-569).
 *
 * Mirrors the day handling established on `/admin/observability`: `YYYY-MM-DD` params validated
 * against a strict pattern, UTC day bounds, and an inverted range clamped to a single day rather
 * than rejected. B0-578 adds the `?version=` param — the page URL fully determines the view.
 */

import { UNVERSIONED_TRAFFIC } from '~/lib/observability/aggregates';
import { readSearchParam } from '~/lib/utils/params';

/** Inclusive UTC window the health panels report over. */
export type HealthWindow = { from: Date; to: Date };

/**
 * Shared props contract for every Bex Health panel component. Panels whose data source has no
 * version dimension still accept `version` and ignore it, so the page can compose them uniformly.
 *
 * `version` semantics (B0-578, matching `VersionFilter` in `~/lib/observability/aggregates.ts`):
 *  - `null`                 → all traffic (no filter);
 *  - `UNVERSIONED_TRAFFIC`  → the unversioned bucket (rows whose `app_version` IS NULL);
 *  - any other string       → exact `app_version` match.
 * Golden-set readers use a different null convention — translate with `toGoldenSetVersionQuery`.
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
 *
 * `?version=` is passed through as-is (absent/blank → `null` = all traffic). An unknown version
 * string is NOT an error — every panel resolves it to its honest empty state, so a pasted URL
 * always reproduces a view rather than throwing.
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

  const versionRaw = readSearchParam(params.version).trim();

  return {
    window: {
      from: new Date(`${fromDay}T00:00:00.000Z`),
      to: new Date(`${toDay}T23:59:59.999Z`),
    },
    version: versionRaw === '' ? null : versionRaw,
  };
}

/**
 * B0-578 — THE one mapping between the page's version selection and the golden-set readers'
 * query shape (`GoldenSetRollupQuery['version']`), whose null convention differs:
 *
 *  | selection (`HealthPanelProps.version`) | golden-set query        |
 *  | -------------------------------------- | ----------------------- |
 *  | `null` (all traffic)                    | key omitted (any version) |
 *  | `UNVERSIONED_TRAFFIC`                   | `{ version: null }` (app_version IS NULL bucket) |
 *  | any other string                        | `{ version }` (exact)   |
 *
 * The observability readers (`scanWorkflowRuns` et al) take the selection verbatim — their
 * `VersionFilter` already uses these exact semantics.
 */
export function toGoldenSetVersionQuery(version: string | null): { version?: string | null } {
  if (version === null) return {};
  if (version === UNVERSIONED_TRAFFIC) return { version: null };
  return { version };
}

/** Human wording for the selection, used by the header subtitle and the verdict strip context. */
export function describeVersionSelection(version: string | null): string {
  if (version === null) return 'All traffic';
  if (version === UNVERSIONED_TRAFFIC) return 'Unversioned traffic (pre-instrumentation)';
  return `Version ${version}`;
}
