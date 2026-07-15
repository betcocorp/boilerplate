import {
  generateApiToken,
  type ApiEnvironment,
} from '~/lib/api/api-tokens';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * Data access for the API-security registry (`api_project` → `api_app` → `api_key`), used by the
 * bex admin. All reads/writes go through the service-role client (the tables are RLS-enabled with
 * no policies, so the anon key cannot touch them). The full token plaintext is returned only by
 * {@link mintToken}, once, at creation — everywhere else only the prefix is ever exposed.
 */

export type ApiProject = {
  id: string;
  name: string;
  description: string | null;
  contactEmail: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ApiApp = {
  id: string;
  projectId: string;
  name: string;
  environment: ApiEnvironment;
  isActive: boolean;
  rateLimitPerMinute: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiKeyRow = {
  id: string;
  appId: string;
  label: string | null;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type AppSummary = {
  id: string;
  name: string;
  environment: ApiEnvironment;
  isActive: boolean;
  tokenCount: number;
  activeTokenCount: number;
  lastUsedAt: string | null;
};

export type ProjectWithApps = ApiProject & { apps: AppSummary[] };

type ProjectRowDb = {
  id: string;
  name: string;
  description: string | null;
  contact_email: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type AppRowDb = {
  id: string;
  project_id: string;
  name: string;
  environment: ApiEnvironment;
  is_active: boolean;
  rate_limit_per_minute: number | null;
  created_at: string;
  updated_at: string;
};

type KeyRowDb = {
  id: string;
  app_id: string;
  label: string | null;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

const mapProject = (r: ProjectRowDb): ApiProject => ({
  id: r.id,
  name: r.name,
  description: r.description,
  contactEmail: r.contact_email,
  isActive: r.is_active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapApp = (r: AppRowDb): ApiApp => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  environment: r.environment,
  isActive: r.is_active,
  rateLimitPerMinute: r.rate_limit_per_minute,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapKey = (r: KeyRowDb): ApiKeyRow => ({
  id: r.id,
  appId: r.app_id,
  label: r.label,
  prefix: r.prefix,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
});

/** Is a token currently live (not revoked, not expired)? */
export function isTokenActive(key: Pick<ApiKeyRow, 'revokedAt' | 'expiresAt'>, now = Date.now()): boolean {
  if (key.revokedAt) return false;
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now) return false;
  return true;
}

// --- reads --------------------------------------------------------------------------------------

/** All projects with a summary of each of their apps (for the projects list). */
export async function listProjectsWithApps(): Promise<ProjectWithApps[]> {
  const supabase = getSupabaseServiceRoleClient();
  const [{ data: projects }, { data: apps }, { data: keys }] = await Promise.all([
    supabase.from('api_project').select('*').order('created_at', { ascending: false }),
    supabase.from('api_app').select('*'),
    supabase.from('api_key').select('id, app_id, revoked_at, expires_at, last_used_at'),
  ]);

  const keysByApp = new Map<string, Array<{ revoked_at: string | null; expires_at: string | null; last_used_at: string | null }>>();
  for (const k of (keys ?? []) as Array<{ app_id: string; revoked_at: string | null; expires_at: string | null; last_used_at: string | null }>) {
    const list = keysByApp.get(k.app_id) ?? [];
    list.push(k);
    keysByApp.set(k.app_id, list);
  }

  const appsByProject = new Map<string, AppSummary[]>();
  for (const a of (apps ?? []) as AppRowDb[]) {
    const appKeys = keysByApp.get(a.id) ?? [];
    const lastUsedAt = appKeys.reduce<string | null>((max, k) => {
      if (!k.last_used_at) return max;
      return !max || k.last_used_at > max ? k.last_used_at : max;
    }, null);
    const summary: AppSummary = {
      id: a.id,
      name: a.name,
      environment: a.environment,
      isActive: a.is_active,
      tokenCount: appKeys.length,
      activeTokenCount: appKeys.filter((k) => isTokenActive({ revokedAt: k.revoked_at, expiresAt: k.expires_at })).length,
      lastUsedAt,
    };
    const list = appsByProject.get(a.project_id) ?? [];
    list.push(summary);
    appsByProject.set(a.project_id, list);
  }

  return ((projects ?? []) as ProjectRowDb[]).map((p) => ({
    ...mapProject(p),
    apps: (appsByProject.get(p.id) ?? []).sort((x, y) => (x.name < y.name ? -1 : 1)),
  }));
}

export async function getProject(id: string): Promise<ApiProject | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data } = await supabase.from('api_project').select('*').eq('id', id).maybeSingle();
  return data ? mapProject(data as ProjectRowDb) : null;
}

export async function getAppsForProject(projectId: string): Promise<AppSummary[]> {
  const projects = await listProjectsWithApps();
  return projects.find((p) => p.id === projectId)?.apps ?? [];
}

export async function getApp(id: string): Promise<ApiApp | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data } = await supabase.from('api_app').select('*').eq('id', id).maybeSingle();
  return data ? mapApp(data as AppRowDb) : null;
}

export async function getTokensForApp(appId: string): Promise<ApiKeyRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data } = await supabase
    .from('api_key')
    .select('id, app_id, label, prefix, created_at, last_used_at, expires_at, revoked_at')
    .eq('app_id', appId)
    .order('created_at', { ascending: false });
  return ((data ?? []) as KeyRowDb[]).map(mapKey);
}

// --- writes -------------------------------------------------------------------------------------

export async function createProject(input: {
  name: string;
  description?: string | null;
  contactEmail?: string | null;
}): Promise<ApiProject> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('api_project')
    .insert({
      name: input.name,
      description: input.description ?? null,
      contact_email: input.contactEmail ?? null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return mapProject(data as ProjectRowDb);
}

export async function createApp(input: {
  projectId: string;
  name: string;
  environment: ApiEnvironment;
  rateLimitPerMinute?: number | null;
}): Promise<ApiApp> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('api_app')
    .insert({
      project_id: input.projectId,
      name: input.name,
      environment: input.environment,
      rate_limit_per_minute: input.rateLimitPerMinute ?? null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return mapApp(data as AppRowDb);
}

export type MintedToken = { token: string; key: ApiKeyRow };

/** Issue a new token for an app. Returns the plaintext ONCE; only the hash + prefix are stored. */
export async function mintToken(input: {
  appId: string;
  environment: ApiEnvironment;
  label?: string | null;
  expiresAt?: string | null;
}): Promise<MintedToken> {
  const supabase = getSupabaseServiceRoleClient();
  const generated = generateApiToken(input.environment);
  const { data, error } = await supabase
    .from('api_key')
    .insert({
      app_id: input.appId,
      label: input.label ?? null,
      token_hash: generated.tokenHash,
      prefix: generated.prefix,
      expires_at: input.expiresAt ?? null,
    })
    .select('id, app_id, label, prefix, created_at, last_used_at, expires_at, revoked_at')
    .single();
  if (error) throw new Error(error.message);
  return { token: generated.token, key: mapKey(data as KeyRowDb) };
}
