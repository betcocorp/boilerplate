'use client';

/**
 * Collapses the Dataset/Run-by/Model filter row on `/admin/tests/reports` behind a toggle button.
 * Hidden by default; the button slides the row out from right to left (via a grid-template-columns
 * 0fr→1fr animation, so it works without knowing the row's content width) while the icon rotates
 * 180deg. Clicking again reverses both animations.
 */

import { ChevronFirst } from 'lucide-react';
import { useState } from 'react';

export function ReportFiltersToggle({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="flex shrink-0 items-center gap-2">
      <div
        className={`grid min-w-0 transition-[grid-template-columns] duration-300 ease-in-out ${
          open ? 'grid-cols-[1fr]' : 'grid-cols-[0fr]'
        }`}
      >
        <div className="min-w-0 overflow-hidden">
          <div
            className={`flex flex-nowrap items-center gap-6 transition-all duration-300 ease-in-out ${
              open ? 'translate-x-0 opacity-100' : 'translate-x-8 opacity-0'
            }`}
          >
            {children}
          </div>
        </div>
      </div>
      <button
        aria-expanded={open}
        aria-label={open ? 'Hide filters' : 'Show filters'}
        className="shrink-0 cursor-pointer rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ChevronFirst
          aria-hidden
          className={`size-4 transition-transform duration-300 ease-in-out ${
            open ? 'rotate-180' : 'rotate-0'
          }`}
        />
      </button>
    </div>
  );
}
