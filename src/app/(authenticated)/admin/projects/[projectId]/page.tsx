import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { AddAppDialog } from '~/components/admin/projects/AddAppDialog';
import { ProjectSettingsCard } from '~/components/admin/projects/ProjectSettingsCard';
import { ActiveBadge, EnvBadge, formatLastUsed } from '~/components/admin/projects/ui';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { getAppsForProject, getProject } from '~/lib/api/registry-repository';

type PageProps = { params: Promise<{ projectId: string }> };

export default async function ProjectDetailPage({ params }: PageProps) {
  await connection();
  const { projectId } = await params;
  const [project, apps] = await Promise.all([getProject(projectId), getAppsForProject(projectId)]);
  if (!project) notFound();

  return (
    <main className="min-w-0 space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/admin/projects"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" /> Projects
          </Link>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">{project.name}</h1>
            <ActiveBadge active={project.isActive} />
          </div>
        </div>
      </div>

      <ProjectSettingsCard project={project} />

      <Card className="rounded-3xl border border-border/60 shadow-none">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-lg">Apps</CardTitle>
          <AddAppDialog projectId={project.id} />
        </CardHeader>
        <CardContent>
          {apps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No apps yet. Add one to issue a token.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border/60 hover:bg-transparent">
                    <TableHead>App</TableHead>
                    <TableHead>Environment</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apps.map((app) => (
                    <TableRow key={app.id} className="border-border/60">
                      <TableCell className="font-medium">
                        <Link
                          href={`/admin/projects/${project.id}/apps/${app.id}`}
                          className="hover:underline"
                        >
                          {app.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <EnvBadge environment={app.environment} />
                      </TableCell>
                      <TableCell>
                        <ActiveBadge active={app.isActive} />
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {app.activeTokenCount}/{app.tokenCount}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatLastUsed(app.lastUsedAt)}</TableCell>
                      <TableCell>
                        <Link
                          href={`/admin/projects/${project.id}/apps/${app.id}`}
                          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                        >
                          Open <ChevronRight className="size-4" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
