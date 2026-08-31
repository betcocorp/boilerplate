import { z } from 'zod';

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-761 — server-side read model for the event analytics dashboard.
 *
 * Ported from c360, where the browser → Next.js route → Express `/events/summary` hop fanned out
 * into a dozen Snowflake queries. Bex is a single full-stack app, so the whole rollup lives in one
 * Postgres function (`public.event_analytics_summary`) and this module is just the typed,
 * validated door to it plus the pure shaping helpers the charts need.
 *
 * `public.event_logging` is RLS-enabled with no policies, so every read here goes through the
 * service-role client — this file must never be imported from a client component.
 */

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 365;
const MAX_CHART_USERS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Sparse day × user cells for daily multi-series charts (densified by `pivotUserDaySeries`). */
export type UserDayMetricRow = {
  date: string;
  userKey: string;
  label: string;
  count: number;
};

export type EventAnalyticsSummary = {
  days: number;
  selectedGroups: string[];
  availableGroups: string[];
  totalInRange: number;
  uniqueEventNames: number;
  byDay: { date: string; count: number }[];
  interactionsByHour: { hour: number; count: number }[];
  topEvents: { event: string; count: number; userCount: number }[];
  topPages: { event: string; count: number; userCount: number }[];
  recent: { id: string; event: string; created_at: string }[];
  /** Sparse: days with at least one analytics login success/failure event */
  loginByDay: { date: string; success: number; failure: number }[];
  /**
   * Selected `days` window: `analytics.user.login.success` only; top 10 users by total logins,
   * sparse per-day counts (same range as the range picker).
   */
  loginTopUsersByDay: UserDayMetricRow[];
  /**
   * Same window: `analytics.page.view*` with user meta; top 10 by total page views, sparse per-day.
   */
  pageViewsByUserDay: UserDayMetricRow[];
};

const userDayMetricRowSchema = z.object({
  date: z.string(),
  userKey: z.string(),
  label: z.string(),
  count: z.number(),
});

/**
 * Every collection degrades to `[]` and every scalar to a safe default rather than throwing: a
 * partially-shaped RPC payload must still render a dashboard, not a 500. The RPC already returns
 * `[]` (never null) for empty collections, so a `.catch()` here only fires on real drift.
 */
export const eventAnalyticsSummarySchema: z.ZodType<EventAnalyticsSummary> =
  z.object({
    days: z.number().catch(DEFAULT_DAYS),
    selectedGroups: z.array(z.string()).catch([]),
    availableGroups: z.array(z.string()).catch([]),
    totalInRange: z.number().catch(0),
    uniqueEventNames: z.number().catch(0),
    byDay: z
      .array(z.object({ date: z.string(), count: z.number() }))
      .catch([]),
    interactionsByHour: z
      .array(z.object({ hour: z.number(), count: z.number() }))
      .catch([]),
    topEvents: z
      .array(
        z.object({
          event: z.string(),
          count: z.number(),
          userCount: z.number(),
        }),
      )
      .catch([]),
    topPages: z
      .array(
        z.object({
          event: z.string(),
          count: z.number(),
          userCount: z.number(),
        }),
      )
      .catch([]),
    recent: z
      .array(
        z.object({
          id: z.string(),
          event: z.string(),
          created_at: z.string(),
        }),
      )
      .catch([]),
    loginByDay: z
      .array(
        z.object({
          date: z.string(),
          success: z.number(),
          failure: z.number(),
        }),
      )
      .catch([]),
    loginTopUsersByDay: z.array(userDayMetricRowSchema).catch([]),
    pageViewsByUserDay: z.array(userDayMetricRowSchema).catch([]),
  });

/**
 * Loads the whole dashboard payload in one RPC round trip.
 *
 * Returns `null` (never throws) on a transport, permission or shape failure so the page can render
 * its empty state — same contract as c360's `getEventAnalytics`.
 */
