'use client';

/**
 * B0-457 — collapsible filter bar for `/admin/observability` (epic B0-330).
 *
 * Client component so the "Filters" section can start collapsed to just its
 * title (the aggregate dashboard this originally matched was retired to
 * `/admin/bex/health` in B0-585). The form itself still submits as a plain
 * GET (see `RunsTable.tsx`'s doc comment) — this component only adds the
 * show/hide affordance around it.
 */

import { ChevronDownIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { FormSelectField } from '~/components/admin/FormSelectField';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { SME_AGENT_IDS } from '~/lib/agents/agent-registry';
import { PRODUCT_TOOL_NAMES } from '~/lib/tools/tool-schemas';

import type { RunsTableFilters } from './RunsTable';

/** `workflow_runs.status` values written by `run-product-support-workflow.ts`. */
const RUN_STATUSES = ['running', 'completed', 'failed'] as const;

/**
 * Filterable `final_output->>routingDecision` values. Mirrors
 * `routingDecisionSchema` in `~/lib/orchestrator/orchestrator-schemas.ts`:
 * an SME agent id, or `ambiguous` when the planner could not commit.
 */
const ROUTING_FILTER_OPTIONS = [...SME_AGENT_IDS, 'ambiguous'] as const;

/**
 * B0-416 — the stored `workflow_runs.source` values plus the `unknown` (NULL) cohort, with the
 * label and badge styling used for each. `unknown` is runs recorded before the column existed
 * that no harness item points at: their entry point is not recoverable from anything on the row,
 * so they are labelled unknown rather than assumed to be chat traffic.
 */
const RUN_SOURCE_OPTIONS = [
  { value: 'bex_chat', label: 'Bex chat' },
  { value: 'orchestrator_api', label: 'Orchestrator API' },
  { value: 'harness', label: 'Test harness' },
  { value: 'unknown', label: 'Unknown (pre-instrumentation)' },
] as const;

export function RunsFilters({
  route,
  filters,
  testOptions,
}: {
  route: string;
  filters: RunsTableFilters;
  /** B0-338 — options for the "single test" filter dropdown. */
  testOptions: { id: string; name: string }[];
}) {
  // B0-457 — filter form is collapsed by default; only the "Filters" title always renders.
  const [showFilters, setShowFilters] = useState(false);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          aria-expanded={showFilters}
          className="w-full inline-flex items-center justify-between gap-1.5 rounded-full py-1.5 text-xs font-medium text-slate-600"
          onClick={() => setShowFilters((open) => !open)}
          type="button"
        >
          <h2 className="text-lg font-semibold text-slate-900">Filters</h2>
          <ChevronDownIcon
            aria-hidden
            className={`size-4 shrink-0 transition-transform duration-300 ${showFilters ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {showFilters ? (
        <>
          <form
            action={route}
            className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
            method="get"
          >
            {/* Full width and first: the highest-intent control, and it has to read as
                part of the server-side filter set rather than as a filter over the
                rows currently on screen. */}
            <div className="flex min-w-0 flex-col gap-2 sm:col-span-2 lg:col-span-4">
              <Label
                className="text-sm text-slate-700"
                htmlFor="observability-search"
              >
                Search
              </Label>
              <Input
                defaultValue={filters.search}
                id="observability-search"
                name="q"
                placeholder="Words from the prompt, or paste a run ID"
                type="search"
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="observability-from"
              >
                From (EST)
              </Label>
              <Input
                defaultValue={filters.from}
                id="observability-from"
                name="from"
                type="date"
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="observability-to"
              >
                To (EST)
              </Label>
              <Input
                defaultValue={filters.to}
                id="observability-to"
                name="to"
                type="date"
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="observability-status"
              >
                Status
              </Label>
              <FormSelectField
                defaultValue={filters.status}
                id="observability-status"
                name="status"
                options={[
                  { value: '', label: 'All statuses' },
                  ...RUN_STATUSES.map((status) => ({
                    value: status,
                    label: status,
                  })),
                ]}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="observability-agent"
              >
                Agent / routing
              </Label>
              <FormSelectField
                defaultValue={filters.routingDecision}
                id="observability-agent"
                name="agent"
                options={[
                  { value: '', label: 'All agents' },
                  ...ROUTING_FILTER_OPTIONS.map((agent) => ({
                    value: agent,
                    label: agent,
                  })),
                ]}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="observability-confidence-min"
              >
                Confidence min (0–1)
              </Label>
              <Input
                defaultValue={filters.confidenceMin}
                id="observability-confidence-min"
                max="1"
                min="0"
                name="confidenceMin"
                placeholder="0"
                step="0.05"
                type="number"
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="observability-confidence-max"
              >
                Confidence max (0–1)
              </Label>
              <Input
                defaultValue={filters.confidenceMax}
                id="observability-confidence-max"
                max="1"
                min="0"
                name="confidenceMax"
                placeholder="1"
                step="0.05"
                type="number"
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="observability-source"
              >
                Source
              </Label>
              <FormSelectField
                defaultValue={filters.source}
                id="observability-source"
                name="source"
                options={[
                  { value: '', label: 'All sources' },
                  ...RUN_SOURCE_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  })),
                ]}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="observability-user"
              >
                Asked by (email or user ID)
              </Label>
              <Input
                defaultValue={filters.userId}
                id="observability-user"
                name="userId"
                placeholder="name@betco.com"
                type="text"
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="observability-test"
              >
                Test
              </Label>
              <FormSelectField
                defaultValue={filters.testId}
                id="observability-test"
                name="testId"
                options={[
                  { value: '', label: 'All tests' },
                  ...testOptions.map((test) => ({
                    value: test.id,
                    label: test.name,
                  })),
                ]}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="observability-tool"
              >
                Tool call
              </Label>
              <FormSelectField
                defaultValue={filters.toolName}
                id="observability-tool"
                name="tool"
                options={[
                  { value: '', label: 'All tools' },
                  ...PRODUCT_TOOL_NAMES.map((tool) => ({
                    value: tool,
                    label: tool,
                  })),
                ]}
              />
            </div>

            <div className="flex items-end gap-2">
              <Button type="submit">Apply filters</Button>
              <Button asChild type="button" variant="outline">
                <Link href={route}>Reset</Link>
              </Button>
            </div>
          </form>
          <p className="mt-4 text-xs text-slate-500">
            Defaults to the last 7 days. Search matches the prompt text across
            the whole selected window, not just the runs on this page. A run ID
            is looked up on its own and ignores the date range, so an older run
            still resolves. Applying a confidence bound excludes runs that never
            recorded a confidence (in-flight or failed runs). &ldquo;Asked
            by&rdquo; and &ldquo;Test&rdquo; filter to runs attributed (B0-338)
            to that one user or that one test, regardless of the run&apos;s
            source. &ldquo;Tool call&rdquo; narrows to runs whose agent step
            actually called that tool at least once.
          </p>
        </>
      ) : null}
    </section>
  );
}
