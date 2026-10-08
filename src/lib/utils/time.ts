/**
 * Shared date / duration formatting used across admin UI.
 */

function easternParts(value: number | string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
}

function getPart(parts: Intl.DateTimeFormatPart[], type: string) {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** `YYYY-MM-DD HH:mm:ss EST` in Eastern Time (handles EST/EDT). */
export function formatEasternTimestamp(value: number | string): string {
  const p = easternParts(value);
  return `${getPart(p, 'year')}-${getPart(p, 'month')}-${getPart(p, 'day')} ${getPart(p, 'hour')}:${getPart(p, 'minute')}:${getPart(p, 'second')} EST`;
}

/** `HH:mm:ss EST` in Eastern Time (handles EST/EDT). */
export function formatEasternTime(value: number | string): string {
  const p = easternParts(value);
  return `${getPart(p, 'hour')}:${getPart(p, 'minute')}:${getPart(p, 'second')} EST`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

/** Month, day, and time — for chart axes so multiple runs on the same day stay distinct. */
export function formatRunChartAxisLabel(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

/** Elapsed time from milliseconds: `X.XX hr` / `X.XX min` / `X.XX s`, or `n/a`. */
export function formatDurationSeconds(value: number | null | undefined): string {
  if (typeof value !== 'number') {
    return 'n/a';
  }
  if (value >= 3_600_000) {
    return `${(value / 3_600_000).toFixed(2)} hr`;
  }
  if (value >= 60_000) {
    return `${(value / 60_000).toFixed(2)} min`;
  }
  return `${(value / 1000).toFixed(2)} s`;
}

/** `m:ss` from milliseconds (total seconds rounded, clamped to non-negative). */
export function formatDurationMmSs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** RAG timing panel: sub-second as `Nms`, otherwise `X.XXs` (no space before unit). */
export function formatDurationMs(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}s`;
  }
  return `${Math.round(value)}ms`;
}

/* -------------------------------------------------------------------------- *
 * Eastern calendar helpers (B0-1166) — the nightly cron fires at 00:00 UTC, which is the
 * PREVIOUS evening in America/New_York and a different calendar day. Anything that asks "which
 * weekday did this sweep run on" must ask in Eastern, never from the UTC date.
 * -------------------------------------------------------------------------- */

const EASTERN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** `YYYY-MM-DD` of the instant in America/New_York (EST and EDT alike). */
export function easternDateKey(value: number | string): string {
  const p = easternParts(value);
  return `${getPart(p, 'year')}-${getPart(p, 'month')}-${getPart(p, 'day')}`;
}

/** Weekday of the instant in America/New_York: 0 = Sunday … 4 = Thursday … 6 = Saturday. */
export function easternWeekday(value: number | string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(new Date(value));
  return EASTERN_WEEKDAYS.indexOf(weekday as (typeof EASTERN_WEEKDAYS)[number]);
}

/** `Thu Sep 24, 2026 · 8:00 PM ET` — the sweep picker / export label, in Eastern. */
export function formatEasternSweepLabel(value: number | string): string {
  const date = new Date(value);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(date);
  // Weekday formatted separately: combined with the date Intl inserts a comma after it.
  const day = `${weekday} ${new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)}`;
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
  return `${day} · ${time} ET`;
}
