'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import {
  approveCategoryLinkAction,
  bulkReassignCategoryLinksAction,
  deleteCategoryLinkAction,
  reassignCategoryLinkAction,
  type BulkReassignState,
  type CurationActionState,
} from '~/lib/category/category-curation-actions';
import type { CurationFilter, CurationLinkRow, CurationTaxonomyOption } from '~/lib/category/curation-repository';

// Inlined (not imported from classifier-repository, which is server-only) to keep this a pure client module.
const CLASSIFIER_LINK_SOURCE = 'classifier';
const HUMAN_CURATED_LINK_SOURCE = 'human_curated';

const FILTER_TABS: Array<{ key: CurationFilter; label: string }> = [
  { key: 'all', label: 'All links' },
  { key: 'low_confidence', label: 'Low confidence' },
  { key: 'classifier', label: 'Classifier proposals' },
  { key: 'human_curated', label: 'Human-curated' },
  { key: 'unlinked', label: 'Unlinked' },
];

const SOURCE_BADGE: Record<string, string> = {
  [HUMAN_CURATED_LINK_SOURCE]: 'bg-emerald-50 text-emerald-700',
  [CLASSIFIER_LINK_SOURCE]: 'bg-amber-50 text-amber-700',
  betco_site_scrape: 'bg-sky-50 text-sky-700',
};

const rowToken = (row: CurationLinkRow): string =>
  `${row.prodLineKey}::${row.prodLineId ?? ''}::${row.categoryKey}`;

function CategoryOptions({ options }: { options: CurationTaxonomyOption[] }) {
  return (
    <>
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.path.length > 0 ? o.path.join(' › ') : o.name}
        </option>
      ))}
    </>
  );
}

