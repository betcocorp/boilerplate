'use client';

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';

type TimingItem = {
  label: string;
  value: string;
  /** Optional raw ms for this stat — enables the proportional bar. Omit for non-ms stats. */
  ms?: number;
};

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
  /** B0-621 — total search time in ms, used as the denominator for each stat's proportional bar. */
  totalMs?: number;
  timings: TimingItem[];
};

export function RagSearchTimingPanel({
  embeddingSourceLabel,
  retrievalStrategy,
  cohereConfigured,
  totalMs,
  timings,
}: RagSearchTimingPanelProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <section className="rounded-3xl border border-border/60 bg-background p-6 shadow-sm">
      <Button
        className="flex h-auto w-full items-center justify-between gap-3 p-0 font-normal hover:bg-transparent"
        onClick={() => setIsOpen((current) => !current)}
        type="button"
        variant="ghost"
      >
        <span className="text-sm font-medium text-foreground">
          {isOpen ? 'Hide timing' : 'Timing'}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!isOpen && timings[0] ? (
            <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              {timings[0].value}
            </span>
          ) : null}
          <Badge variant="secondary">{embeddingSourceLabel}</Badge>
          {retrievalStrategy ? <Badge variant="outline">{retrievalStrategy}</Badge> : null}
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
            className={`rounded-full border border-border/60 p-2 text-muted-foreground transition-transform duration-200 ${
              isOpen ? 'rotate-180' : ''
            }`}
          >
            <ChevronDown className="size-4" />
          </span>
        </div>
      </Button>

      <div
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
          isOpen ? 'mt-6 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {timings.map((item) => {
              const pct =
                typeof item.ms === 'number' && totalMs && totalMs > 0
                  ? Math.min(100, Math.max(0, (item.ms / totalMs) * 100))
                  : null;

              return (
                <div className="rounded-2xl bg-muted/50 p-4" key={item.label}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-muted-foreground">{item.label}</p>
                    <span className="inline-flex items-center rounded-full bg-background px-2 py-0.5 text-xs font-semibold text-foreground ring-1 ring-border/60">
                      {item.value}
                    </span>
                  </div>
                  {pct !== null ? (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
