import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-120 — read model for the API analytics dashboard. Everything reads from `api_request_log`
 * (denormalized project_id + app_id + token usage, indexed on created_at and per-project/app), so
 * rollups never need joins. Rows for the window are fetched with an indexed `created_at` filter and
 * aggregated by the pure functions below (unit-testable); the request table uses the per-app /
 * per-project composite indexes. At pre-launch volume in-process aggregation is fine; a Postgres
 * rollup/materialized view is the scaling follow-up.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_LIMIT = 50_000;

export type RequestLogRow = {
  projectId: string | null;
  appId: string | null;
  status: number;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  method: string;
  path: string;
  createdAt: string;
};

export type Rollup = {
  requestsToday: number;
  requests7d: number;
  requests30d: number;
  errorRate: number;
  avgLatencyMs: number | null;
  totalTokens: number;
  lastUsedAt: string | null;
};

export type LatencyPercentiles = { p50: number; p95: number; p99: number } | null;
export type StatusBucket = { bucket: '2xx' | '3xx' | '4xx' | '5xx'; count: number };
export type DailyPoint = { date: string; requests: number; tokens: number };

// --- pure aggregation --------------------------------------------------------------------------

/** Rollup over a set of already-scoped rows, relative to `now`. */
export function computeRollup(rows: RequestLogRow[], now: number): Rollup {
  const at = (r: RequestLogRow) => new Date(r.createdAt).getTime();
  const within = (ms: number) => rows.filter((r) => now - at(r) <= ms);
  const in30 = within(30 * DAY_MS);

  const latencies = in30.map((r) => r.latencyMs).filter((v): v is number => typeof v === 'number');
  const avgLatencyMs =
    latencies.length > 0 ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : null;
  const errors = in30.filter((r) => r.status >= 400).length;
  const lastUsedAt = rows.reduce<string | null>(
    (max, r) => (!max || r.createdAt > max ? r.createdAt : max),
    null,
  );

  return {
    requestsToday: within(DAY_MS).length,
    requests7d: within(7 * DAY_MS).length,
    requests30d: in30.length,
    errorRate: in30.length > 0 ? Math.round((errors / in30.length) * 1000) / 1000 : 0,
    avgLatencyMs,
    totalTokens: in30.reduce((s, r) => s + (r.totalTokens ?? 0), 0),
    lastUsedAt,
  };
}

/** Latency percentiles (p50/p95/p99) over rows that carry a latency. Null when there are none. */
export function computeLatencyPercentiles(rows: RequestLogRow[]): LatencyPercentiles {
  const sorted = rows
    .map((r) => r.latencyMs)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]!;
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) };
}

/** Status-code breakdown bucketed by class, most-frequent first. */
export function computeStatusBreakdown(rows: RequestLogRow[]): StatusBucket[] {
  const buckets: Record<StatusBucket['bucket'], number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  for (const r of rows) {
    const key = (`${Math.floor(r.status / 100)}xx` as StatusBucket['bucket']);
    if (key in buckets) buckets[key] += 1;
  }
  return (Object.entries(buckets) as Array<[StatusBucket['bucket'], number]>)
    .map(([bucket, count]) => ({ bucket, count }))
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** Requests + tokens per UTC day for the last `days` days (oldest → newest, zero-filled). */
export function computeDailySeries(rows: RequestLogRow[], now: number, days: number): DailyPoint[] {
  const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const points = new Map<string, DailyPoint>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayKey(now - i * DAY_MS);
    points.set(key, { date: key, requests: 0, tokens: 0 });
  }
  for (const r of rows) {
    const key = dayKey(new Date(r.createdAt).getTime());
    const point = points.get(key);
    if (point) {
      point.requests += 1;
      point.tokens += r.totalTokens ?? 0;
    }
  }
  return [...points.values()];
}

export type AppAnalytics = {
  id: string;
  name: string;
  rollup: Rollup;
  status: StatusBucket[];
  latency: LatencyPercentiles;
};

export type ProjectAnalytics = {
  id: string;
  name: string;
  rollup: Rollup;
  apps: AppAnalytics[];
};

export type ApiAnalytics = {
  generatedAt: string;
  windowDays: number;
  overall: Rollup;
  daily: DailyPoint[];
  projects: ProjectAnalytics[];
};

