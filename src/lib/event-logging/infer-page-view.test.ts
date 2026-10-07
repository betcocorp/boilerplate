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
    expect(inferPageViewFromPath('/admin/analytics?days=7')).toEqual({
      event: 'analytics.page.view.admin.analytics',
      meta: { path: '/admin/analytics' },
    });
  });

  it('strips trailing slashes', () => {
    expect(eventFor('/admin/analytics/')).toBe('analytics.page.view.admin.analytics');
    expect(metaFor('/admin/analytics///')).toEqual({ path: '/admin/analytics' });
  });
});

describe('inferPageViewFromPath — admin shell', () => {
  it.each([
    ['/admin', 'analytics.page.view.admin'],
    ['/admin/analytics', 'analytics.page.view.admin.analytics'],
  ])('maps %s to %s', (path, event) => {
    expect(eventFor(path)).toBe(event);
  });
});

describe('inferPageViewFromPath — permissions admin', () => {
  it('maps the permissions landing page', () => {
    expect(eventFor('/admin/permissions')).toBe('analytics.page.view.admin.permissions');
  });

  it.each([
    ['users', 'analytics.page.view.admin.permissions.user', 'userId'],
    ['groups', 'analytics.page.view.admin.permissions.group', 'groupId'],
    ['permissions', 'analytics.page.view.admin.permissions.permission', 'permissionId'],
  ])('maps /admin/permissions/%s/{id} to %s', (segment, event, idKey) => {
    const path = `/admin/permissions/${segment}/id-1`;
    expect(eventFor(path)).toBe(event);
    expect(metaFor(path)).toEqual({ path, [idKey]: 'id-1' });
  });
});

describe('inferPageViewFromPath — unmapped fallback', () => {
  it('lands unknown admin routes under unmapped with dotted segments', () => {
    expect(inferPageViewFromPath('/admin/reports/monthly')).toEqual({
      event: 'analytics.page.view.unmapped',
      meta: { path: '/admin/reports/monthly', segments: 'admin.reports.monthly' },
    });
  });

  it('lands non-admin routes under unmapped', () => {
    expect(eventFor('/somewhere')).toBe('analytics.page.view.unmapped');
  });
});
