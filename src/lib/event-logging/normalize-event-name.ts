/**
 * Prefix used in `event_logging` for page-view events (a subset of analytics).
 * Filter: `event LIKE 'analytics.page.view%'`.
 */
export const PAGE_VIEW_EVENT_PREFIX = 'analytics.page.view';

/**
 * Normalizes the event name before persist: adds `analytics.` when missing.
 * Names that already start with `analytics.` are unchanged (including page views
 * from {@link PAGE_VIEW_EVENT_PREFIX}).
 */
export function normalizeAnalyticsEventName(event: string): string {
  const t = event.trim();
  if (!t) return t;
  if (t.startsWith('analytics.')) return t;
  return `analytics.${t}`;
}
