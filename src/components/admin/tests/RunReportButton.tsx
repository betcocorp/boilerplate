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

/** Links into `/admin/tests/[testId]/runs/[runId]/report`, which owns triggering generation. */
export function RunReportButton({
  testId,
  runId,
  enabled,
  hasExistingReport,
}: RunReportButtonProps) {
  const label = hasExistingReport ? 'View report' : 'Generate report';

  if (!enabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button disabled size="sm" variant="outline">
              <FileText className="size-4" />
              {label}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Reports can only be generated once this run has finished.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Button asChild size="sm" variant="outline">
      <Link href={`/admin/tests/${testId}/runs/${runId}/report`}>
        <FileText className="size-4" />
        {label}
      </Link>
    </Button>
  );
}
