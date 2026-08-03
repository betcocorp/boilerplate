/**
 * Badge colors for an orchestrator routing decision (SME agent id).
 * Shared by the test-run detail page and the prompt observability pages so a
 * given agent always reads with the same color across admin surfaces.
 */
export function getAgentBadgeClassName(
  routingDecision: string | null | undefined,
): string {
  switch (routingDecision) {
    case 'product':
      return 'border-sky-600/45 bg-sky-600/12 text-sky-900';
    case 'bathroom':
      return 'border-purple-600/45 bg-purple-600/12 text-purple-900';
    case 'dilution':
      return 'border-amber-600/45 bg-amber-600/12 text-amber-900';
    case 'floor':
      return 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900';
    case 'recommendations':
      return 'border-rose-600/45 bg-rose-600/12 text-rose-900';
    default:
      return '';
  }
}
