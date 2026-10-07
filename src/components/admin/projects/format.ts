/** Pure formatters for the API-security admin pages (no JSX — unit-testable). */

export function formatInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Compact relative "last used" label, e.g. "3m ago", "2d ago", or "never". */
export function formatLastUsed(value: string | null, now: number = Date.now()): string {
  if (!value) return 'never';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return 'never';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
