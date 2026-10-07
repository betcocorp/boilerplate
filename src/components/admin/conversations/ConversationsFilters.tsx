'use client';

/**
 * B0-533 — collapsible GET filter bar for `/admin/bex/conversations`. Same shape as
 * `RunsFilters.tsx`: a plain form submit so every filter is in the URL, with only the
 * show/hide affordance needing client state.
 */

import { ChevronDownIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { FormSelectField } from '~/components/admin/FormSelectField';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';

import type { ConversationsTableFilters } from './ConversationsTable';

const SOURCE_OPTIONS = [
  { value: 'chat', label: 'Bex chat' },
  { value: 'test_run', label: 'Test harness' },
  { value: 'all', label: 'All sources' },
] as const;

export function ConversationsFilters({
  route,
  filters,
}: {
  route: string;
  filters: ConversationsTableFilters;
}) {
  const [showFilters, setShowFilters] = useState(false);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white px-8 py-4 shadow-sm">
      <button
        aria-expanded={showFilters}
        className="inline-flex w-full items-center justify-between gap-1.5 rounded-full py-1.5 text-xs font-medium text-slate-600"
        onClick={() => setShowFilters((open) => !open)}
        type="button"
      >
        <h2 className="text-lg font-semibold text-slate-900">Filters</h2>
        <ChevronDownIcon
          aria-hidden
          className={`size-4 shrink-0 transition-transform duration-300 ${showFilters ? 'rotate-180' : ''}`}
        />
      </button>

      {showFilters ? (
        <>
          <form
            action={route}
            className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
            method="get"
          >
            <div className="flex min-w-0 flex-col gap-2 sm:col-span-2 lg:col-span-4">
              <Label className="text-sm text-slate-700" htmlFor="conversations-search">
                Search
              </Label>
              <Input
                defaultValue={filters.search}
                id="conversations-search"
                name="q"
                placeholder="Words from the title or any user message"
                type="search"
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label className="text-sm text-slate-700" htmlFor="conversations-from">
                Started from (EST)
              </Label>
              <Input defaultValue={filters.from} id="conversations-from" name="from" type="date" />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label className="text-sm text-slate-700" htmlFor="conversations-to">
                Started to (EST)
              </Label>
              <Input defaultValue={filters.to} id="conversations-to" name="to" type="date" />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label className="text-sm text-slate-700" htmlFor="conversations-source">
                Source
              </Label>
              <FormSelectField
                defaultValue={filters.source}
                id="conversations-source"
                name="source"
                options={SOURCE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label className="text-sm text-slate-700" htmlFor="conversations-user">
                Owner (email or user ID)
              </Label>
              <Input
                defaultValue={filters.user}
                id="conversations-user"
                name="user"
                placeholder="name@betco.com"
                type="text"
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label className="text-sm text-slate-700" htmlFor="conversations-min-turns">
                Minimum turns
              </Label>
              <Input
                defaultValue={filters.minTurns}
                id="conversations-min-turns"
                min="1"
                name="minTurns"
                placeholder="any"
                step="1"
                type="number"
              />
            </div>

            <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
              <Button type="submit">Apply filters</Button>
              <Button asChild type="button" variant="outline">
                <Link href={route}>Reset</Link>
              </Button>
            </div>
          </form>
          <p className="mt-4 text-xs text-slate-500">
            Defaults to Bex chat conversations started in the last 7 days. Search matches the
            conversation title or any user message in the window. &ldquo;Owner&rdquo; matches the
            conversation&apos;s owner or the admin who typed it while acting as them. &ldquo;Minimum
            turns&rdquo; counts user messages.
          </p>
        </>
      ) : null}
    </section>
  );
}
