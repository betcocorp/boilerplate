/**
 * B0-599 — the single canonical list of selectable chat model tags.
 *
 * Deliberately NOT duplicated into `~/types/bex.ts` even though the ticket names that file: this
 * list already backs the /admin/tests run form, the Bex chat picker and
 * `POST /api/admin/tests/runs`, and a second copy is exactly the drift that let the test-runner
 * action silently coerce newer models to `preview` (B0-564). `~/types/bex.ts` re-exports these
 * symbols so the ticket's stated import path works without a second source of truth.
 *
 * A tag is NOT an OpenAI model id — `resolveResponsesModel` (`~/lib/openai/client`) maps tags to
 * concrete ids and applies env overrides. Adding a tag here requires two follow-ups or it will
 * misbehave silently:
 *   1. a branch in `resolveResponsesModel` if the tag needs an env override (B0-598);
 *   2. a `public.model_pricing` row keyed to the TAG STRING, because B0-563 stamps
 *      `workflow_steps.output.model` from our resolver, and the B0-565 cost views join it with an
 *      INNER lateral — an unpriced model is dropped from cost reporting entirely, not zeroed.
 */

/** Every selectable tag, including the env-configured `preview` default. */
export const BEX_MODEL_TAGS = [
  'preview',
  'gpt-4o',
  'gpt-4.1-mini',
  'gpt-4.1',
  'gpt-5.5',
  'gpt-5.6',
] as const;

export type BexModelTag = (typeof BEX_MODEL_TAGS)[number];

/** Tags that name a concrete model, i.e. everything except the env-driven `preview`. */
export type ExplicitBexModelTag = Exclude<BexModelTag, 'preview'>;

export type SupportedModel = {
  name: ExplicitBexModelTag;
  label: string;
};

export function isBexModelTag(value: string): value is BexModelTag {
  return (BEX_MODEL_TAGS as readonly string[]).includes(value);
}

/**
 * Shown under the model selector so whoever starts a run knows what they are choosing and what it
 * costs. Rates are the published standard $/Mtok input→output seeded in `public.model_pricing`;
 * they are a decision aid, not a billing source — the cost views are.
 *
 * `custom` is intentionally absent: `resolveResponsesModel` unconditionally THROWS on that tag (a
 * caller must pass a concrete model id directly instead), so offering it in a dropdown just
 * produces a failed run.
 */
export const MODEL_DESCRIPTIONS: Record<BexModelTag, string> = {
  preview:
    'Settings-table default (BEX_RESPONSES_MODEL row at /admin/settings; gpt-4.1-mini unless changed). Use this as the A/B baseline.',
  'gpt-4o': 'Older general-purpose model. $2.50 → $10.00 per Mtok.',
  'gpt-4.1-mini': 'Cheapest option and what `preview` resolves to today. $0.40 → $1.60 per Mtok.',
  'gpt-4.1': 'Current validator/report default. $2.00 → $8.00 per Mtok.',
  'gpt-5.5':
    'Resolves to gpt-5.5-2026-04-23. Candidate validator model (B0-603). $5.00 → $30.00 per Mtok — ~2.5x gpt-4.1 in, ~3.75x out.',
  'gpt-5.6':
    'Alias for gpt-5.6-sol. Candidate orchestrator/routing model (B0-604). $5.00 → $30.00 per Mtok. Pin an explicit -sol/-terra/-luna id if the alias target matters.',
};

const supportedModels: SupportedModel[] = [
  {
    name: 'gpt-4o',
    label: 'Model: gpt-4o',
  },
  {
    name: 'gpt-4.1-mini',
    label: 'Model: gpt-4.1-mini',
  },
  {
    name: 'gpt-4.1',
    label: 'Model: gpt-4.1',
  },
  { name: 'gpt-5.5', label: 'Model: gpt-5.5' },
  { name: 'gpt-5.6', label: 'Model: gpt-5.6' },
];

export default supportedModels;