function CurationRow({ row, options }: { row: CurationLinkRow; options: CurationTaxonomyOption[] }) {
  const [approveState, approve, approving] = useActionState<CurationActionState, FormData>(
    approveCategoryLinkAction,
    null,
  );
  const [reassignState, reassign, reassigning] = useActionState<CurationActionState, FormData>(
    reassignCategoryLinkAction,
    null,
  );
  const [deleteState, remove, removing] = useActionState<CurationActionState, FormData>(
    deleteCategoryLinkAction,
    null,
  );

  const isLinked = row.categoryKey.length > 0;
  const isClassifier = row.source === CLASSIFIER_LINK_SOURCE;
  const rowError = approveState?.error ?? reassignState?.error ?? deleteState?.error ?? null;

  return (
    <tr className="border-b border-slate-100 align-top last:border-0">
      <td className="py-3 pr-3">
        <input type="checkbox" name="rows" value={rowToken(row)} form="bulk-reassign-form" className="mt-1" />
      </td>
      <td className="py-3 pr-4">
        <p className="text-sm font-medium text-slate-800">{row.prodLineTitle ?? 'Untitled product line'}</p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-400">{row.prodLineKey}</p>
      </td>
      <td className="py-3 pr-4">
        {isLinked ? (
          <>
            <p className="text-sm text-slate-800">{row.categoryName ?? row.categoryKey}</p>
            {row.categoryPath.length > 0 ? (
              <p className="mt-0.5 text-[11px] text-slate-400">{row.categoryPath.join(' › ')}</p>
            ) : null}
          </>
        ) : (
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
            Unlinked
          </span>
        )}
      </td>
      <td className="py-3 pr-4">
        {isLinked ? (
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              SOURCE_BADGE[row.source] ?? 'bg-slate-100 text-slate-600'
            }`}
          >
            {row.source}
          </span>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        )}
      </td>
      <td className="py-3 pr-4 text-sm tabular-nums text-slate-600">
        {isLinked ? `${(row.confidence * 100).toFixed(0)}%` : '—'}
      </td>
      <td className="py-3">
        <div className="flex flex-col gap-2">
          <form action={reassign} className="flex items-center gap-1.5">
            <input type="hidden" name="prodLineKey" value={row.prodLineKey} />
            <input type="hidden" name="prodLineId" value={row.prodLineId ?? ''} />
            <input type="hidden" name="fromCategoryKey" value={row.categoryKey} />
            <select
              name="toCategoryKey"
              defaultValue=""
              className="h-8 max-w-[220px] rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
            >
              <option value="" disabled>
                {isLinked ? 'Reassign to…' : 'Assign to…'}
              </option>
              <CategoryOptions options={options} />
            </select>
            <button
              type="submit"
              disabled={reassigning}
              className="h-8 rounded-lg bg-slate-900 px-2.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {reassigning ? '…' : 'Go'}
            </button>
          </form>
          <div className="flex items-center gap-2">
            {isClassifier ? (
              <form action={approve}>
                <input type="hidden" name="categoryKey" value={row.categoryKey} />
                <input type="hidden" name="prodLineKey" value={row.prodLineKey} />
                <button
                  type="submit"
                  disabled={approving}
                  className="h-8 rounded-lg bg-emerald-600 px-2.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {approving ? '…' : 'Approve'}
                </button>
              </form>
            ) : null}
            {isLinked ? (
              <form action={remove}>
                <input type="hidden" name="categoryKey" value={row.categoryKey} />
                <input type="hidden" name="prodLineKey" value={row.prodLineKey} />
                <button
                  type="submit"
                  disabled={removing}
                  className="h-8 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  {removing ? '…' : 'Delete'}
                </button>
              </form>
            ) : null}
          </div>
          {rowError ? <p className="text-xs text-rose-600">{rowError}</p> : null}
        </div>
      </td>
    </tr>
  );
}

export function CategoryCurationTable({
  rows,
  options,
  filter,
  page,
  pageSize,
  total,
}: {
  rows: CurationLinkRow[];
  options: CurationTaxonomyOption[];
  filter: CurationFilter;
  page: number;
  pageSize: number;
  total: number;
}) {
  const [selectedTarget, setSelectedTarget] = useState('');
  const [bulkState, bulkReassign, bulkPending] = useActionState<BulkReassignState, FormData>(
    bulkReassignCategoryLinksAction,
    null,
  );

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hrefFor = (nextFilter: CurationFilter, nextPage: number) =>
    `/admin/products/categories?filter=${nextFilter}&page=${nextPage}`;

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex flex-wrap gap-2">
        {FILTER_TABS.map((tab) => (
          <Link
            key={tab.key}
            href={hrefFor(tab.key, 1)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
              tab.key === filter
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <form
        id="bulk-reassign-form"
        action={bulkReassign}
        className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-3"
      >
        <span className="text-sm text-slate-600">Bulk reassign selected to</span>
        <select
          name="toCategoryKey"
          value={selectedTarget}
          onChange={(e) => setSelectedTarget(e.target.value)}
          className="h-9 max-w-[260px] rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          <option value="" disabled>
            Choose a category…
          </option>
          <CategoryOptions options={options} />
        </select>
        <button
          type="submit"
          disabled={bulkPending || !selectedTarget}
          className="h-9 rounded-lg bg-slate-900 px-3.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {bulkPending ? 'Reassigning…' : 'Apply to selected'}
        </button>
        {bulkState?.ok ? (
          <span className="text-sm text-emerald-600">Reassigned {bulkState.count} link(s).</span>
        ) : null}
        {bulkState && !bulkState.ok ? <span className="text-sm text-rose-600">{bulkState.error}</span> : null}
      </form>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full min-w-[860px] border-collapse">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-2.5 pl-3 pr-3 font-medium">Sel</th>
              <th className="py-2.5 pr-4 font-medium">Product line</th>
              <th className="py-2.5 pr-4 font-medium">Category</th>
              <th className="py-2.5 pr-4 font-medium">Source</th>
              <th className="py-2.5 pr-4 font-medium">Confidence</th>
              <th className="py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-sm text-slate-500">
                  No rows for this filter.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <CurationRow key={`${row.prodLineKey}-${row.categoryKey}`} row={row} options={options} />
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>
          {total.toLocaleString()} row{total === 1 ? '' : 's'} · page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          {page > 1 ? (
            <Link href={hrefFor(filter, page - 1)} className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
              Previous
            </Link>
          ) : null}
          {page < totalPages ? (
            <Link href={hrefFor(filter, page + 1)} className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
              Next
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
