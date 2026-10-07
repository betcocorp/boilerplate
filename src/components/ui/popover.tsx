"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "~/lib/utils"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 flex w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-4 rounded-3xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/5 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 dark:ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

/**
 * B0-359 — spread onto `PopoverContent` when the popover renders inside a modal `Dialog`
 * and its own content needs to scroll (e.g. a long `CommandList`).
 *
 * Radix `DialogOverlay` wraps itself in `RemoveScroll` with `DialogContent` as its only
 * shard. `react-remove-scroll` then listens for `wheel`/`touchmove` on `document` in the
 * BUBBLE phase and `preventDefault()`s any event whose target is in neither the overlay
 * nor a shard. `PopoverContent` is portaled to `document.body`, so it is in neither —
 * every wheel over the popover is cancelled and the content cannot scroll at all.
 *
 * Because that listener is bubble-phase, stopping propagation here means it never runs.
 * Scroll chaining to the page behind must be handled by the scroll container itself
 * (`overscroll-contain`), since `RemoveScroll` no longer intercepts the event.
 *
 * Opt-in rather than baked into `PopoverContent`: popovers that don't scroll their own
 * content should keep the default behaviour.
 */
const popoverScrollInDialogProps = {
  onTouchMove: (event: React.TouchEvent) => event.stopPropagation(),
  onWheel: (event: React.WheelEvent) => event.stopPropagation(),
} as const

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("text-base font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  popoverScrollInDialogProps,
}
