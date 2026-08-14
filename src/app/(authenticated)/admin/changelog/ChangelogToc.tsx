'use client';

import { cn } from '~/lib/utils';

export interface ChangelogVersion {
  id: string;
  label: string;
}

interface ChangelogTocProps {
  versions: ChangelogVersion[];
  className?: string;
}

export function ChangelogToc({ versions, className }: ChangelogTocProps) {
  if (versions.length === 0) {
    return null;
  }

  function handleClick(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }

  return (
    <nav
      aria-label="Changelog versions"
      className={cn(
        'rounded-2xl border border-border/60 bg-background shadow-sm',
        className,
      )}
    >
      <div className="border-b border-border/60 px-4 py-3">
        <p className="text-sm font-medium text-foreground">Versions</p>
      </div>
      <ul className="max-h-[70vh] space-y-1 overflow-y-auto p-2">
        {versions.map((version) => (
          <li key={version.id}>
            <a
              href={`#${version.id}`}
              onClick={(event) => handleClick(event, version.id)}
              className="block truncate rounded-md px-3 py-1.5 text-sm text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
            >
              {version.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
