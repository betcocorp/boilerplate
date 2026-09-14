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

/**
 * B0-977 — which floor specialist OWNS a named floor substrate, per `SME_ROUTING_RULES_PROMPT`
 * rule 2 (B0-746 split). The LLM classifier violated that rule on the VCT golden item ("what
 * stripping and finish products should I use for my VCT floor?" → `recommendations` 0.85 with
 * `surfaceType: "vct"`), and nothing deterministic re-checked `surfaceType` afterwards. This is the
 * deterministic mirror the routers apply AFTER the model call — see
 * `applyFloorSurfaceRoutingOverride` in `intent-classifier.ts`.
 *
 * Order matters: resilient terms first so "vinyl tile" / "terrazzo tile" never fall through to the
 * bare `tile` in the stone/tile/grout group. Non-floor surfaces (stainless, carpet, brick, drywall,
 * upholstery, laminate, epoxy) deliberately resolve to `null` — no floor specialist owns them.
 */
export type FloorSpecialistId = 'floor_wood_sport' | 'floor_concrete' | 'floor_stg' | 'floor_vct';

const FLOOR_SURFACE_OWNERS: ReadonlyArray<{ specialist: FloorSpecialistId; pattern: RegExp }> = [
  {
    specialist: 'floor_vct',
    pattern:
      /\b(?:vct|vinyl\s*composition\s*tiles?|vinyl\s*tiles?|vinyl\s*floor\w*|lvt|luxury\s*vinyl\s*tiles?|terrazzo|linoleum|rubber\s*floor\w*|resilient\s*(?:tile|floor)\w*)\b/i,
  },
  {
    specialist: 'floor_wood_sport',
    pattern:
      /\b(?:hardwood|wood(?:en)?\s*floor\w*|wood\s*flooring|wood|gym(?:nasium)?(?:\s*floor\w*)?|sports?\s*floor\w*|basketball\s*courts?|maple)\b/i,
  },
  { specialist: 'floor_concrete', pattern: /\bconcrete\b/i },
  {
    specialist: 'floor_stg',
    pattern:
      /\b(?:grout|ceramic\s*tiles?|porcelain\s*tiles?|quarry\s*tiles?|marble|granite|natural\s*stone|stone\s*floor\w*|stone|tiles?)\b/i,
  },
];

/**
 * The floor specialist that owns `surfaceType` (the classifier's free-text entity, e.g. "vct",
 * "VCT floor", "gym floor"), or `null` when the surface is not a floor substrate any specialist
 * owns. Pure and deterministic; never guesses from an empty or unknown value.
 */
export function resolveFloorSpecialistForSurface(
  surfaceType: string | null | undefined,
): FloorSpecialistId | null {
  const text = (surfaceType ?? '').trim();
  if (!text) return null;
  for (const owner of FLOOR_SURFACE_OWNERS) {
    if (owner.pattern.test(text)) return owner.specialist;
  }
  return null;
}
