/**
 * B0-629 — one consolidated provenance footer for the `/admin` Mission Control dashboard.
 *
 * The Bex Health dashboard gives every panel its own `ProvenanceFooter` (B0-584). Mission Control
 * is a denser grid where five per-panel footers would outweigh the panels, so the same obligation
 * is met once at the foot of the page: each panel exports the `sources` for the reader it actually
 * calls, and this component prefixes each line with the panel that owns it. Nothing is dropped and
 * there is still no toggle.
 *
 * MAINTENANCE NOTE (inherited from `ProvenanceFooter`): when a panel's data source changes —
 * reader, table, view or RPC — that panel's exported `*_SOURCES` MUST change in the same commit.
 * A stale footer is worse than none. This file only orders them; it states nothing of its own.
 */

import { ProvenanceFooter } from '~/components/admin/bex-health/ProvenanceFooter';

import { HEALTH_BAR_SOURCES } from './HealthBar';
import { KPI_ROW_SOURCES } from './KpiRow';
import { PIPELINE_PANEL_SOURCES } from './PipelinePanel';
import { ROUTING_SOURCES } from './RoutingPanel';
import { TOOL_HEALTH_SOURCES } from './ToolHealthPanel';

/** Panel label → that panel's own sources, in the order the panels appear on the page. */
const PANEL_SOURCES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Health bar', HEALTH_BAR_SOURCES],
  ['KPI row', KPI_ROW_SOURCES],
  ['The pipeline', PIPELINE_PANEL_SOURCES],
  ['Routing', ROUTING_SOURCES],
  ['Tool health', TOOL_HEALTH_SOURCES],
];

export function DashboardProvenance() {
  const sources = PANEL_SOURCES.flatMap(([panel, panelSources]) =>
    panelSources.map((source) => `${panel} — ${source}`),
  );

  return (
    <section className="rounded-2xl border border-border/60 bg-card p-5">
      <h2 className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
        Where these numbers come from
      </h2>
      <ProvenanceFooter sources={sources} />
    </section>
  );
}