export async function getEventAnalytics(
  days = DEFAULT_DAYS,
  groups: string[] = [],
): Promise<EventAnalyticsSummary | null> {
  const p_days = clampDayCount(days);

  try {
    const supabase = getSupabaseServiceRoleClient();
    // `p_groups` defaults to null in SQL, so omitting it is exactly "no group filter"; the
    // generated Args type does not admit an explicit null.
    const { data, error } = await supabase.rpc('event_analytics_summary', {
      p_days,
      ...(groups.length > 0 ? { p_groups: groups } : {}),
    });

    if (error) {
      console.error('[event-analytics] rpc failed', error);
      return null;
    }

    const parsed = eventAnalyticsSummarySchema.safeParse(data);
    if (!parsed.success) {
      console.error('[event-analytics] unexpected payload', parsed.error.issues);
      return null;
    }

    return parsed.data;
  } catch (error) {
    console.error('[event-analytics] getEventAnalytics', error);
    return null;
  }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers — no Supabase, no network, unit-tested directly.
 * -------------------------------------------------------------------------- */

/** Clamps a raw `?days=` search param to 1..365, defaulting to 30 when absent or unparseable. */
export function clampDays(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? String(DEFAULT_DAYS), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DAYS;
  return clampDayCount(parsed);
}

function clampDayCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DAYS;
  return Math.min(Math.max(Math.trunc(value), MIN_DAYS), MAX_DAYS);
}

/**
 * `?groups=a,b&groups=c` and `?groups=a` both normalize to a deduped, trimmed, non-empty list.
 * Ported verbatim in behaviour from c360's analytics page.
 */
export function parseGroupFilter(raw: string | string[] | undefined): string[] {
  const values = Array.isArray(raw) ? raw : [raw];
  return [
    ...new Set(
      values
        .flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
}

/**
 * The `YYYY-MM-DD` keys for the window, oldest first, ending on the `now` day.
 *
 * UTC rather than local time: the RPC buckets with `date_trunc('day', created_at)` in the database
 * session's timezone (UTC), so densifying on local days would misalign the join near midnight.
 * bex has no `date-fns`, and plain `Date` arithmetic on UTC midnights is exact — no DST drift.
 */
function buildDayKeys(dayCount: number, now: Date): string[] {
  const count = Math.max(0, Math.trunc(dayCount));
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    keys.push(new Date(end - i * DAY_MS).toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * One row per calendar day in the window so charts have no gaps. Days with no data get `fill`.
 *
 * `now` is injectable so tests are deterministic; production callers omit it.
 */
export function buildDenseDaySeries<T extends { date: string }>(
  rows: readonly T[],
  dayCount: number,
  fill: Omit<T, 'date'>,
  now: Date = new Date(),
): T[] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  return buildDayKeys(dayCount, now).map(
    // `{ ...fill, date }` is structurally `T`; TS cannot prove that for an open generic.
    (date) => byDate.get(date) ?? ({ ...fill, date } as unknown as T),
  );
}

/**
 * Turns the sparse day × user rows into dense, recharts-ready rows.
 *
 * Users are ranked by total volume across the window and capped at the top 10 (c360's cap); each
 * output row carries `date` plus one numeric key per surviving `userKey`, zero-filled. Rows are
 * keyed by `userKey` rather than a positional `s0..s9` alias so a chart series can be looked up
 * without re-deriving the ordering.
 */
export function pivotUserDaySeries(
  rows: UserDayMetricRow[],
  dayCount: number,
  now: Date = new Date(),
): {
  users: { userKey: string; label: string }[];
  data: Array<Record<string, string | number>>;
} {
  const cells = new Map<string, number>();
  const totals = new Map<string, number>();
  const labels = new Map<string, string>();

  for (const row of rows) {
    if (!row?.date || !row?.userKey) continue;
    const cellKey = `${row.date}|${row.userKey}`;
    cells.set(cellKey, (cells.get(cellKey) ?? 0) + row.count);
    totals.set(row.userKey, (totals.get(row.userKey) ?? 0) + row.count);
    if (row.label && !labels.has(row.userKey)) {
      labels.set(row.userKey, row.label);
    }
  }

  const users = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CHART_USERS)
    .map(([userKey]) => ({
      userKey,
      label: labels.get(userKey) ?? userKey,
    }));

  const data = buildDayKeys(dayCount, now).map((date) => {
    const row: Record<string, string | number> = { date };
    for (const { userKey } of users) {
      row[userKey] = cells.get(`${date}|${userKey}`) ?? 0;
    }
    return row;
  });

  return { users, data };
}
