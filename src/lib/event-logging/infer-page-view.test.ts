import { describe, expect, it } from 'vitest';

import { inferPageViewFromPath } from '~/lib/event-logging/infer-page-view';

function eventFor(path: string): string | undefined {
  return inferPageViewFromPath(path)?.event;
}

function metaFor(path: string): Record<string, string> | undefined {
  return inferPageViewFromPath(path)?.meta;
}

describe('inferPageViewFromPath — normalization', () => {
  it('maps the root path to the login page view', () => {
    expect(inferPageViewFromPath('/')).toEqual({
      event: 'analytics.page.view.login',
      meta: { path: '/' },
    });
  });

  it('strips a query string', () => {
    expect(inferPageViewFromPath('/admin/tests?status=active')).toEqual({
      event: 'analytics.page.view.tests',
      meta: { path: '/admin/tests' },
    });
  });

  it('strips trailing slashes', () => {
    expect(eventFor('/admin/bex/')).toBe('analytics.page.view.bex.chat');
    expect(metaFor('/admin/bex///')).toEqual({ path: '/admin/bex' });
  });

  it('always carries the normalized path in meta', () => {
    expect(metaFor('/admin/observability')?.path).toBe('/admin/observability');
  });
});

describe('inferPageViewFromPath — admin shell and Bex', () => {
  it.each([
    ['/admin', 'analytics.page.view.admin'],
    ['/admin/bex', 'analytics.page.view.bex.chat'],
    ['/admin/bex/health', 'analytics.page.view.bex.health'],
    ['/admin/bex/compare', 'analytics.page.view.bex.compare'],
    ['/admin/analytics', 'analytics.page.view.admin.analytics'],
  ])('maps %s to %s', (path, event) => {
    expect(eventFor(path)).toBe(event);
  });
});

describe('inferPageViewFromPath — eval harness', () => {
  it.each([
    ['/admin/tests', 'analytics.page.view.tests'],
    ['/admin/tests/archived', 'analytics.page.view.tests.archived'],
    ['/admin/tests/failure-queue', 'analytics.page.view.tests.failure_queue'],
    ['/admin/tests/reports', 'analytics.page.view.tests.reports'],
    ['/admin/tests/routing-comparison', 'analytics.page.view.tests.routing_comparison'],
  ])('maps the static route %s to %s', (path, event) => {
    expect(eventFor(path)).toBe(event);
  });

  it('maps a test detail route and carries testId', () => {
    expect(inferPageViewFromPath('/admin/tests/a52cf433')).toEqual({
      event: 'analytics.page.view.test.detail',
      meta: { path: '/admin/tests/a52cf433', testId: 'a52cf433' },
    });
  });

  it('maps a run route and carries testId + runId', () => {
    expect(inferPageViewFromPath('/admin/tests/t-1/runs/r-2')).toEqual({
      event: 'analytics.page.view.test.run',
      meta: { path: '/admin/tests/t-1/runs/r-2', testId: 't-1', runId: 'r-2' },
    });
  });

  it('maps a run report route ahead of the run route', () => {
    expect(inferPageViewFromPath('/admin/tests/t-1/runs/r-2/report')).toEqual({
      event: 'analytics.page.view.test.run.report',
      meta: {
        path: '/admin/tests/t-1/runs/r-2/report',
        testId: 't-1',
        runId: 'r-2',
      },
    });
  });

  it('maps an item route and carries testId + itemId', () => {
    expect(inferPageViewFromPath('/admin/tests/t-1/items/i-3')).toEqual({
      event: 'analytics.page.view.test.item',
      meta: { path: '/admin/tests/t-1/items/i-3', testId: 't-1', itemId: 'i-3' },
    });
  });

  it('maps a search-run route and carries testId + runId', () => {
    expect(inferPageViewFromPath('/admin/tests/t-1/search-runs/r-9')).toEqual({
      event: 'analytics.page.view.test.search_run',
      meta: { path: '/admin/tests/t-1/search-runs/r-9', testId: 't-1', runId: 'r-9' },
    });
  });
});

