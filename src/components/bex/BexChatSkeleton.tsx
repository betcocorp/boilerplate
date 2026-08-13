import type { CSSProperties } from 'react';

import { Skeleton } from '~/components/ui/skeleton';
import { cn } from '~/lib/utils';

// B0-345: widths are index-derived, never Math.random(). The shadcn
// `SidebarMenuSkeleton` randomizes its bar width in a useState initializer, which
// would produce different markup on the server (loading.tsx) and on hydration.
const SIDEBAR_TITLE_WIDTHS = ['82%', '63%', '91%', '70%', '57%', '86%'] as const;
const SIDEBAR_PREVIEW_WIDTHS = [
  '61%',
  '78%',
  '47%',
  '84%',
  '68%',
  '54%',
] as const;

function widthAt(widths: readonly string[], index: number): string {
  return widths[index % widths.length] ?? '70%';
}

function skeletonWidthStyle(width: string): CSSProperties {
  return { '--skeleton-width': width } as CSSProperties;
}

/**
 * Session rows for the Bex conversation sidebar. Mirrors the three stacked lines of a
 * real row (timestamp meta, title, last-message preview) at the same paddings.
 */
export function BexSidebarRowsSkeleton({
  className,
  count = 6,
}: {
  className?: string;
  count?: number;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <span className="sr-only">Loading conversations…</span>
      {Array.from({ length: count }, (_, index) => (
        <div
          aria-hidden
          className="flex flex-col gap-1.5 rounded-2xl px-3 py-2.5"
          key={`bex-sidebar-row-skeleton-${index}`}
        >
          <Skeleton className="h-3 w-28 rounded-full" />
          <Skeleton
            className="h-4 w-(--skeleton-width) rounded-full"
            style={skeletonWidthStyle(widthAt(SIDEBAR_TITLE_WIDTHS, index))}
          />
          <Skeleton
            className="h-3 w-(--skeleton-width) rounded-full"
            style={skeletonWidthStyle(widthAt(SIDEBAR_PREVIEW_WIDTHS, index))}
          />
        </div>
      ))}
    </div>
  );
}

const MESSAGE_BUBBLE_LINE_WIDTHS = [
  ['96%', '88%', '72%'],
  ['84%'],
  ['92%', '79%', '95%', '61%'],
  ['66%', '48%'],
] as const;

/**
 * Message-history placeholder: alternating assistant (left) / user (right) bubbles in the
 * same scroll container, max width, avatar size and bubble radius as the real transcript.
 */
export function BexMessagesSkeleton({
  className,
  count = 4,
}: {
  className?: string;
  count?: number;
}) {
  return (
    <div
      aria-busy="true"
      className={cn(
        'min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6',
        className,
      )}
      role="status"
    >
      <span className="sr-only">Loading conversation history…</span>
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {Array.from({ length: count }, (_, index) => {
          const isUser = index % 2 === 1;
          const lines =
            MESSAGE_BUBBLE_LINE_WIDTHS[index % MESSAGE_BUBBLE_LINE_WIDTHS.length] ??
            MESSAGE_BUBBLE_LINE_WIDTHS[0];

          return (
            <div
              aria-hidden
              className={cn(
                'flex gap-3',
                isUser ? 'flex-row-reverse' : 'flex-row',
              )}
              key={`bex-message-skeleton-${index}`}
            >
              <Skeleton className="mt-0.5 size-9 shrink-0 rounded-full" />
              <div
                className={cn(
                  'min-w-0 rounded-3xl px-4 py-3 shadow-sm ring-1 ring-border/60',
                  isUser
                    ? 'w-[min(100%,22rem)] bg-primary/10'
                    : 'w-[min(100%,36rem)] bg-card',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <Skeleton className="h-3 w-10 rounded-full" />
                  <Skeleton className="h-3 w-12 rounded-full" />
                </div>
                <div className="mt-3 flex flex-col gap-2">
                  {lines.map((width, lineIndex) => (
                    <Skeleton
                      className="h-3.5 w-(--skeleton-width) rounded-full"
                      key={`bex-message-skeleton-${index}-line-${lineIndex}`}
                      style={skeletonWidthStyle(width)}
                    />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Route-level skeleton for `/admin/bex`. Reproduces the `BexChatApp` frame — 280px sidebar
 * rail, header bar, transcript, composer — so content fills in without layout shift.
 */
export function BexChatShellSkeleton() {
  return (
    <main
      aria-busy="true"
      className="box-border flex min-h-0 h-full flex-1 flex-col p-4 sm:p-6"
    >
      <span className="sr-only">Opening Bex…</span>
      <div
        aria-hidden
        className={cn(
          'relative flex min-h-[min(100%,calc(100dvh-8.5rem))] flex-1 overflow-hidden rounded-3xl border border-border/60 bg-background shadow-sm',
          'max-h-[calc(100dvh-8.5rem)]',
        )}
      >
        <div className="hidden w-[280px] shrink-0 flex-col border-r border-border/60 bg-muted/30 lg:flex">
          <div className="flex items-center gap-2 border-b border-border/60 p-3">
            <Skeleton className="h-8 flex-1 rounded-2xl" />
          </div>
          <div className="p-3 pb-2">
            <Skeleton className="h-10 w-full rounded-2xl" />
          </div>
          <BexSidebarRowsSkeleton className="min-h-0 flex-1 overflow-hidden px-2 pb-3" />
        </div>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
            <Skeleton className="size-8 shrink-0 rounded-2xl lg:hidden" />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Skeleton className="size-9 shrink-0 rounded-2xl" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40 max-w-full rounded-full" />
                <Skeleton className="h-3 w-56 max-w-full rounded-full" />
              </div>
            </div>
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Skeleton className="size-8 shrink-0 rounded-2xl" />
              <Skeleton className="size-8 shrink-0 rounded-2xl" />
              <Skeleton className="h-9 w-full min-w-40 rounded-2xl sm:w-40" />
              <Skeleton className="h-9 w-full min-w-40 rounded-2xl sm:w-40" />
            </div>
          </div>

          <BexMessagesSkeleton />

          <div className="border-t border-border/60 bg-background/95 p-3 sm:p-4">
            <div className="mx-auto w-full">
              <div className="flex flex-col gap-2 rounded-3xl border border-border/60 bg-muted/30 p-2 shadow-sm">
                <Skeleton className="h-[44px] w-full rounded-2xl" />
                <div className="flex items-center justify-between gap-2 px-1 pb-1">
                  <Skeleton className="h-8 w-24 rounded-2xl" />
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-8 w-28 rounded-2xl" />
                    <Skeleton className="h-9 w-24 rounded-2xl" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
