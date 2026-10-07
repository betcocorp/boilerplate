/**
 * `/admin` landing page. Replace this with your app's dashboard.
 *
 * `requirePagePermission` redirects here with `?accessDenied=1` when a signed-in user opens a page
 * they lack the permission for; `AdminAccessDeniedToast` turns that into a toast.
 */

import { connection } from 'next/server';

import { AdminAccessDeniedToast } from '~/components/admin/AdminAccessDeniedToast';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';

export const metadata = {
  title: 'Dashboard',
  description: 'Application dashboard.',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminDashboardPage({ searchParams }: PageProps) {
  await connection();
  const accessDenied = (await searchParams).accessDenied === '1';

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-5 p-4 sm:p-6">
      <AdminAccessDeniedToast show={accessDenied} />
      <Card className="rounded-3xl border-border/60 shadow-none">
        <CardHeader>
          <CardTitle>Welcome</CardTitle>
          <CardDescription>
            This is the boilerplate dashboard. Add your pages under
            src/app/(authenticated)/admin and link them from the sidebar.
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}
