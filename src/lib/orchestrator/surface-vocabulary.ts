/**
 * B0-660 — canonical vocabulary of physical surfaces/materials a product question can name.
 *
 * Single source of truth shared by:
 * - `intent-classifier.ts` — the `entities.surfaceType` prompt instructions render a sample of
 *   these as worked examples, instead of hand-maintaining a second example list.
 * - `run-product-support-workflow.ts`'s `hasNamedSurfaceContext` early-decline suppression check
 *   — a deterministic regex mirror of the same vocabulary, used because the classifier's own
 *   `entities.surfaceType` is NOT reliably available at the point the early-decline gate runs for
 *   a given turn (it is only populated when the LLM classifier itself decided the turn — see the
 *   gate call site in `runProductSupportWorkflow` — so a turn routed by the semantic router, the
 *   keyword router, or a disabled/shadow classifier would otherwise silently lose this check).
 *
 * Keep this list to concrete, unambiguous surface/material nouns (not soil types, not tasks) so a
 * match here always means "the user named a surface", never a false trigger from an unrelated word.
 */
export const NAMED_SURFACE_TERMS = [
  'concrete',
  'terrazzo',
  'vct',
  'vinyl composition tile',
  'vinyl tile',
  'vinyl floor',
  'lvt',
  'luxury vinyl tile',
  'grout',
  'ceramic tile',
  'porcelain tile',
  'quarry tile',
  'tile',
  'carpet',
  'carpeting',
  'rug',
  'stainless steel',
  'stainless',
  'hardwood',
  'wood floor',
  'wood flooring',
  'linoleum',
  'marble',
  'granite',
  'natural stone',
  'stone floor',
  'rubber floor',
  'rubber flooring',
  'epoxy',
  'laminate',
  'brick',
  'drywall',
  'upholstery',
] as const;

/**
 * A short, representative sample of `NAMED_SURFACE_TERMS` rendered into the classifier's prompt
 * (`intent-classifier.ts`) as worked examples, so they stay in sync with the gate's vocabulary
 * instead of drifting as a second hand-maintained list.
 */
export const SURFACE_VOCABULARY_PROMPT_EXAMPLES = [
  'VCT floor',
  'grout',
  'terrazzo',
  'stainless steel',
] as const;

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildNamedSurfacePattern(): RegExp {
  const alternation = [...NAMED_SURFACE_TERMS].map(escapeRegExp).join('|');
  // Trailing `s?` handles simple plurals ("tiles", "rugs") without a second list.
  return new RegExp(`\\b(?:${alternation})s?\\b`, 'i');
}

const NAMED_SURFACE_PATTERN = buildNamedSurfacePattern();

/**
 * True when `text` already names a physical surface/material from `NAMED_SURFACE_TERMS`. Used to
 * suppress the "please share your surface" early decline when the user already answered that
 * question in their own words — see the module doc above for why this can't just read
 * `entities.surfaceType`.
 */
export function hasNamedSurfaceContext(text: string): boolean {
  return NAMED_SURFACE_PATTERN.test(text);
}