describe('inferPageViewFromPath — observability', () => {
  it('maps the list route', () => {
    expect(eventFor('/admin/observability')).toBe('analytics.page.view.observability');
  });

  it('maps a run route and carries runId', () => {
    expect(inferPageViewFromPath('/admin/observability/run-77')).toEqual({
      event: 'analytics.page.view.observability.run',
      meta: { path: '/admin/observability/run-77', runId: 'run-77' },
    });
  });
});

describe('inferPageViewFromPath — products', () => {
  it.each([
    ['/admin/products/rag', 'analytics.page.view.products.rag'],
    ['/admin/products/rag/generate', 'analytics.page.view.products.rag.generate'],
    ['/admin/products/rag/chunking', 'analytics.page.view.products.rag.chunking'],
    ['/admin/products/legacy', 'analytics.page.view.products.legacy'],
    ['/admin/products/orphans', 'analytics.page.view.products.orphans'],
    ['/admin/products/categories', 'analytics.page.view.products.categories'],
  ])('maps the static route %s to %s', (path, event) => {
    expect(eventFor(path)).toBe(event);
  });

  it('maps a RAG document route and carries documentId', () => {
    expect(inferPageViewFromPath('/admin/products/rag/documents/doc-1')).toEqual({
      event: 'analytics.page.view.products.rag.document',
      meta: { path: '/admin/products/rag/documents/doc-1', documentId: 'doc-1' },
    });
  });

  it('maps a RAG product route (dynamic slug loses to the static siblings)', () => {
    expect(inferPageViewFromPath('/admin/products/rag/PH7Q')).toEqual({
      event: 'analytics.page.view.products.rag.product',
      meta: { path: '/admin/products/rag/PH7Q', productKey: 'PH7Q' },
    });
  });

  it('maps a legacy product route and carries productKey', () => {
    expect(inferPageViewFromPath('/admin/products/legacy/1234')).toEqual({
      event: 'analytics.page.view.products.legacy.product',
      meta: { path: '/admin/products/legacy/1234', productKey: '1234' },
    });
  });

  it('maps a legacy product-line route ahead of the product route', () => {
    expect(inferPageViewFromPath('/admin/products/legacy/line/pH7Q')).toEqual({
      event: 'analytics.page.view.products.legacy.line',
      meta: { path: '/admin/products/legacy/line/pH7Q', productLine: 'pH7Q' },
    });
  });

  it('maps an orphan type route and carries dataType', () => {
    expect(inferPageViewFromPath('/admin/products/orphans/sds')).toEqual({
      event: 'analytics.page.view.products.orphans.type',
      meta: { path: '/admin/products/orphans/sds', dataType: 'sds' },
    });
  });
});

describe('inferPageViewFromPath — tools and single-page sections', () => {
  it.each([
    ['/admin/tools', 'analytics.page.view.tools'],
    ['/admin/tools/cross-reference', 'analytics.page.view.tools.cross_reference'],
    ['/admin/tools/web-search', 'analytics.page.view.tools.web_search'],
    ['/admin/sds', 'analytics.page.view.sds'],
    ['/admin/efficacy', 'analytics.page.view.efficacy'],
    ['/admin/knowledge', 'analytics.page.view.knowledge'],
    ['/admin/labels', 'analytics.page.view.labels'],
    ['/admin/settings', 'analytics.page.view.admin.settings'],
    ['/admin/cost', 'analytics.page.view.admin.cost'],
    ['/admin/changelog', 'analytics.page.view.admin.changelog'],
  ])('maps %s to %s', (path, event) => {
    expect(eventFor(path)).toBe(event);
  });
});

describe('inferPageViewFromPath — routing test', () => {
  it('maps the routing test landing page', () => {
    expect(eventFor('/admin/routing-test')).toBe('analytics.page.view.routing_test');
  });

  it('maps a routing test run and carries runId', () => {
    expect(inferPageViewFromPath('/admin/routing-test/runs/rt-5')).toEqual({
      event: 'analytics.page.view.routing_test.run',
      meta: { path: '/admin/routing-test/runs/rt-5', runId: 'rt-5' },
    });
  });
});

