'use client';

import { ChevronDown, Sparkles } from 'lucide-react';
import { useState } from 'react';

import type { AiSuggestionRecord } from '~/lib/ai-suggestions/repository';

const BADGE_COLORS = [
  'bg-sky-100 text-sky-700 ring-sky-200',
  'bg-violet-100 text-violet-700 ring-violet-200',
  'bg-emerald-100 text-emerald-700 ring-emerald-200',
];

type AiSuggestionCardsProps = {
  suggestions: AiSuggestionRecord[];
  generatedAt?: string | null;
};

export function AiSuggestionCards({
  suggestions,
  generatedAt,
}: AiSuggestionCardsProps) {
  const [open, setOpen] = useState(false);

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <section className="mt-8">
      <button
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-sky-600" />
          <h2 className="text-lg font-semibold text-slate-900">
            AI recommendations
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {generatedAt && (
            <p className="text-xs text-slate-400">
              Generated{' '}
              {new Date(generatedAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </p>
          )}
          <ChevronDown
            className={`h-4 w-4 text-slate-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {open && (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {suggestions.map((s, i) => (
            <div
              key={s.id}
              className="flex flex-col gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-5 shadow-sm"
            >
              <div className="flex items-start gap-3">
                <span
                  className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ring-1 ${BADGE_COLORS[i % BADGE_COLORS.length]}`}
                >
                  {s.sort_order}
                </span>
                <p className="font-semibold leading-snug text-slate-900">
                  {s.title}
                </p>
              </div>
              <p className="text-sm leading-relaxed text-slate-600">
                {s.content}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
