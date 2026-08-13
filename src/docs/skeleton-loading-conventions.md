# Skeleton vs spinner conventions (B0-346)

**Skeletons** for content that is loading and will be replaced in place — results
lists, result cards, tables, page bodies. Shape the skeleton to the real rendered
markup (same wrapper classes, roughly the same number of rows/lines and the same
bar heights) so the swap does not shift layout.

**Spinners** only for action feedback on a control (the `Loader2` inside a submit
button while the request is in flight) and for true indeterminate/measured
progress (e.g. the pipeline-progress banner in `GenerateControls`, the test-run
progress in `RunExecutionProgress`). Do not use a spinner or a "Loading…" /
"Searching…" text block to stand in for a results region.

## How to build one

- Compose the shared composites first:
  `~/components/admin/skeletons` (`CardGridSkeleton`, `FormSkeleton`,
  `PageHeaderSkeleton`, `StatCardGridSkeleton`, `TableSkeleton`).
- When no composite matches the shape, compose the `Skeleton` primitive
  (`~/components/ui/skeleton`) inline next to the component it stands in for.
- Use fixed, deterministic widths (no randomness) — random widths cause
  hydration mismatches.
- Wrap the skeleton in `role="status" aria-live="polite"` with an `sr-only`
  label so screen readers still get the announcement the old text gave them.

## Rules of thumb

- Gate the real results on `!loading` so a skeleton never renders next to a
  stale result or an empty-state message.
- Error and empty states stay text — they are terminal states, not loads.
- Keep the button spinner **and** add the results skeleton; they answer different
  questions ("did my click register" vs "what is coming").
