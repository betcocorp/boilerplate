import { FileText, Search, Sparkles } from 'lucide-react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { AdminAccountMenu } from '~/components/admin/AdminAccountMenu';
import { AdminNavAutoClose } from '~/components/admin/AdminNavAutoClose';
import { AdminScrollableMain } from '~/components/admin/AdminScrollableMain';
import { AdminSidebarNav } from '~/components/admin/AdminSidebarNav';
import { Button } from '~/components/ui/button';
import { Separator } from '~/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '~/components/ui/sidebar';

type AdminLayoutProps = {
  children: ReactNode;
};

export default async function AdminLayout({ children }: AdminLayoutProps) {
  // Persist the collapsed/expanded state across navigations (read server-side to avoid a flash).
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get('sidebar_state')?.value !== 'false';

  return (
    <SidebarProvider
      className="h-svh overflow-hidden bg-muted/40"
      defaultOpen={defaultOpen}
    >
      <Sidebar className="border-r border-border/60">
        <SidebarHeader className="p-3">
          <Link
            className="flex items-center gap-3 rounded-2xl px-2 py-2 text-sm font-semibold text-sidebar-foreground"
            href="/admin"
          >
            <div className="flex size-8 items-center justify-center rounded-2xl bg-sidebar-primary text-sidebar-primary-foreground">
              <Sparkles className="size-4" />
            </div>
            <span>Acme Inc.</span>
          </Link>
        </SidebarHeader>

        <SidebarContent>
          <AdminNavAutoClose>
            <AdminSidebarNav />
          </AdminNavAutoClose>
        </SidebarContent>

        <SidebarFooter className="p-3">
          <AdminAccountMenu />
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="supports-backdrop-filter:bg-background/80 z-20 shrink-0 border-b border-border/60 bg-background/95 px-4 py-4 backdrop-blur sm:px-8">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-2">
              <SidebarTrigger className="-ml-1" />
              <Separator
                className="mr-1 h-6 data-vertical:h-6"
                orientation="vertical"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-muted-foreground">
                  Admin workspace
                </p>
                <h2 className="truncate text-lg font-semibold text-foreground">
                  Product and RAG operations
                </h2>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/sds">
                  <FileText className="size-4" />
                  <span className="hidden md:block">SDS</span>
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/products/rag">
                  <Search className="size-4" />
                  <span className="hidden md:block">Search</span>
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/products/rag/generate">
                  <Sparkles className="size-4" />
                  <span className="hidden md:block">Generate</span>
                </Link>
              </Button>
            </div>
          </div>
        </header>

        <AdminScrollableMain>{children}</AdminScrollableMain>
      </SidebarInset>
    </SidebarProvider>
  );
}
