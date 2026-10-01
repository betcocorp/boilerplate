import { connection } from 'next/server';

import { ApiUsageCharts } from '~/components/admin/projects/ApiUsageCharts';
import { FormSelectField } from '~/components/admin/FormSelectField';
import { formatInt, formatMs, formatPercent } from '~/components/admin/projects/format';
import { formatLastUsed } from '~/components/admin/projects/ui';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import {
  getApiAnalytics,
  listRequestLog,
  type Rollup,
} from '~/lib/api/analytics-repository';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';

export const metadata = {
  title: 'API Analytics | Betco BEX',
  description: 'Request, cost, and latency analytics for API-security projects and apps.',
};

type PageProps = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

const read = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border/60 p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function RollupTiles({ rollup }: { rollup: Rollup }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatTile label="Requests (24h)" value={formatInt(rollup.requestsToday)} />
      <StatTile label="Requests (7d)" value={formatInt(rollup.requests7d)} />
      <StatTile label="Requests (30d)" value={formatInt(rollup.requests30d)} />
      <StatTile label="Error rate (30d)" value={formatPercent(rollup.errorRate)} />
      <StatTile label="Avg latency (30d)" value={formatMs(rollup.avgLatencyMs)} />
      <StatTile label="LLM tokens (30d)" value={formatInt(rollup.totalTokens)} hint={`last used ${formatLastUsed(rollup.lastUsedAt)}`} />
    </div>
  );
}

export default async function ApiAnalyticsPage({ searchParams }: PageProps) {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_USER_API_ACCESS,
    'GET /admin/projects/analytics',
  );
  await connection();
  const sp = await searchParams;

  const projectId = read(sp.projectId);
  const appId = read(sp.appId);
  const path = read(sp.path);
  const statusRaw = read(sp.status);
  const status = /^\d{3}$/.test(statusRaw) ? Number(statusRaw) : undefined;
  const requestedPage = Number.parseInt(read(sp.page) || '1', 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const [analytics, logs] = await Promise.all([
    getApiAnalytics(30),
    listRequestLog({
      projectId: projectId || undefined,
      appId: appId || undefined,
      path: path || undefined,
      status,
      page,
      pageSize: 25,
    }),
  ]);

  const projectName = new Map(analytics.projects.map((p) => [p.id, p.name]));
  const appName = new Map(analytics.projects.flatMap((p) => p.apps.map((a) => [a.id, a.name] as const)));
  const totalPages = Math.max(1, Math.ceil(logs.total / logs.pageSize));

  return (
    <main className="min-w-0 space-y-6 p-4 sm:p-6">
      <div>
        <p className="text-sm text-muted-foreground">API Security</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Rollups over the last {analytics.windowDays} days from the request log. Generated{' '}
          {new Date(analytics.generatedAt).toLocaleString()}.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Overall</h2>
        <RollupTiles rollup={analytics.overall} />
      </section>

      <ApiUsageCharts daily={analytics.daily} />

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">By project → app</h2>
        {analytics.projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No request activity yet.</p>
        ) : (
          analytics.projects.map((project) => (
            <Card key={project.id} className="rounded-3xl border border-border/60 shadow-none">
              <CardHeader>
                <CardTitle className="text-base">
                  {project.name}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {formatInt(project.rollup.requests30d)} req / {formatInt(project.rollup.totalTokens)} tokens (30d)
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {project.apps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No apps.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-border/60 hover:bg-transparent">
                          <TableHead>App</TableHead>
                          <TableHead>Req 30d</TableHead>
                          <TableHead>Error rate</TableHead>
                          <TableHead>Avg latency</TableHead>
                          <TableHead>p50 / p95 / p99</TableHead>
                          <TableHead>Tokens 30d</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Last used</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {project.apps.map((app) => (
                          <TableRow key={app.id} className="border-border/60">
                            <TableCell className="font-medium">{app.name}</TableCell>
                            <TableCell className="tabular-nums">{formatInt(app.rollup.requests30d)}</TableCell>
                            <TableCell className="tabular-nums">{formatPercent(app.rollup.errorRate)}</TableCell>
                            <TableCell className="tabular-nums">{formatMs(app.rollup.avgLatencyMs)}</TableCell>
                            <TableCell className="tabular-nums text-xs">
                              {app.latency
                                ? `${formatMs(app.latency.p50)} / ${formatMs(app.latency.p95)} / ${formatMs(app.latency.p99)}`
                                : '—'}
                            </TableCell>
                            <TableCell className="tabular-nums">{formatInt(app.rollup.totalTokens)}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {app.status.length > 0
                                ? app.status.map((s) => `${s.bucket}:${s.count}`).join(' ')
                                : '—'}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{formatLastUsed(app.rollup.lastUsedAt)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Recent requests</h2>
        <form method="get" className="flex flex-wrap items-end gap-3 rounded-2xl border border-border/60 p-3">
          <div className="space-y-1">
            <Label htmlFor="projectId" className="text-xs">Project</Label>
            <FormSelectField
              className="h-9 min-w-[160px]"
              defaultValue={projectId}
              id="projectId"
              name="projectId"
              options={[
                { value: '', label: 'All' },
                ...analytics.projects.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="appId" className="text-xs">App</Label>
            <FormSelectField
              className="h-9 min-w-[160px]"
              defaultValue={appId}
              id="appId"
              name="appId"
              options={[
                { value: '', label: 'All' },
                ...analytics.projects.flatMap((p) =>
                  p.apps.map((a) => ({ value: a.id, label: `${p.name} → ${a.name}` })),
                ),
              ]}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="path" className="text-xs">Path contains</Label>
            <Input id="path" name="path" defaultValue={path} placeholder="/api/v1/" className="h-9 w-40" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="status" className="text-xs">Status</Label>
            <Input id="status" name="status" defaultValue={statusRaw} placeholder="200" className="h-9 w-24" />
          </div>
          <button type="submit" className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground">
            Filter
          </button>
        </form>

        <div className="overflow-x-auto rounded-2xl border border-border/60">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead>Time</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>App</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Path</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    No requests match these filters.
                  </TableCell>
                </TableRow>
              ) : (
                logs.rows.map((r, i) => (
                  <TableRow key={`${r.createdAt}-${i}`} className="border-border/60">
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-sm">{r.projectId ? (projectName.get(r.projectId) ?? '—') : '—'}</TableCell>
                    <TableCell className="text-sm">{r.appId ? (appName.get(r.appId) ?? '—') : '—'}</TableCell>
                    <TableCell className="text-xs">{r.method}</TableCell>
                    <TableCell className="font-mono text-xs">{r.path}</TableCell>
                    <TableCell className={`tabular-nums ${r.status >= 400 ? 'text-rose-600' : ''}`}>{r.status}</TableCell>
                    <TableCell className="tabular-nums text-xs">{formatMs(r.latencyMs)}</TableCell>
                    <TableCell className="tabular-nums text-xs">{r.totalTokens != null ? formatInt(r.totalTokens) : '—'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <p className="text-sm text-muted-foreground">
          {formatInt(logs.total)} request{logs.total === 1 ? '' : 's'} · page {page} of {totalPages}
        </p>
      </section>
    </main>
  );
}
