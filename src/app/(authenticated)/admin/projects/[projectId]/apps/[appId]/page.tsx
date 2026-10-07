import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { AppSettingsCard } from '~/components/admin/projects/AppSettingsCard';
import { AppTokens, type TokenView } from '~/components/admin/projects/AppTokens';
import { ActiveBadge } from '~/components/admin/projects/ui';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { getApp, getProject, getTokensForApp, type ApiKeyRow } from '~/lib/api/registry-repository';

type PageProps = { params: Promise<{ projectId: string; appId: string }> };

function tokenStatus(k: ApiKeyRow, now = Date.now()): TokenView['status'] {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

export default async function AppDetailPage({ params }: PageProps) {
  await connection();
  const { projectId, appId } = await params;
  const [project, app, keys] = await Promise.all([
    getProject(projectId),
    getApp(appId),
    getTokensForApp(appId),
  ]);
  if (!project || !app || app.projectId !== projectId) notFound();

  const tokens: TokenView[] = keys.map((k) => ({
    id: k.id,
    label: k.label,
    prefix: k.prefix,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    status: tokenStatus(k),
  }));

  return (
    <main className="min-w-0 space-y-6 p-4 sm:p-6">
      <div>
        <Link
          href={`/admin/projects/${projectId}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> {project.name}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{app.name}</h1>
          <ActiveBadge active={app.isActive} />
        </div>
      </div>

      <AppSettingsCard
        app={{
          id: app.id,
          projectId: app.projectId,
          name: app.name,
          rateLimitPerMinute: app.rateLimitPerMinute,
          isActive: app.isActive,
        }}
      />

      <Card className="rounded-3xl border border-border/60 shadow-none">
        <CardHeader>
          <CardTitle className="text-lg">Tokens</CardTitle>
        </CardHeader>
        <CardContent>
          <AppTokens projectId={projectId} appId={appId} tokens={tokens} />
        </CardContent>
      </Card>
    </main>
  );
}
