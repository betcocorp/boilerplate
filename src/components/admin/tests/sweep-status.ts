/**
 * B0-1107 — the one badge palette for sweep ledger statuses (parent `scheduled_test_runs.status`,
 * child `scheduled_test_items.status`) and, on the sweep detail cards, a linked run's live
 * `test_results.status`. Shared by /admin/scheduled and the /admin/tests sweep pages so the same
 * status never reads in two colours.
 */
export function getStatusBadgeColor(status: string): string {
  switch (status) {
    case 'queued':
      return 'border-slate-400 bg-slate-100 text-slate-900';
    case 'in_progress':
    case 'claimed':
    case 'running':
      return 'border-blue-400 bg-blue-100 text-blue-900';
    case 'completed':
      return 'border-green-400 bg-green-100 text-green-900';
    case 'completed_with_failures':
      return 'border-amber-400 bg-amber-100 text-amber-900';
    case 'failed':
    case 'technical_error':
      return 'border-red-400 bg-red-100 text-red-900';
    case 'timed_out':
      return 'border-orange-400 bg-orange-100 text-orange-900';
    default:
      return 'border-slate-300 bg-slate-50 text-slate-600';
  }
}
