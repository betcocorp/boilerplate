'use client';

/**
 * Filters the "Test sets" table on `/admin/tests` down to golden datasets only.
 *
 * Lives entirely in `?onlyGolden=` — absent or anything other than "false" reads as ON, matching
 * the default-true behavior — so the filter is shareable by URL and survives a reload.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Label } from '~/components/ui/label';
import { Switch } from '~/components/ui/switch';

export function OnlyGoldenToggle({ onlyGolden }: { onlyGolden: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function toggle(checked: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    if (checked) {
      // The default — an explicit `?onlyGolden=true` would read as a non-default filter.
      params.delete('onlyGolden');
    } else {
      params.set('onlyGolden', 'false');
    }
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname);
    });
  }

  return (
    <div
      className={`flex items-center gap-2 transition-opacity ${
        isPending ? 'opacity-60' : ''
      }`}
    >
      <Label className="text-sm text-slate-600" htmlFor="only-golden-toggle">
        Only Golden
      </Label>
      <Switch
        checked={onlyGolden}
        id="only-golden-toggle"
        onCheckedChange={toggle}
        size="sm"
      />
    </div>
  );
}
