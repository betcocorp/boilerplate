'use client';

/**
 * Golden(+archived) filter for the cross-dataset report index (`/admin/tests/reports`), sibling to
 * `ReportDatasetFilter` / `ReportRunByFilter` / `ReportModelFilter`.
 *
 * Defaults OFF: absent `?allGolden=` behaves exactly like today (archived test sets excluded, no
 * golden restriction) — see `listAllReportRuns()` in `~/lib/tests/repository.ts`. Flipping it on
 * sets `?allGolden=true` explicitly and switches the underlying query to golden test sets only,
 * INCLUDING archived ones, so a golden set that was later archived stays reachable here (B0-1096).
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Label } from '~/components/ui/label';
import { Switch } from '~/components/ui/switch';

export function ReportGoldenArchiveFilter({ allGolden }: { allGolden: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function toggle(checked: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    if (checked) {
      params.set('allGolden', 'true');
    } else {
      params.delete('allGolden');
    }
    const query = params.toString();
    startTransition(() => {
      router.push(query ? `${pathname}?${query}` : pathname);
    });
  }

  return (
    <div
      className={`flex items-center gap-2 transition-opacity ${
        isPending ? 'opacity-60' : ''
      }`}
    >
      <Label className="text-sm text-slate-600" htmlFor="report-golden-archive-toggle">
        Golden (incl. archived)
      </Label>
      <Switch
        checked={allGolden}
        id="report-golden-archive-toggle"
        onCheckedChange={toggle}
        size="sm"
      />
    </div>
  );
}
