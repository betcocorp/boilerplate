/**
 * Maps bex admin (and login) routes to stable analytics event names + meta.
 * Meta values are strings only for JSON safety in `event_logging`.
 *
 * All page views live under the `analytics.page.view.*` namespace — split them from
 * other events in SQL with `event LIKE 'analytics.page.view%'`.
 *
 * Detail-page events double as the "record open" marker for funnels; there is no
 * separate `record.open` event. Each detail route carries its id(s) in meta
 * (`testId`, `runId`, `itemId`, `productKey`, `documentId`, …). Fired client-side,
 * they also carry `sessionId` for per-session funnels.
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

  // ---- Bex chat -----------------------------------------------------------
  if (section === 'bex') {
    if (parts.length === 2) {
      return { event: 'analytics.page.view.bex.chat', meta: baseMeta(path) };
    }
    if (parts.length === 3 && parts[2] === 'health') {
      return { event: 'analytics.page.view.bex.health', meta: baseMeta(path) };
    }
    if (parts.length === 3 && parts[2] === 'compare') {
      return { event: 'analytics.page.view.bex.compare', meta: baseMeta(path) };
    }
  }

  // ---- Analytics dashboard ------------------------------------------------
  if (section === 'analytics' && parts.length === 2) {
    return { event: 'analytics.page.view.admin.analytics', meta: baseMeta(path) };
  }

  // ---- Eval harness (tests) ----------------------------------------------
  if (section === 'tests') {
    if (parts.length === 2) {
      return { event: 'analytics.page.view.tests', meta: baseMeta(path) };
    }
    if (parts.length === 3) {
      if (parts[2] === 'archived') {
        return { event: 'analytics.page.view.tests.archived', meta: baseMeta(path) };
      }
      if (parts[2] === 'failure-queue') {
        return {
          event: 'analytics.page.view.tests.failure_queue',
          meta: baseMeta(path),
        };
      }
      if (parts[2] === 'reports') {
        return { event: 'analytics.page.view.tests.reports', meta: baseMeta(path) };
      }
      if (parts[2] === 'routing-comparison') {
        return {
          event: 'analytics.page.view.tests.routing_comparison',
          meta: baseMeta(path),
        };
      }
      return {
        event: 'analytics.page.view.test.detail',
        meta: { ...baseMeta(path), testId: parts[2] },
      };
    }
    if (parts.length === 6 && parts[3] === 'runs' && parts[5] === 'report') {
      return {
        event: 'analytics.page.view.test.run.report',
        meta: { ...baseMeta(path), testId: parts[2], runId: parts[4] },
      };
    }
    if (parts.length === 5 && parts[3] === 'runs') {
      return {
        event: 'analytics.page.view.test.run',
        meta: { ...baseMeta(path), testId: parts[2], runId: parts[4] },
      };
    }
    if (parts.length === 5 && parts[3] === 'items') {
      return {
        event: 'analytics.page.view.test.item',
        meta: { ...baseMeta(path), testId: parts[2], itemId: parts[4] },
      };
    }
    if (parts.length === 5 && parts[3] === 'search-runs') {
      return {
        event: 'analytics.page.view.test.search_run',
        meta: { ...baseMeta(path), testId: parts[2], runId: parts[4] },
      };
    }
  }

  // ---- Observability ------------------------------------------------------
  if (section === 'observability') {
    if (parts.length === 2) {
      return { event: 'analytics.page.view.observability', meta: baseMeta(path) };
    }
    if (parts.length === 3) {
      return {
        event: 'analytics.page.view.observability.run',
        meta: { ...baseMeta(path), runId: parts[2] },
      };
    }
  }

  // ---- Products (RAG / legacy / orphans / categories) ----------------------
  if (section === 'products') {
    const area = parts[2];

    if (area === 'rag') {
      if (parts.length === 3) {
        return { event: 'analytics.page.view.products.rag', meta: baseMeta(path) };
      }
      if (parts.length === 5 && parts[3] === 'documents') {
        return {
          event: 'analytics.page.view.products.rag.document',
          meta: { ...baseMeta(path), documentId: parts[4] },
        };
      }
      if (parts.length === 4) {
        if (parts[3] === 'generate') {
          return {
            event: 'analytics.page.view.products.rag.generate',
            meta: baseMeta(path),
          };
        }
        if (parts[3] === 'chunking') {
          return {
            event: 'analytics.page.view.products.rag.chunking',
            meta: baseMeta(path),
          };
        }
        return {
          event: 'analytics.page.view.products.rag.product',
          meta: { ...baseMeta(path), productKey: parts[3] },
        };
      }
    }

    if (area === 'legacy') {
      if (parts.length === 3) {
        return { event: 'analytics.page.view.products.legacy', meta: baseMeta(path) };
      }
      if (parts.length === 5 && parts[3] === 'line') {
        return {
          event: 'analytics.page.view.products.legacy.line',
          meta: { ...baseMeta(path), productLine: parts[4] },
        };
      }
      if (parts.length === 4) {
        return {
          event: 'analytics.page.view.products.legacy.product',
          meta: { ...baseMeta(path), productKey: parts[3] },
        };
      }
    }

    if (area === 'orphans') {
      if (parts.length === 3) {
        return { event: 'analytics.page.view.products.orphans', meta: baseMeta(path) };
      }
      if (parts.length === 4) {
        return {
          event: 'analytics.page.view.products.orphans.type',
          meta: { ...baseMeta(path), dataType: parts[3] },
        };
      }
    }

    if (area === 'categories' && parts.length === 3) {
      return { event: 'analytics.page.view.products.categories', meta: baseMeta(path) };
    }
  }

  // ---- Tools --------------------------------------------------------------
  if (section === 'tools') {
    if (parts.length === 2) {
      return { event: 'analytics.page.view.tools', meta: baseMeta(path) };
    }
    if (parts.length === 3 && parts[2] === 'cross-reference') {
      return {
        event: 'analytics.page.view.tools.cross_reference',
        meta: baseMeta(path),
      };
    }
    if (parts.length === 3 && parts[2] === 'web-search') {
      return { event: 'analytics.page.view.tools.web_search', meta: baseMeta(path) };
    }
    if (parts.length === 3 && parts[2] === 'all-tools') {
      return { event: 'analytics.page.view.tools.all_tools', meta: baseMeta(path) };
    }
    if (parts.length === 3 && parts[2] === 'web-endpoints') {
      return {
        event: 'analytics.page.view.tools.web_endpoints',
        meta: baseMeta(path),
      };
    }
    if (parts.length === 3 && parts[2] === 'product-cross-reference') {
      return {
        event: 'analytics.page.view.tools.product_cross_reference',
        meta: baseMeta(path),
      };
    }
    if (parts.length === 3 && parts[2] === 'aliases') {
      return { event: 'analytics.page.view.tools.aliases', meta: baseMeta(path) };
    }
    if (parts.length === 4 && parts[2] === 'cross-reference') {
      if (parts[3] === 'lookup') {
        return {
          event: 'analytics.page.view.tools.cross_reference.lookup',
          meta: baseMeta(path),
        };
      }
      if (parts[3] === 'recommendations') {
        return {
          event: 'analytics.page.view.tools.cross_reference.recommendations',
          meta: baseMeta(path),
        };
      }
    }
  }

  // ---- Single-page admin sections ----------------------------------------
  if (parts.length === 2) {
    if (section === 'sds') {
      return { event: 'analytics.page.view.sds', meta: baseMeta(path) };
    }
    if (section === 'efficacy') {
      return { event: 'analytics.page.view.efficacy', meta: baseMeta(path) };
    }
    if (section === 'knowledge') {
      return { event: 'analytics.page.view.knowledge', meta: baseMeta(path) };
    }
    if (section === 'labels') {
      return { event: 'analytics.page.view.labels', meta: baseMeta(path) };
    }
    if (section === 'settings') {
      return { event: 'analytics.page.view.admin.settings', meta: baseMeta(path) };
    }
    if (section === 'cost') {
      return { event: 'analytics.page.view.admin.cost', meta: baseMeta(path) };
    }
    if (section === 'changelog') {
      return { event: 'analytics.page.view.admin.changelog', meta: baseMeta(path) };
    }
  }

  // ---- Routing test -------------------------------------------------------
  if (section === 'routing-test') {
    if (parts.length === 2) {
      return { event: 'analytics.page.view.routing_test', meta: baseMeta(path) };
    }
    if (parts.length === 4 && parts[2] === 'runs') {
      return {
        event: 'analytics.page.view.routing_test.run',
        meta: { ...baseMeta(path), runId: parts[3] },
      };
    }
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

  // ---- API projects / apps ------------------------------------------------
  if (section === 'projects') {
    if (parts.length === 2) {
      return { event: 'analytics.page.view.admin.projects', meta: baseMeta(path) };
    }
    if (parts.length === 3 && parts[2] === 'analytics') {
      return {
        event: 'analytics.page.view.admin.projects.analytics',
        meta: baseMeta(path),
      };
    }
    if (parts.length === 3) {
      return {
        event: 'analytics.page.view.admin.project.detail',
        meta: { ...baseMeta(path), projectId: parts[2] },
      };
    }
    if (parts.length === 5 && parts[3] === 'apps') {
      return {
        event: 'analytics.page.view.admin.project.app',
        meta: { ...baseMeta(path), projectId: parts[2], appId: parts[4] },
      };
    }
  }

  return {
    event: 'analytics.page.view.unmapped',
    meta: { ...baseMeta(path), segments: parts.join('.') },
  };
}
