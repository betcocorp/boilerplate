export { logEvent } from '~/lib/event-logging/log-event';
// NOTE: `logServerEvent` is deliberately NOT re-exported here. This barrel is imported by
// client components (e.g. PageViewLogger), and that module pulls in the Supabase
// service-role client — server-only code that must never enter the client bundle.
// Server callers import '~/lib/event-logging/log-server-event' directly.
export {
  ANALYTICS_SESSION_STORAGE_KEY,
  getAnalyticsSessionId,
} from '~/lib/event-logging/session-id';
export {
  SEARCH_RESULT_CLICK_EVENT,
  SEARCH_SUBMIT_EVENT,
  buildSearchResultClickEvent,
  buildSearchSubmitEvent,
  logSearchResultClick,
  logSearchSubmit,
} from '~/lib/event-logging/search-events';
export type {
  SearchEntityType,
  SearchResultClickArgs,
  SearchSubmitArgs,
} from '~/lib/event-logging/search-events';
export {
  normalizeAnalyticsEventName,
  PAGE_VIEW_EVENT_PREFIX,
} from '~/lib/event-logging/normalize-event-name';
export { buildSentryPayloadForEvent } from '~/lib/event-logging/collect-sentry-context';
export { inferPageViewFromPath } from '~/lib/event-logging/infer-page-view';
export type { PageViewInference } from '~/lib/event-logging/infer-page-view';
export { eventLogRequestBodySchema } from '~/lib/event-logging/types';
export type {
  EventLogging,
  EventLogRequestBody,
  EventLogResult,
} from '~/lib/event-logging/types';
