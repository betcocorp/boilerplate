import type { ReactNode } from 'react';

/**
 * Header block for the four `/admin/permissions` pages.
 *
 * Stands in for c360's `components/custom/PageHeader`, which bex has no equivalent of: the bex admin
 * pages each inline an eyebrow + `h1` + description (see `/admin/tools`, `/admin/projects`). This
 * keeps that markup in one place so the four route files stay thin and the pages stay consistent
 * with the rest of the admin area.
 */
export function PermissionsPageHeader({
  actions,
  children,
  description,
  eyebrow = 'Access control',
  title,
}: {
  /** Buttons/dialog triggers shown opposite the title. */
  actions?: ReactNode;
  /** Secondary row under the description, e.g. a back link. */
  children?: ReactNode;
  description?: ReactNode;
  eyebrow?: string;
  title: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-muted-foreground">{eyebrow}</p>
        <h1 className="mt-1 truncate text-3xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
        {children}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
