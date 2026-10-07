import { redirect } from 'next/navigation';

import { requirePermission } from '~/lib/permissions/require-permission';

/**
 * B0-839 — Server Component page guard. Must be called as the first statement of a gated page's
 * default export, before any data fetching, and never inside a try/catch: `redirect()` throws
 * `NEXT_REDIRECT` internally, which a surrounding try/catch would swallow.
 *
 * Deliberately not a shared `admin/layout.tsx` check — Next.js Layouts don't re-render on
 * sibling-route client-side navigation (Partial Rendering), so a single layout-level check would
 * go stale when navigating between sibling admin sections. Reuses `requirePermission` as-is
 * (Redis cache, `PERMISSIONS_ENFORCED` shadow-mode semantics, audit logging) rather than
 * duplicating permission-resolution logic.
 */
export async function requirePagePermission(
  selector: string,
  route: string,
): Promise<void> {
  const result = await requirePermission(selector, { route });
  if (!result.allowed) {
    redirect('/admin?accessDenied=1');
  }
}
