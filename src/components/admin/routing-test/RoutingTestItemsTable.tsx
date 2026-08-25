'use client';

import { Fragment, useMemo } from 'react';

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
import {
  ROUTING_TEST_AGENT_OPTIONS,
  routingTestAgentLabel,
} from '~/lib/routing-test/agent-options';
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

  // Total rendered column count, derived the same way the <TableHead>s below decide which
  // columns to show: Prompt + Expected agent + Actions, plus Predicted/Result/Router detail
  // when showResults is true. Kept as a formula (not a literal) so it can't drift from the
  // header row if columns are added later.
  const columnCount = 3 + (showResults ? 3 : 0);

  // B0-675 — group items by expected agent, ordering groups by the SME agent registry
  // (not by arbitrary sort) so the grouping stays stable as agents are added/removed.
  const groups = useMemo(() => {
    const itemsByAgent = new Map<string, RoutingTestItemRecord[]>();
    for (const item of items) {
      const existing = itemsByAgent.get(item.expected_agent);
      if (existing) {
        existing.push(item);
      } else {
        itemsByAgent.set(item.expected_agent, [item]);
      }
    }

    return ROUTING_TEST_AGENT_OPTIONS.map((option) => ({
      option,
      items: itemsByAgent.get(option.id) ?? [],
    })).filter((group) => group.items.length > 0);
  }, [items]);

  return (
    <div className="rounded-2xl border border-slate-200 overflow-hidden">
      <div className="max-h-[75vh] overflow-x-auto overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow className="sticky top-0 z-10 bg-white">
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
          {groups.map((group) => (
            <Fragment key={`group-${group.option.id}`}>
              <TableRow className="bg-slate-50 hover:bg-slate-50">
                <TableCell
                  colSpan={columnCount}
                  className="text-sm font-medium text-slate-700"
                >
                  {routingTestAgentLabel(group.option.id)} ·{' '}
                  {group.items.length}
                </TableCell>
              </TableRow>
              {group.items.map((item) => {
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
            </Fragment>
          ))}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}
