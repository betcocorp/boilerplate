/**
 * B0-338 — shared "Asked by" rendering for a `RunAttribution` (epic B0-330 Phase 8).
 *
 * Used by both the runs list (`RunsTable.tsx`, one cell per row) and the single-run trace page
 * header, so the three attributed states and the explicit unattributed state read identically in
 * both places.
 */

import Link from 'next/link';

import { Badge } from '~/components/ui/badge';

import type { RunAttribution } from '~/types/observability';

const API_CLIENT_BADGE_CLASSNAME = 'border-cyan-600/45 bg-cyan-600/12 text-cyan-900';
const UNKNOWN_BADGE_CLASSNAME = 'border-slate-300 bg-slate-100 text-slate-500';

function truncate(text: string, maxChars: number | undefined): string {
  if (!maxChars || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

export function RunAttributionBadge({
  attribution,
  maxChars,
}: {
  attribution: RunAttribution;
  /** Truncate the displayed name/label to this many characters (full value stays in `title`). */
  maxChars?: number;
}) {
  switch (attribution.kind) {
    case 'user': {
      const label = attribution.displayName ?? attribution.email ?? attribution.userId;
      return (
        <span className="text-slate-800" title={attribution.email ?? label}>
          {truncate(label, maxChars)}
        </span>
      );
    }

    case 'test':
      return (
        <Link
          className="text-sky-700 underline-offset-2 hover:underline"
          href={`/admin/tests/${attribution.testId}/runs/${attribution.testResultId}`}
          title="Open this test's run page"
        >
          {truncate(attribution.testName, maxChars)}
        </Link>
      );

    case 'api_client':
      return (
        <Badge
          className={API_CLIENT_BADGE_CLASSNAME}
          title="/api/v1/orchestrator caller. The specific app/project cannot be correlated to this run today (out of scope, B0-338)."
          variant="outline"
        >
          API client (unattributed)
        </Badge>
      );

    case 'unknown':
    default:
      return (
        <Badge
          className={UNKNOWN_BADGE_CLASSNAME}
          title="No user, test, or API client could be attributed to this run."
          variant="outline"
        >
          Unattributed
        </Badge>
      );
  }
}
