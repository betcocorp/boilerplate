'use client';

import { DeleteRoutingTestItemDialog } from '~/components/admin/routing-test/DeleteRoutingTestItemDialog';
import { EditRoutingTestItemDialog } from '~/components/admin/routing-test/EditRoutingTestItemDialog';
import { RoutingTestResultDetail } from '~/components/admin/routing-test/RoutingTestResultDetail';
import { Badge } from '~/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { routingTestAgentLabel } from '~/lib/routing-test/agent-options';
import type {
  RoutingTestItemRecord,
  RoutingTestItemResult,
} from '~/lib/routing-test/types';

type RoutingTestItemsTableProps = {
  items: RoutingTestItemRecord[];
  returnPath: string;
  /** B0-659 — ephemeral per-item run results, keyed by item id. Empty until a run happens. */
  resultsByItemId?: Record<string, RoutingTestItemResult>;
};

export function RoutingTestItemsTable({
  items,
  returnPath,
  resultsByItemId,
}: RoutingTestItemsTableProps) {
  const showResults = Boolean(
    resultsByItemId && Object.keys(resultsByItemId).length > 0,
  );

  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40%]">Prompt</TableHead>
            <TableHead>Expected agent</TableHead>
            {showResults ? <TableHead>Predicted</TableHead> : null}
            {showResults ? <TableHead>Result</TableHead> : null}
            {showResults ? (
              <TableHead className="w-[30%]">Router detail</TableHead>
            ) : null}
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const result = resultsByItemId?.[item.id];

            return (
              <TableRow key={item.id}>
                <TableCell className="max-w-md align-top text-sm whitespace-pre-wrap text-slate-800">
                  {item.prompt}
                </TableCell>
                <TableCell className="align-top">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-slate-900">
                      {routingTestAgentLabel(item.expected_agent)}
                    </span>
                    <span className="text-xs text-slate-500">
                      {item.expected_agent}
                    </span>
                  </div>
                </TableCell>

                {showResults ? (
                  <TableCell className="align-top text-sm text-slate-800">
                    {result ? (
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
                        {result.predicted}
                      </code>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </TableCell>
                ) : null}

                {showResults ? (
                  <TableCell className="align-top">
                    {result ? (
                      <Badge
                        variant={result.passed ? 'default' : 'destructive'}
                      >
                        {result.passed ? 'Pass' : 'Fail'}
                      </Badge>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </TableCell>
                ) : null}

                {showResults ? (
                  <TableCell className="align-top">
                    {result ? (
                      <RoutingTestResultDetail result={result} />
                    ) : (
                      <span className="text-xs text-slate-400">
                        Not part of the last run.
                      </span>
                    )}
                  </TableCell>
                ) : null}

                <TableCell className="align-top text-right">
                  <div className="flex justify-end gap-2">
                    <EditRoutingTestItemDialog
                      item={item}
                      returnPath={returnPath}
                    />
                    <DeleteRoutingTestItemDialog
                      itemId={item.id}
                      promptPreview={item.prompt}
                      returnPath={returnPath}
                    />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
