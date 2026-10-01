'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from 'sonner';

type AdminAccessDeniedToastProps = {
  show: boolean;
};

/** B0-839 — companion to `requirePagePermission`'s `/admin?accessDenied=1` redirect. */
export function AdminAccessDeniedToast({ show }: AdminAccessDeniedToastProps) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!show) {
      return;
    }
    toast.error(
      "I'm sorry you don't have permissions to view this resource, contact IT Admin if this is an error",
      { id: `access-denied:${pathname}` },
    );
    router.replace(pathname);
  }, [pathname, router, show]);

  return null;
}
