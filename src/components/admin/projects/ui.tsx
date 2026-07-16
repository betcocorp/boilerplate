import { Badge } from '~/components/ui/badge';

/** Shared presentational helpers for the API-security admin pages. Server-safe (no hooks). */

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
      Active
    </Badge>
  ) : (
    <Badge variant="secondary" className="bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
      Disabled
    </Badge>
  );
}

export { formatDate, formatLastUsed } from '~/components/admin/projects/format';
