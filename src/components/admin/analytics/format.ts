/**
 * B0-761 — pure formatters for the event-analytics dashboard (no JSX, no deps — unit-testable).
 *
 * Hour/day-axis and event-name helpers specific to this dashboard (plus `formatInt`). This repo has no `date-fns`, so day strings are parsed
 * as literal `YYYY-MM-DD` text rather than through `Date` — that also keeps a EST calendar day from
 * sliding a day backwards when the viewer sits west of EST.
 */

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Fixed EST reference day; only the hour field is ever varied. */
const HOUR_REFERENCE_DAY = Date.UTC(2024, 0, 1);
const HOUR_MS = 60 * 60 * 1000;

const hourFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  hour12: true,
  timeZone: 'EST',
});

/** Wraps any integer into 0–23; anything non-finite becomes 0 so a chart never renders `NaN`. */
export function normalizeHour(hour: number): number {
  if (!Number.isFinite(hour)) return 0;
  return ((Math.trunc(hour) % 24) + 24) % 24;
}

/** Compact axis tick for an hour bucket, e.g. `15` → `3pm`. */
export function formatHourTick(hour: number): string {
  return hourFormatter
    .format(new Date(HOUR_REFERENCE_DAY + normalizeHour(hour) * HOUR_MS))
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** Readable hour bucket for prose and tooltips, e.g. `15` → `3 PM – 4 PM`. */
export function formatHourRange(hour: number): string {
  const start = normalizeHour(hour);
  const end = normalizeHour(start + 1);
  const label = (value: number) =>
    hourFormatter.format(new Date(HOUR_REFERENCE_DAY + value * HOUR_MS));
  return `${label(start)} – ${label(end)}`;
}

/** `2026-08-30` → `Aug 30`. Non-day strings pass through untouched. */
export function formatDayLabel(value: string): string {
  const match = DAY_PATTERN.exec(value);
  if (!match) return value;
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return value;
  return `${MONTH_ABBREVIATIONS[monthIndex]} ${Number(match[3])}`;
}

/** `2026-08-30` → `08-30`, for dense axes where the month word will not fit. */
export function formatDayTick(value: string): string {
  return DAY_PATTERN.test(value) ? value.slice(5) : value;
}

/** Event names are unbounded dotted strings; keep cards and legends from blowing out. */
export function truncateEvent(name: string, max = 48): string {
  if (max <= 1) return name.slice(0, Math.max(0, max));
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

/**
 * Readable timestamp for the recent-activity table. `timeZone` is exposed so tests are not at the
 * mercy of the runner's zone; production passes nothing and gets the viewer's local time.
 */
export function formatEventTimestamp(iso: string, timeZone?: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: 'numeric',
    hour12: true,
    minute: '2-digit',
    month: 'short',
    timeZone,
  }).format(parsed);
}

export function formatInt(n: number): string {
  return n.toLocaleString('en-US');
}
