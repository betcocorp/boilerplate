'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from 'sonner';

type RoutingTestActionToastProps = {
  success?: string | null;
  error?: string | null;
};

/**
 * Surfaces the `?success=` / `?error=` query params written by the routing-test server actions,
 * then strips them from the URL. Same convention as the test-runner surface.
 */
export function RoutingTestActionToast({
  success,
  error,
}: RoutingTestActionToastProps) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (success) {
      toast.success(success, { id: `${pathname}:success:${success}` });
      router.replace(pathname);
      return;
    }

    if (error) {
      toast.error(error, { id: `${pathname}:error:${error}` });
      router.replace(pathname);
    }
  }, [error, pathname, router, success]);

  return null;
}
