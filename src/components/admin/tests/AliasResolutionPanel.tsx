import { Badge } from '~/components/ui/badge';
import type { AliasResolutionOutcome, AliasResolutionReport } from '~/lib/tests/alias-routing';

type AliasResolutionPanelProps = {
  report: AliasResolutionReport;
};

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const OUTCOME_LABELS: Record<AliasResolutionOutcome, string> = {
  alias_exact: 'Alias exact',
  alias_fuzzy: 'Alias fuzzy',
  no_alias_match: 'No alias match',
  ambiguous_alias: 'Ambiguous alias',
};

const OUTCOME_BAR_CLASSNAMES: Record<AliasResolutionOutcome, string> = {
  alias_exact: 'bg-emerald-600',
  alias_fuzzy: 'bg-sky-600',
  no_alias_match: 'bg-slate-400',
  ambiguous_alias: 'bg-amber-500',
};

const OUTCOME_ORDER: AliasResolutionOutcome[] = [
  'alias_exact',
  'alias_fuzzy',
  'no_alias_match',
  'ambiguous_alias',
];

/**
 * B0-488 — per-run alias-resolution hit-rate panel: how often `rag.product_alias` resolution
 * actually fired (exact/fuzzy) vs. missed vs. was rejected as ambiguous, across every product-tool
 * call in this run that attempted to resolve a product name.
 *
 * Sibling of `RunToolRoutingPanel` (B0-383) and `RoutingAccuracyBoard` (B0-502) — same card shell,
 * same "headline badge + detail below" layout, same `workflow_steps.output.toolTrace` data source
 * (see `~/lib/tests/alias-routing.ts`) — extending that instrumentation pattern to alias
 * resolution instead of building a parallel metric surface.
 */
export function AliasResolutionPanel({ report }: AliasResolutionPanelProps) {
  const { totalAttempts, counts, hitRate, ambiguousRate } = report;
  const maxCount = OUTCOME_ORDER.reduce((max, outcome) => Math.max(max, counts[outcome]), 0);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Alias resolution</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            How often <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">rag.product_alias</code>{' '}
            resolution actually fired for a product-tool call in this run: exact match, fuzzy match, no
            match (fell through to broad/legacy retrieval), or an ambiguous match rejected by the
            verified-tiebreak gate (B0-483).
          </p>
        </div>
        {hitRate !== null ? (
          <Badge
            className={
              hitRate >= 0.8
                ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900'
                : hitRate >= 0.5
                  ? 'border-amber-500/45 bg-amber-500/12 text-amber-900'
                  : 'border-red-600/45 bg-red-600/12 text-red-900'
            }
            variant="outline"
          >
            {formatPercent(hitRate)} alias hit rate ({counts.alias_exact + counts.alias_fuzzy}/{totalAttempts})
          </Badge>
        ) : (
          <Badge variant="secondary">No alias-resolution attempts recorded for this run</Badge>
        )}
      </div>

      {totalAttempts === 0 ? (
        <p className="text-sm text-slate-500">
          No product-tool call in this run carried alias-resolution telemetry — every item either
          early-declined, never resolved a product name, or predates this instrumentation (B0-488).
        </p>
      ) : (
        <div className="space-y-2">
          {OUTCOME_ORDER.map((outcome) => (
            <div key={outcome} className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-xs text-slate-700">{OUTCOME_LABELS[outcome]}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full ${OUTCOME_BAR_CLASSNAMES[outcome]}`}
                  style={{
                    width: `${maxCount > 0 ? Math.max(4, (counts[outcome] / maxCount) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="w-24 shrink-0 whitespace-nowrap text-right text-xs text-slate-600">
                {counts[outcome]} call{counts[outcome] === 1 ? '' : 's'}
              </span>
            </div>
          ))}
          <p className="pt-1 text-xs text-slate-400">
            {totalAttempts} alias-resolution attempt{totalAttempts === 1 ? '' : 's'} across this run
            {ambiguousRate !== null ? ` · ${formatPercent(ambiguousRate)} rejected as ambiguous` : ''}.
          </p>
        </div>
      )}
    </section>
  );
}
