/**
 * B0-584 — per-panel provenance footer for the `/admin` dashboard panels (epic B0-569).
 *
 * Names the tables/views/RPCs the panel's reader ACTUALLY queries, so every figure on the
 * page is arguable back to its source. Always rendered — there is deliberately no toggle.
 * A source a panel cannot state honestly (e.g. a selector that does not apply to it) is
 * said so in a line, never omitted.
 *
 * MAINTENANCE NOTE: these strings are hand-verified against each panel's reader. When a
 * panel's data source changes — reader, table, view, or RPC — the `sources` that panel
 * passes MUST change in the same commit; a stale footer is worse than none.
 */
export function ProvenanceFooter({
  sources,
  tone = 'light',
}: {
  /** One line per source, in reading order. */
  sources: string[];
  /** `dark` for panels on a dark card (the verdict strip). */
  tone?: 'light' | 'dark';
}) {
  const dark = tone === 'dark';
  return (
    <footer
      className={
        dark ? 'mt-6 border-t border-slate-800 pt-3' : 'mt-6 border-t border-slate-100 pt-3'
      }
    >
      <ul
        className={[
          'space-y-0.5 text-[11px] leading-5',
          dark ? 'text-slate-500' : 'text-slate-400',
        ].join(' ')}
      >
        {sources.map((source) => (
          <li key={source}>
            <span className={dark ? 'font-medium text-slate-400' : 'font-medium text-slate-500'}>
              Source
            </span>{' '}
            · {source}
          </li>
        ))}
      </ul>
    </footer>
  );
}
