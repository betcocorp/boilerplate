import type { ReactNode } from 'react';

import { cn } from '~/lib/utils';

/**
 * Label-above-value detail row used by the permission group and user detail cards.
 * Port of c360's `components/custom/LabelValueDisplay`.
 */
export function DetailItem({
  className,
  label,
  value,
}: {
  /** Applied to the outer row (e.g. a grid column span when the parent is a grid). */
  className?: string;
  label: ReactNode;
  value: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
        {label}
      </div>
      <div className="mb-2 text-sm text-foreground">{value}</div>
    </div>
  );
}
