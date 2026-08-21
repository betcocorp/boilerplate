'use client';

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';

type RagSearchTimingPanelProps = {
  embeddingSourceLabel: string;
  /** B0-619 — this search's `retrieval_strategy` ('vector'|'hybrid'|'vector+reranked'|'hybrid+reranked'). */
  retrievalStrategy?: string;
  /**
   * B0-619 — whether `COHERE_API_KEY` is configured server-side, passed down as a presence check
   * only (never the key itself). Disambiguates "reranker toggled off" from "reranker requested but
   * no key configured, silently falling back to unreranked results".
   */
  cohereConfigured?: boolean;
  timings: Array<{
    label: string;
    value: string;
  }>;
};

export function RagSearchTimingPanel({
  embeddingSourceLabel,
  retrievalStrategy,
  cohereConfigured,
  timings,
}: RagSearchTimingPanelProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <Button
        className="flex h-auto w-full items-start justify-between gap-3 p-0 font-normal hover:bg-transparent"
        onClick={() => setIsOpen((current) => !current)}
        type="button"
        variant="ghost"
      >
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-950">
              Search timing
            </h2>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            This shows where time was spent preparing the query and running
            similarity search.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!isOpen && (
            <Badge variant="secondary">Total: {timings[0].value}</Badge>
          )}
          <Badge variant="secondary">{embeddingSourceLabel}</Badge>
          {retrievalStrategy ? (
            <Badge variant="outline">{retrievalStrategy}</Badge>
          ) : null}
          {cohereConfigured !== undefined ? (
            <Badge
              title={
                cohereConfigured
                  ? 'COHERE_API_KEY is configured server-side'
                  : 'COHERE_API_KEY is not configured — a requested reranker silently falls back to unreranked results'
              }
              variant={cohereConfigured ? 'outline' : 'secondary'}
            >
              {cohereConfigured ? 'Cohere key configured' : 'Cohere key not configured'}
            </Badge>
          ) : null}
          <span
            className={`mt-0.5 rounded-full border border-slate-200 p-2 text-slate-500 transition-transform duration-200 ${
              isOpen ? 'rotate-180' : ''
            }`}
          >
            <ChevronDown className="size-4" />
          </span>
        </div>
      </Button>

      <div
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
          isOpen
            ? 'mt-6 grid-rows-[1fr] opacity-100'
            : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {timings.map((item) => (
              <div className="rounded-2xl bg-slate-50 p-4" key={item.label}>
                <p className="text-sm font-medium text-slate-500">
                  {item.label}
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-950">
                  {item.value}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
