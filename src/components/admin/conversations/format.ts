/**
 * B0-533 — millisecond formatting for the conversation browser. `formatDurationMs` renders a
 * number; this wraps it so a NULL metric (pre-B0-532 rows, first turn of a conversation) reads as
 * an explicit dash instead of `0ms`.
 */

import { formatDurationMs, formatDurationSeconds } from '~/lib/utils/time';

/** Sub-minute values keep `formatDurationMs` precision; anything longer reads as min / hr. */
export function formatMs(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }
  return value >= 60_000 ? formatDurationSeconds(value) : formatDurationMs(value);
}

export function formatConfidence(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '—';
}

export function formatShare(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

export function truncateChars(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
