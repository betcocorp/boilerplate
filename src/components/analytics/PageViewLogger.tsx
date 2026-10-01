'use client';

import { useSession } from 'next-auth/react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { inferPageViewFromPath, logEvent } from '~/lib/event-logging';

/**
 * B0-761 — logs a page-view event when the user navigates (keyed on pathname).
 * Mount inside a Suspense boundary (uses useSearchParams).
 *
 * The 600 ms dedupe guards React StrictMode's double effect and rapid re-renders, so one
 * navigation produces one row. `name`/`email` are sent for parity with c360 and to cover the
 * pre-enrichment path; the server overwrites them authoritatively from the session.
 */
export function PageViewLogger() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const { data: session, status } = useSession();
  const dedupeRef = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    if (status === 'loading') return;

    const inferred = inferPageViewFromPath(pathname);
    if (!inferred) return;

    const now = Date.now();
    if (dedupeRef.current?.key === pathname && now - dedupeRef.current.at < 600) {
      return;
    }
    dedupeRef.current = { key: pathname, at: now };

    const name = session?.user?.name;
    const email = session?.user?.email;
    const meta: Record<string, string> = {
      ...inferred.meta,
      ...(name != null && String(name).trim() !== ''
        ? { name: String(name).trim() }
        : {}),
      ...(email != null && String(email).trim() !== ''
        ? { email: String(email).trim() }
        : {}),
    };

    void logEvent(inferred.event, meta);
  }, [pathname, searchKey, status, session?.user?.name, session?.user?.email]);

  return null;
}
