import { ArrowDown, ArrowUp, Minus } from 'lucide-react';

/**
 * B0-1170 — a one-line "↓ from 7" trend indicator under a scorecard value, read against the same
 * agent's value in the previous Thursday-night sweep. Renders nothing when either side was never
 * recorded: an absent comparison is not "no change". Icon and text are always present so colour
 * is never the only signal. Server-safe.
 */
export function TrendDelta({
  current,
  previous,
  betterWhen,
  format = (n) => String(n),
  label = 'Value',
}: {
  current: number | null;
  previous: number | null;
  /** Which direction is an improvement — fails going down is good, speed/score going up is good. */
  betterWhen: 'higher' | 'lower';
  format?: (n: number) => string;
  /** Names the metric in the hover title. */
  label?: string;
}) {
  if (current === null || previous === null) return null;

  const rising = current > previous;
  const falling = current < previous;
  const improved = betterWhen === 'higher' ? rising : falling;
  const regressed = betterWhen === 'higher' ? falling : rising;
  const Icon = rising ? ArrowUp : falling ? ArrowDown : Minus;
  const tone = improved
    ? 'text-emerald-600'
    : regressed
      ? 'text-rose-600'
      : 'text-slate-500';

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs tabular-nums ${tone}`}
      title={`${label}: ${format(previous)} → ${format(current)} vs the previous Thursday-night sweep`}
    >
      <Icon aria-hidden className="size-3" />
      {`from ${format(previous)}`}
    </span>
  );
}
