import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { PermissionDetailClient } from '~/components/permissions/PermissionDetailClient';
import { PermissionsPageHeader } from '~/components/permissions/PermissionsPageHeader';
import { Button } from '~/components/ui/button';
import { isPermissionsEnforced } from '~/lib/permissions/enforcement';
import { getPermission } from '~/lib/permissions/repository';

type Props = { params: Promise<{ permissionId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { permissionId } = await params;
  const res = await getPermission(permissionId);
  return { title: `Permission: ${res.data?.SELECTOR ?? 'Permission'}` };
}

export default async function PermissionDetailPage({ params }: Props) {
  await connection();
  const { permissionId } = await params;
  const res = await getPermission(permissionId);

  // Also the path for the `virtual-*` ids the index page lists for undeployed selectors: they have no
  // row, so they 404 rather than rendering an editor over nothing.
  if (!res.success || !res.data) notFound();

  const permission = res.data;

  return (
    <main className="min-w-0 space-y-4 p-4 sm:p-6">
      <PermissionsPageHeader
        description={permission.DESCRIPTION ?? 'Permission details'}
        eyebrow="Permission"
        title={permission.SELECTOR}
      >
        <Button asChild className="mt-2 -ml-3" size="sm" variant="ghost">
          <Link href="/admin/permissions">
            <ArrowLeft className="size-4" />
            Back to Permissions
          </Link>
        </Button>
      </PermissionsPageHeader>

      <PermissionDetailClient
        enforced={isPermissionsEnforced()}
        groups={res.groups}
        permission={permission}
        permissionId={permissionId}
        usersDirect={res.usersDirect}
        usersViaGroups={res.usersViaGroups}
      />
    </main>
  );
}