/** Assemble the full dashboard model from window rows + the registry's project/app names (pure). */
export function buildApiAnalytics(input: {
  rows: RequestLogRow[];
  projects: Array<{ id: string; name: string }>;
  apps: Array<{ id: string; name: string; projectId: string }>;
  now: number;
  windowDays: number;
  generatedAt: string;
}): ApiAnalytics {
  const rowsByApp = new Map<string, RequestLogRow[]>();
  const rowsByProject = new Map<string, RequestLogRow[]>();
  for (const r of input.rows) {
    if (r.appId) rowsByApp.set(r.appId, [...(rowsByApp.get(r.appId) ?? []), r]);
    if (r.projectId) rowsByProject.set(r.projectId, [...(rowsByProject.get(r.projectId) ?? []), r]);
  }

  const projects: ProjectAnalytics[] = input.projects
    .map((p) => {
      const projRows = rowsByProject.get(p.id) ?? [];
      const apps: AppAnalytics[] = input.apps
        .filter((a) => a.projectId === p.id)
        .map((a) => {
          const appRows = rowsByApp.get(a.id) ?? [];
          return {
            id: a.id,
            name: a.name,
            rollup: computeRollup(appRows, input.now),
            status: computeStatusBreakdown(appRows),
            latency: computeLatencyPercentiles(appRows),
          };
        })
        .sort((x, y) => y.rollup.requests30d - x.rollup.requests30d);
      return { id: p.id, name: p.name, rollup: computeRollup(projRows, input.now), apps };
    })
    .sort((x, y) => y.rollup.requests30d - x.rollup.requests30d);

  return {
    generatedAt: input.generatedAt,
    windowDays: input.windowDays,
    overall: computeRollup(input.rows, input.now),
    daily: computeDailySeries(input.rows, input.now, input.windowDays),
    projects,
  };
}

// --- live data access --------------------------------------------------------------------------

type LogRowDb = {
  project_id: string | null;
  app_id: string | null;
  status: number;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  method: string;
  path: string;
  created_at: string;
};

const mapRow = (r: LogRowDb): RequestLogRow => ({
  projectId: r.project_id,
  appId: r.app_id,
  status: r.status,
  latencyMs: r.latency_ms,
  promptTokens: r.prompt_tokens,
  completionTokens: r.completion_tokens,
  totalTokens: r.total_tokens,
  method: r.method,
  path: r.path,
  createdAt: r.created_at,
});

const LOG_COLUMNS =
  'project_id, app_id, status, latency_ms, prompt_tokens, completion_tokens, total_tokens, method, path, created_at';

export async function fetchRequestLogRows(input: {
  sinceMs: number;
  limit?: number;
}): Promise<RequestLogRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('api_request_log')
    .select(LOG_COLUMNS)
    .gte('created_at', new Date(input.sinceMs).toISOString())
    .order('created_at', { ascending: false })
    .limit(input.limit ?? DEFAULT_FETCH_LIMIT);
  if (error) throw new Error(error.message);
  return ((data ?? []) as LogRowDb[]).map(mapRow);
}

/** Full dashboard model over the last `windowDays` days. */
export async function getApiAnalytics(windowDays = 30): Promise<ApiAnalytics> {
  const now = Date.now();
  const supabase = getSupabaseServiceRoleClient();
  const [rows, { data: projects }, { data: apps }] = await Promise.all([
    fetchRequestLogRows({ sinceMs: now - windowDays * DAY_MS }),
    supabase.from('api_project').select('id, name'),
    supabase.from('api_app').select('id, name, project_id'),
  ]);

  return buildApiAnalytics({
    rows,
    projects: (projects ?? []) as Array<{ id: string; name: string }>,
    apps: ((apps ?? []) as Array<{ id: string; name: string; project_id: string }>).map((a) => ({
      id: a.id,
      name: a.name,
      projectId: a.project_id,
    })),
    now,
    windowDays,
    generatedAt: new Date(now).toISOString(),
  });
}

export type RequestLogFilters = {
  projectId?: string;
  appId?: string;
  path?: string;
  status?: number;
  sinceMs?: number;
  untilMs?: number;
  page?: number;
  pageSize?: number;
};

export type RequestLogListResult = {
  rows: RequestLogRow[];
  page: number;
  pageSize: number;
  total: number;
};

/** Filterable, paginated recent-requests table (project / app / path / status / date range). */
export async function listRequestLog(filters: RequestLogFilters): Promise<RequestLogListResult> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
  const from = (page - 1) * pageSize;
  const supabase = getSupabaseServiceRoleClient();

  let query = supabase
    .from('api_request_log')
    .select(LOG_COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false });

  if (filters.projectId) query = query.eq('project_id', filters.projectId);
  if (filters.appId) query = query.eq('app_id', filters.appId);
  if (filters.status != null) query = query.eq('status', filters.status);
  if (filters.path) query = query.ilike('path', `%${filters.path}%`);
  if (filters.sinceMs != null) query = query.gte('created_at', new Date(filters.sinceMs).toISOString());
  if (filters.untilMs != null) query = query.lte('created_at', new Date(filters.untilMs).toISOString());

  const { data, count, error } = await query.range(from, from + pageSize - 1);
  if (error) throw new Error(error.message);
  return {
    rows: ((data ?? []) as LogRowDb[]).map(mapRow),
    page,
    pageSize,
    total: count ?? 0,
  };
}
