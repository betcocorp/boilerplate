/**
 * Maps admin (and login) routes to stable analytics event names + meta.
 * Meta values are strings only for JSON safety in `event_logging`.
 *
 * All page views live under the `analytics.page.view.*` namespace — split them from
 * other events in SQL with `event LIKE 'analytics.page.view%'`.
 *
 * Detail-page events double as the "record open" marker for funnels; there is no
 * separate `record.open` event. Each detail route carries its id(s) in meta
 * (`userId`, `groupId`, …). Fired client-side, they also carry `sessionId` for per-session
 * funnels. Add a mapping here for every page you add under `/admin`.
 *
 * Routes with no explicit mapping fall through to `analytics.page.view.unmapped`
 * with a dotted `segments` value, so new pages still land somewhere queryable.
 */

export type PageViewInference = {
  event: string;
  meta: Record<string, string>;
};

function baseMeta(path: string): Record<string, string> {
  return { path };
}

/**
 * Pathname only (query is stripped). More specific routes are checked before the
 * dynamic-segment catch-alls that would otherwise swallow them.
 */
export function inferPageViewFromPath(pathname: string): PageViewInference | null {
  const raw = pathname.split('?')[0];
  const path = raw.replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean);

  if (path === '/' || parts.length === 0) {
    return { event: 'analytics.page.view.login', meta: baseMeta('/') };
  }

  if (parts[0] !== 'admin') {
    return {
      event: 'analytics.page.view.unmapped',
      meta: { ...baseMeta(path), segments: parts.join('.') },
    };
  }

  if (parts.length === 1) {
    return { event: 'analytics.page.view.admin', meta: baseMeta(path) };
  }

  const section = parts[1];

  // ---- Analytics dashboard ------------------------------------------------
  if (section === 'analytics' && parts.length === 2) {
    return { event: 'analytics.page.view.admin.analytics', meta: baseMeta(path) };
  }

  // ---- Permissions admin --------------------------------------------------
  if (section === 'permissions') {
    if (parts.length === 2) {
      return { event: 'analytics.page.view.admin.permissions', meta: baseMeta(path) };
    }
    if (parts.length === 4 && parts[2] === 'users') {
      return {
        event: 'analytics.page.view.admin.permissions.user',
        meta: { ...baseMeta(path), userId: parts[3] },
      };
    }
    if (parts.length === 4 && parts[2] === 'groups') {
      return {
        event: 'analytics.page.view.admin.permissions.group',
        meta: { ...baseMeta(path), groupId: parts[3] },
      };
    }
    if (parts.length === 4 && parts[2] === 'permissions') {
      return {
        event: 'analytics.page.view.admin.permissions.permission',
        meta: { ...baseMeta(path), permissionId: parts[3] },
      };
    }
  }

  return {
    event: 'analytics.page.view.unmapped',
    meta: { ...baseMeta(path), segments: parts.join('.') },
  };
}
