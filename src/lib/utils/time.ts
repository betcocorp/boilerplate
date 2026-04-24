/**
 * Shared date / duration formatting used across admin UI.
 */

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