describe('inferPageViewFromPath — permissions admin', () => {
  it('maps the permissions landing page', () => {
    expect(eventFor('/admin/permissions')).toBe(
      'analytics.page.view.admin.permissions',
    );
  });

  it.each([
    ['users', 'analytics.page.view.admin.permissions.user', 'userId'],
    ['groups', 'analytics.page.view.admin.permissions.group', 'groupId'],
    ['permissions', 'analytics.page.view.admin.permissions.permission', 'permissionId'],
  ])('maps /admin/permissions/%s/{id} to %s', (segment, event, idKey) => {
    const path = `/admin/permissions/${segment}/id-1`;
    expect(inferPageViewFromPath(path)).toEqual({
      event,
      meta: { path, [idKey]: 'id-1' },
    });
  });

  it('keeps every permissions event under the queryable admin.permissions prefix', () => {
    for (const path of [
      '/admin/permissions',
      '/admin/permissions/users/u-1',
      '/admin/permissions/groups/g-1',
      '/admin/permissions/permissions/p-1',
    ]) {
      expect(eventFor(path)).toMatch(/^analytics\.page\.view\.admin\.permissions/);
    }
  });
});

describe('inferPageViewFromPath — API projects', () => {
  it.each([
    ['/admin/projects', 'analytics.page.view.admin.projects'],
    ['/admin/projects/analytics', 'analytics.page.view.admin.projects.analytics'],
  ])('maps the static route %s to %s', (path, event) => {
    expect(eventFor(path)).toBe(event);
  });

  it('maps a project detail route and carries projectId', () => {
    expect(inferPageViewFromPath('/admin/projects/proj-1')).toEqual({
      event: 'analytics.page.view.admin.project.detail',
      meta: { path: '/admin/projects/proj-1', projectId: 'proj-1' },
    });
  });

  it('maps a project app route and carries projectId + appId', () => {
    expect(inferPageViewFromPath('/admin/projects/proj-1/apps/app-2')).toEqual({
      event: 'analytics.page.view.admin.project.app',
      meta: {
        path: '/admin/projects/proj-1/apps/app-2',
        projectId: 'proj-1',
        appId: 'app-2',
      },
    });
  });
});

describe('inferPageViewFromPath — unmapped fallback', () => {
  it('falls back for an unknown non-admin route', () => {
    expect(inferPageViewFromPath('/some/other/place')).toEqual({
      event: 'analytics.page.view.unmapped',
      meta: { path: '/some/other/place', segments: 'some.other.place' },
    });
  });

  it('falls back for an unknown admin route', () => {
    expect(inferPageViewFromPath('/admin/does-not-exist')).toEqual({
      event: 'analytics.page.view.unmapped',
      meta: { path: '/admin/does-not-exist', segments: 'admin.does-not-exist' },
    });
  });

  it('falls back for a deeper path under a mapped section', () => {
    expect(eventFor('/admin/tools/cross-reference/not-a-real-tab')).toBe(
      'analytics.page.view.unmapped',
    );
  });

  // Every one of these is a real page.tsx under src/app/(authenticated)/admin/tools.
  // They were missing from the first pass and silently collapsed into `unmapped`,
  // which would have hidden them from the dashboard's "top pages" panel.
  it.each([
    ['/admin/tools/all-tools', 'analytics.page.view.tools.all_tools'],
    ['/admin/tools/web-endpoints', 'analytics.page.view.tools.web_endpoints'],
    [
      '/admin/tools/product-cross-reference',
      'analytics.page.view.tools.product_cross_reference',
    ],
    [
      '/admin/tools/cross-reference/aliases',
      'analytics.page.view.tools.cross_reference.aliases',
    ],
    [
      '/admin/tools/cross-reference/lookup',
      'analytics.page.view.tools.cross_reference.lookup',
    ],
    [
      '/admin/tools/cross-reference/recommendations',
      'analytics.page.view.tools.cross_reference.recommendations',
    ],
  ])('maps %s to %s', (path, expected) => {
    expect(eventFor(path)).toBe(expected);
  });

  it('returns only string meta values so the jsonb payload stays JSON-safe', () => {
    const inference = inferPageViewFromPath('/admin/tests/t-1/runs/r-2/report');
    expect(inference).not.toBeNull();
    for (const value of Object.values(inference!.meta)) {
      expect(typeof value).toBe('string');
    }
  });
});
