'use client';

import { useRef } from 'react';

export function CollapseExpandAll({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);

  function setAll(open: boolean) {
    containerRef.current?.querySelectorAll('details').forEach((d) => {
      d.open = open;
    });
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => setAll(true)}
          className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
        >
          Expand all
        </button>
        <span className="text-slate-200" aria-hidden>|</span>
        <button
          type="button"
          onClick={() => setAll(false)}
          className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
        >
          Collapse all
        </button>
      </div>
      <div ref={containerRef}>{children}</div>
    </div>
  );
}
