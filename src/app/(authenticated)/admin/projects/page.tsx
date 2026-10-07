import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { connection } from 'next/server';

import { CreateProjectWizard } from '~/components/admin/projects/CreateProjectWizard';
import { ActiveBadge, formatDate, formatLastUsed } from '~/components/admin/projects/ui';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { listProjectsWithApps } from '~/lib/api/registry-repository';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';

export const metadata = {
  title: 'API Projects | Betco BEX',
  description: 'Manage API-security projects, apps, and tokens.',
};

export default async function ApiProjectsPage() {
  await requirePagePermission(PERMISSIONS.NAVIGATION_SIDEBAR_USER_API_ACCESS, 'GET /admin/projects');
  await connection();
  const projects = await listProjectsWithApps();

  return (
    <main className="min-w-0 space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">API Security</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Each project (a consuming product like C360) holds apps per environment, and each app
            holds labeled API tokens for <code className="rounded bg-muted px-1">/api/v1/*</code>.
          </p>
        </div>
        <CreateProjectWizard />
      </div>

      {projects.length === 0 ? (
        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No projects yet. Create one to issue an API token.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {projects.map((project) => (
            <Card key={project.id} className="rounded-3xl border border-border/60 shadow-none">
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-lg">
                    <Link href={`/admin/projects/${project.id}`} className="hover:underline">
                      {project.name}
                    </Link>
                  </CardTitle>
                  <ActiveBadge active={project.isActive} />
                  <span className="text-xs text-muted-foreground">Created {formatDate(project.createdAt)}</span>
                </div>
                <Link
                  href={`/admin/projects/${project.id}`}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  Manage <ChevronRight className="size-4" />
                </Link>
              </CardHeader>
              <CardContent>
                {project.contactEmail ? (
                  <p className="mb-3 text-sm text-muted-foreground">Contact: {project.contactEmail}</p>
                ) : null}
                {project.apps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No apps yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-border/60 hover:bg-transparent">
                          <TableHead>App</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Tokens</TableHead>
                          <TableHead>Last used</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {project.apps.map((app) => (
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
                              <ActiveBadge active={app.isActive} />
                            </TableCell>
                            <TableCell className="tabular-nums text-muted-foreground">
                              {app.activeTokenCount}/{app.tokenCount}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatLastUsed(app.lastUsedAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
