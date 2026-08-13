'use client';

import type { ReactNode } from 'react';

import { useSidebar } from '~/components/ui/sidebar';

/**
 * Closes the mobile sidebar drawer once an actual nav link is tapped (not when expanding a
 * collapsible group, which is a button). No-op on desktop, where the sidebar stays as the user
 * left it. Keeps the layout a Server Component while owning this one bit of client behavior.
 */
export function AdminNavAutoClose({ children }: { children: ReactNode }) {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    // `contents` so this wrapper adds no box of its own — the sidebar groups stay flush with the
    // rail (important so icons center correctly when collapsed). Click still bubbles here.
    <div
      className="contents"
      onClick={(event) => {
        if (isMobile && (event.target as HTMLElement).closest('a')) {
          setOpenMobile(false);
        }
      }}
    >
      {children}
    </div>
  );
}
