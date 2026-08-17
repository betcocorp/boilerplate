/**
 * B0-531 / B0-532 — turn-level latency split for `agent_messages`.
 *
 * Two distinct measurements, each stored on exactly one message row:
 *  - **user pause** (`agent_messages.user_pause_ms`, on `role='user'` rows): the gap between the
 *    previous *assistant* message's completion (`created_at`) and this user message. How long the
 *    user sat before replying.
 *  - **agent processing** (`agent_messages.processing_ms`, on `role='assistant'` rows): the gap
 *    between the triggering *user* message's `created_at` and this assistant message. How long
 *    Bex took to answer.
 *
 * Both are computed from Postgres-stamped `created_at` values within a single conversation
 * (act-as-aware: attribution is by `conversation_id` only — never joined across owners), and
 * clamped at 0. The clamp mirrors the `workflow_steps` precedent: `started_at` there is Postgres
 * `now()` while `completed_at` is the Node clock, and that cross-clock skew makes fast steps go
 * negative. Message rows are both Postgres-stamped so skew should not occur, but the clamp keeps
 * the invariant durable against any future writer that supplies its own `created_at` — negative
 * spans are clamped, never dropped.
 */

export type PauseTier = 'instant' | 'short' | 'medium' | 'long' | 'abandoned';

/**
 * Tier boundaries, in ms. Each tier covers durations strictly below its bound; `abandoned` is
 * everything at or above `long`'s bound.
 *
 * MUST stay in sync with the `pause_tier` stored generated column on `public.agent_messages`
 * (migration `20260817120000_add_turn_metrics_to_agent_messages_b0531.sql`) — the database is
 * what dashboards read, this constant is what tests and any in-process classification use.
 * Change both together.
 */
export const PAUSE_TIER_BOUNDARIES_MS = {
  /** < 5s — the user replied essentially immediately. */
  instant: 5_000,
  /** < 30s — a normal reading-and-typing pause. */
  short: 30_000,
  /** < 5m — the user stepped away briefly or is multitasking. */
  medium: 300_000,
  /** < 1h — the conversation went idle and was picked back up. */
  long: 3_600_000,
  /** >= 1h — treated as an abandoned-and-resumed session. */
} as const;

export const PAUSE_TIER_ORDER: readonly PauseTier[] = [
  'instant',
  'short',
  'medium',
  'long',
  'abandoned',
];

/**
 * Deterministic tier for a pause duration. Negative inputs are classified as `instant` rather
 * than rejected: a negative span is clock skew on a fast turn, not a data error (same reasoning
 * as the 0-clamp in `clampedDurationMs`).
 */
export function classifyPauseTier(pauseMs: number): PauseTier {
  if (pauseMs < PAUSE_TIER_BOUNDARIES_MS.instant) {
    return 'instant';
  }
  if (pauseMs < PAUSE_TIER_BOUNDARIES_MS.short) {
    return 'short';
  }
  if (pauseMs < PAUSE_TIER_BOUNDARIES_MS.medium) {
    return 'medium';
  }
  if (pauseMs < PAUSE_TIER_BOUNDARIES_MS.long) {
    return 'long';
  }
  return 'abandoned';
}

/** Narrows arbitrary stored text (the column is untyped `text`) to the tier enum. */
export function readPauseTier(value: string | null): PauseTier | null {
  return value !== null && (PAUSE_TIER_ORDER as readonly string[]).includes(value)
    ? (value as PauseTier)
    : null;
}

/**
 * `toIso - fromIso` in ms, clamped at 0. Returns null when either timestamp is unparseable —
 * an unknown duration must stay unknown, never become 0. A negative raw span (cross-clock skew
 * on a fast turn) is clamped to 0 rather than dropped or filtered.
 */
export function clampedDurationMs(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return null;
  }
  return Math.max(0, to - from);
}
