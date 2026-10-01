'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';

import { PromptCategorySelect } from './PromptCategorySelect';

type FailureRow = {
  id: string;
  test_id: string;
  test_name: string | null;
  test_item_id: string | null;
  test_result_id: string | null;
  prompt: string | null;
  error_message: string | null;
  prompt_category: string | null;
};

type CategorySection = {
  slug: string;
  label: string;
  color: string;
  rows: FailureRow[];
};

export type GroupSection = {
  group: string;
  label: string;
  color: string;
  total: number;
  categories: CategorySection[];
};

type Props = {
  groupedSections: GroupSection[];
};

export function FailureGroupedView({ groupedSections }: Props) {
  const allSlugs = groupedSections.flatMap((g) => g.categories.map((c) => c.slug));
  const [openSlugs, setOpenSlugs] = useState<Set<string>>(new Set(allSlugs));

  const allOpen = openSlugs.size === allSlugs.length;
  const noneOpen = openSlugs.size === 0;

  function toggleAll() {
    setOpenSlugs(allOpen ? new Set() : new Set(allSlugs));
  }

  function toggle(slug: string) {
    setOpenSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  if (groupedSections.length === 0) {
    return <p className="text-sm text-slate-500">No failed prompts match this search.</p>;
  }

  return (
    <div className="space-y-8">
      {/* Collapse / Expand all */}
      <div className="flex items-center justify-end gap-3">
        <span className="text-xs text-slate-400">
          {openSlugs.size} of {allSlugs.length} expanded
        </span>
        <button
          onClick={toggleAll}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
        >
          {allOpen ? 'Collapse all' : noneOpen ? 'Expand all' : 'Expand all'}
        </button>
      </div>

      {groupedSections.map((g) => (
        <div key={g.group}>
          {/* Group header */}
          <div className="mb-3 flex items-center gap-2">
            <span className={`size-2 shrink-0 rounded-full ${g.color}`} />
            <span className="text-sm font-semibold text-slate-700">{g.label}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
              {g.total}
            </span>
            <button
              onClick={() => {
                const slugsInGroup = g.categories.map((c) => c.slug);
                const allGroupOpen = slugsInGroup.every((s) => openSlugs.has(s));
                setOpenSlugs((prev) => {
                  const next = new Set(prev);
                  if (allGroupOpen) slugsInGroup.forEach((s) => next.delete(s));
                  else slugsInGroup.forEach((s) => next.add(s));
                  return next;
                });
              }}
              className="ml-1 text-[10px] text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
            >
              {g.categories.every((c) => openSlugs.has(c.slug)) ? 'collapse' : 'expand'}
            </button>
          </div>

          {/* Category sections */}
          <div className="space-y-2 pl-4">
            {g.categories.map((cat) => {
              const isOpen = openSlugs.has(cat.slug);
              return (
                <div key={cat.slug} className="overflow-hidden rounded-2xl border border-slate-100">
                  <button
                    onClick={() => toggle(cat.slug)}
                    className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 hover:bg-slate-50"
                  >
                    <ChevronDown
                      className={`size-3.5 shrink-0 text-slate-400 transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
                    />
                    <span className={`size-1.5 shrink-0 rounded-full ${cat.color}`} />
                    <span className="flex-1 text-left text-sm font-medium text-slate-800">
                      {cat.label}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-slate-500">
                      {cat.rows.length}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-slate-100">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-100 bg-slate-50/60 text-xs font-medium text-slate-500">
                            <th className="px-4 py-2 text-left font-medium">Test</th>
                            <th className="px-4 py-2 text-left font-medium">Prompt</th>
                            <th className="px-4 py-2 text-left font-medium">Error</th>
                            <th className="px-4 py-2 text-right font-medium">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {cat.rows.map((row) => (
                            <tr key={row.id} className="hover:bg-slate-50/50">
                              <td className="w-40 px-4 py-3 align-top">
                                <Link
                                  className="line-clamp-2 text-xs font-medium text-sky-700 underline-offset-2 hover:underline"
                                  href={`/admin/tests/${row.test_id}`}
                                >
                                  {row.test_name}
                                </Link>
                              </td>
                              <td className="max-w-sm px-4 py-3 align-top">
                                <div className="flex flex-col gap-1.5">
                                  <span className="line-clamp-2 text-xs text-slate-800">
                                    {row.prompt}
                                  </span>
                                  <PromptCategorySelect
                                    currentCategory={row.prompt_category ?? null}
                                    testItemId={row.test_item_id ?? ''}
                                  />
                                </div>
                              </td>
                              <td className="max-w-xs px-4 py-3 align-top">
                                <span className="line-clamp-2 text-xs text-slate-500">
                                  {row.error_message || '—'}
                                </span>
                              </td>
                              <td className="px-4 py-3 align-top text-right">
                                <div className="flex flex-col items-end gap-1">
                                  <Link
                                    className="text-xs text-sky-700 underline-offset-2 hover:underline"
                                    href={`/admin/tests/${row.test_id}/items/${row.test_item_id}`}
                                  >
                                    Item history
                                  </Link>
                                  <Link
                                    className="text-xs text-sky-700 underline-offset-2 hover:underline"
                                    href={`/admin/tests/${row.test_id}/runs/${row.test_result_id}`}
                                  >
                                    Run
                                  </Link>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
