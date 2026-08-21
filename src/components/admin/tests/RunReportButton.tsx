import { FileText } from 'lucide-react';
import Link from 'next/link';

import { Button } from '~/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip';

type RunReportButtonProps = {
  testId: string;
  runId: string;
  /** Reports can only be generated once the run has finished executing. */
  enabled: boolean;
  hasExistingReport: boolean;
};

/**
 * Links into `/admin/tests/[testId]/runs/[runId]/report`, which owns triggering generation.
 *
 * B0-608 — report generation is now automatic (kicked off by `executeTestRun` on run completion),
 * so there is no manual "Generate report" affordance any more: once a report exists we link to it
 * as "View report". The `/report` route itself is unchanged — it still safely no-ops/continues if
 * hit while scoring, which is what powers the report page's own auto-continue behavior.
 *
 * B0-611 — while a report is generating (`enabled && !hasExistingReport`), "Generating report…"
 * is now clickable too, linking to that same route so the user can watch the in-progress/loading
 * state `RunReportView` already renders instead of staring at a disabled button. Only the run's
 * not-yet-finished state (`!enabled`) has nowhere to send anyone, so it stays disabled.
 */
export function RunReportButton({
  testId,
  runId,
  enabled,
  hasExistingReport,
}: RunReportButtonProps) {
  if (hasExistingReport || enabled) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={`/admin/tests/${testId}/runs/${runId}/report`}>
          <FileText className="size-4" />
          {hasExistingReport ? 'View report' : 'Generating report…'}
        </Link>
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button disabled size="sm" variant="outline">
            <FileText className="size-4" />
            Generating report…
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Reports can only be generated once this run has finished.
      </TooltipContent>
    </Tooltip>
  );
}
