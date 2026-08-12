'use client';

/**
 * Shared column + row chrome for the two assignment editors (`GroupAssignmentsEditor`,
 * `UserPermissionsEditor`).
 *
 * **Deliberate deviation from c360.** Both editors there were `@dnd-kit/core` drag-and-drop boards:
 * a `DndContext` with three `useDroppable` columns, `useDraggable` rows and a `DragOverlay`. bex has
 * no `@dnd-kit` dependency and this ticket may not add one, so the same three-column model is driven
 * by explicit add/remove buttons instead. Everything else is preserved — the columns, filters,
 * counts, per-row expansion, the local-until-saved edit model, and the exact `PUT` payloads.
 *
 * The button model is also the more accessible of the two: keyboard and screen-reader users can move
 * an item, which they could not with the pointer-sensor board.
 */

import { Minus, Plus, Search } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';

/** "Showing 4 of 12 items" when a filter is narrowing the list, else "12 items". */
function countLabel(count: number, totalCount?: number): string {
  const plural = (value: number) => `${value} item${value === 1 ? '' : 's'}`;
  if (totalCount != null && count !== totalCount) {
    return `Showing ${count} of ${plural(totalCount)}`;
  }
  return plural(count);
}

export function AssignmentColumn({
  children,
  controls,
  count,
  fullHeight,
  title,
  totalCount,
}: {
  children: ReactNode;
  /** Filter inputs / selects rendered under the count. */
  controls?: ReactNode;
  count: number;
  /** Stretch to the parent row height (used by the tall "assigned" column). */
  fullHeight?: boolean;
  title: string;
  totalCount?: number;
}) {
  return (
    <Card
      className={`flex min-h-0 flex-col gap-3 rounded-3xl border border-border/60 shadow-none${
        fullHeight ? ' h-full' : ''
      }`}
    >
      <CardHeader className="shrink-0 gap-0">
        <CardTitle className="text-lg">{title}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {countLabel(count, totalCount)}
        </p>
        {controls ? <div className="mt-3">{controls}</div> : null}
      </CardHeader>
      <CardContent
        className={fullHeight ? 'flex min-h-0 flex-1 flex-col' : undefined}
      >
        <div
          className={
            fullHeight
              ? 'min-h-0 flex-1 space-y-2 overflow-y-auto rounded-2xl bg-muted/30 p-2'
              : 'max-h-[320px] min-h-[160px] space-y-2 overflow-y-auto rounded-2xl bg-muted/30 p-2'
          }
        >
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

/** Search input with a leading icon, used as an `AssignmentColumn` control. */
export function AssignmentFilterInput({
  ariaLabel,
  onChange,
  placeholder,
  value,
}: {
  ariaLabel: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label={ariaLabel}
        className="h-9 pl-8"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="text"
        value={value}
      />
    </div>
  );
}

export function AssignmentGroupHeading({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <p className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  );
}

export function AssignmentEmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * One movable row. `action` is `'add'` in an "available" column and `'remove'` in the assigned
 * column; `expand` and `expanded` render an optional disclosure (the per-user / per-group detail the
 * c360 board showed on a chevron).
 */
export function AssignmentRow({
  action,
  description,
  expand,
  expanded,
  label,
  meta,
  onAction,
  typeLabel,
}: {
  action: 'add' | 'remove';
  description?: string | null;
  /** Disclosure trigger rendered before the add/remove button. */
  expand?: ReactNode;
  /** Disclosure body rendered under the row. */
  expanded?: ReactNode;
  label: string;
  /** Secondary right-aligned text, e.g. "Sales Rep · Sales". */
  meta?: string | null;
  onAction: () => void;
  typeLabel: 'User' | 'Permission' | 'Group';
}) {
  const isAdd = action === 'add';
  const ActionIcon = isAdd ? Plus : Minus;

  return (
    <div className="rounded-2xl border border-border bg-card px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <Badge className="shrink-0 font-normal" variant="secondary">
          {typeLabel}
        </Badge>
        <div className="min-w-0 flex-1 truncate">
          <span className="font-medium">{label}</span>
          {description ? (
            <span className="ml-2 text-muted-foreground">{description}</span>
          ) : null}
        </div>
        {meta ? (
          <span className="max-w-[180px] shrink-0 truncate text-xs text-muted-foreground">
            {meta}
          </span>
        ) : null}
        {expand}
        <Button
          aria-label={`${isAdd ? 'Add' : 'Remove'} ${label}`}
          className={
            isAdd
              ? 'shrink-0 text-muted-foreground hover:text-primary'
              : 'shrink-0 text-muted-foreground hover:text-destructive'
          }
          onClick={onAction}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ActionIcon className="size-4" />
        </Button>
      </div>
      {expanded}
    </div>
  );
}
