/**
 * B0-629 — shared display formatters for the `/admin` Mission Control dashboard.
 *
 * The Bex Health panels each defined their own local `formatMs`/`formatCount`; with five
 * dashboard panels sharing one visual language they live here instead, so a figure is
 * formatted the same way in every card.
 *
 * The one rule these encode: a missing measurement renders as EM_DASH, never as `0`.
 * `null` reaching any of these means "not measured" — see `NOT_MEASURED` in
 * `~/lib/observability/live-traffic.ts`, which uses the same em dash for the same reason.
 */

/** Shown wherever a figure was not measured. Never substitute a zero. */
export const EM_DASH = '—';

/** `8.20s` above a second, `116ms` below it — matching the Bex Health stage strip. */
export function formatMs(value: number | null): string {
  if (value === null) return EM_DASH;
  return value >= 1000
    ? `${(value / 1000).toFixed(2)}s`
    : `${Math.round(value)}ms`;
}

export function formatCount(value: number | null): string {
  if (value === null) return EM_DASH;
  return value.toLocaleString('en-US');
}

/** `rate` is 0..1. `2.1%`; trailing `.0` kept so a KPI row stays column-aligned. */
export function formatRatePercent(
  rate: number | null,
  fractionDigits = 1,
): string {
  if (rate === null) return EM_DASH;
  return `${(rate * 100).toFixed(fractionDigits)}%`;
}

/** Window spend, e.g. `$12.84`. */
export function formatUsd(value: number | null): string {
  if (value === null) return EM_DASH;
  return `$${value.toFixed(2)}`;
}

/**
 * Per-run cost, e.g. `$0.0078`. Kept at four decimals because per-run spend is routinely
 * under a cent, where `formatUsd` would round every value to `$0.00`.
 */
export function formatUsdPerRun(value: number | null): string {
  if (value === null) return EM_DASH;
  return `$${value.toFixed(4)}`;
}

/**
 * A percentage-POINT movement between two rates, as words plus a signed magnitude —
 * "up 0.6 pts" / "down 0.6 pts" / "flat". Direction is stated in words because colour is
 * never the only signal (the same rule the verdict strip follows), and the unit is "pts"
 * because these are differences of percentages, not a percentage change.
 */
export function formatDeltaPoints(deltaPoints: number | null): string {
  if (deltaPoints === null) return EM_DASH;
  const rounded = Number(deltaPoints.toFixed(1));
  if (rounded === 0) return 'flat';
  return `${rounded > 0 ? 'up' : 'down'} ${Math.abs(rounded).toFixed(1)} pts`;
}

/** Compact token counts, e.g. `9,246 tokens/run`. */
export function formatTokensPerRun(value: number | null): string {
  if (value === null) return EM_DASH;
  return `${Math.round(value).toLocaleString('en-US')} tokens/run`;
}
