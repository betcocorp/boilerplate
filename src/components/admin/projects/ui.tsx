import { Badge } from '~/components/ui/badge';

/** Shared presentational helpers for the API-security admin pages. Server-safe (no hooks). */

const ENV_STYLES: Record<string, string> = {
  production: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  staging: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  development: 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
};

export function EnvBadge({ environment }: { environment: string }) {
  return (
    <Badge variant="secondary" className={ENV_STYLES[environment] ?? 'bg-muted text-muted-foreground'}>
      {environment}
    </Badge>
  );
}

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
