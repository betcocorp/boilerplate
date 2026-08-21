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
 * as "View report"; until then we show a non-interactive "Generating report…" state instead of an
 * actionable button. The `/report` route itself is unchanged — it still safely no-ops/continues if
 * hit while scoring, which is what powers the report page's own auto-continue behavior.
 */
export function RunReportButton({
  testId,
  runId,
  enabled,
  hasExistingReport,
}: RunReportButtonProps) {
  if (hasExistingReport) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={`/admin/tests/${testId}/runs/${runId}/report`}>
          <FileText className="size-4" />
          View report
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
        {enabled
          ? 'The report is generated automatically after a run finishes and may take a few minutes for large runs.'
          : 'Reports can only be generated once this run has finished.'}
      </TooltipContent>
    </Tooltip>
  );
}
