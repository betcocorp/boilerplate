'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from 'sonner';

type AdminTestsActionToastProps = {
  success?: string | null;
  error?: string | null;
};

export function AdminTestsActionToast({ success, error }: AdminTestsActionToastProps) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (success) {
      toast.success(success);
      router.replace(pathname);
      return;
    }

    if (error) {
      toast.error(error);
      router.replace(pathname);
    }
  }, [error, pathname, router, success]);

  return null;
}
