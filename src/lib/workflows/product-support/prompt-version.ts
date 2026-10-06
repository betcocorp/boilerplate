import { createHash } from 'node:crypto';

import { CROSS_REFERENCE_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/cross-reference-specialist/cross-reference-specialist-system-prompt';
import { DILUTION_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/dilution-specialist/dilution-specialist-system-prompt';
import { FLOOR_CONCRETE_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-concrete-specialist-system-prompt';
import { FLOOR_STG_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-stg-specialist-system-prompt';
import { FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-vct-specialist-system-prompt';
import { FLOOR_WOOD_SPORT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-wood-sport-specialist-system-prompt';
import { PRODUCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/product-specialist/product-specialist-system-prompt';
import { RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/recommendations-specialist/recommendations-specialist-system-prompt';
import { productSupportTools } from '~/lib/tools/definitions';
import { ANSWER_COVERAGE_REVISION_SYSTEM_PROMPT } from '~/lib/workflows/product-support/decisive-assertion-coverage';
import {
  BATHROOM_SPECIALIST_SYSTEM_PROMPT,
  effectivePromptIdForDecision,
  PRODUCT_SUPPORT_PREAMBLE,
  PRODUCT_SUPPORT_SHARED_INSTRUCTIONS,
  VALIDATOR_SYSTEM_PROMPT,
  type EffectivePromptId,
} from '~/lib/workflows/product-support/product-support-prompts';

/**
 * B0-393 — prompt version stamps.
 *
 * Two hashes, because one would be wrong:
 * - `promptVersion` (per ITEM) covers the static specialist policy that actually ran, plus the
 *   shared static instruction text wrapped around it. It deliberately EXCLUDES the trailing routing
 *   hint block (decision + scores + rationale), which is per-message and would make every item's
 *   hash unique, and therefore useless for grouping.
 * - `promptBundleVersion` (per RUN) covers every prompt constant plus the tool definitions. A single
 *   run routes across up to five specialists, so a per-run specialist hash would be meaningless;
 *   this is the run-level grouping key.
 *
 * Why not hash the module source: under Turbopack/webpack there is no reliable access to a module's
 * own source text at runtime, so we hash the exported string constants and the tool-definition JSON
 * instead. Tool definitions are included because their names, descriptions, and JSON schemas drive
 * tool selection as much as the system prompt does.
 *
 * NO whitespace normalisation is applied: any edit — even a trailing space — is an edit, and a
 * changed chip on a trivial edit is preferable to a hash that hides a real change.
 *
 * ACCEPTED LIMITATION: changes to the assembly LOGIC in `buildProductSupportInstructions` (how the
 * pieces are ordered, which conditional branch runs, the `modeLine` wording, the routing-hint
 * formatting) do NOT bump either hash. Function bodies cannot be reliably hashed under
 * minification, so only prompt TEXT and TOOL DEFINITIONS are covered. If you change assembly logic
 * in a way that materially alters model behaviour, bump `PROMPT_HASH_SCHEME` below by hand.
 */

/**
 * Domain separator + scheme version. Bumping this intentionally invalidates every previously stored
 * hash (all rows re-group), so only bump it when the hashing INPUTS or layout change.
 */
const PROMPT_HASH_SCHEME = 'bex.product-support.prompt-hash/1';

/** ASCII unit separator — never appears in the prompt text we author, so fields cannot bleed. */
const FIELD_SEPARATOR = '\u001f';

/** Default number of hex characters used for the display/short form of a hash. */
export const SHORT_HASH_LENGTH = 6;

/**
 * The five specialist policies the product-support workflow can run.
 *
 * B0-392 — an alias of `EffectivePromptId`: the id that selects the prompt and the id that stamps
 * its hash are the same value from the same mapping, so `effectivePromptId` and `promptVersion`
 * cannot disagree about which policy ran.
 */
export type SpecialistPromptId = EffectivePromptId;

/** Specialist policy texts, injectable so the hashing properties are testable without editing source. */
export type SpecialistPromptTexts = Record<SpecialistPromptId, string>;

/** Static prompt text shared by every specialist route (not per-message). */
export type SharedPromptTexts = {
  preamble: string;
  sharedInstructions: string;
};

export type PromptBundleInputs = {
  specialists: SpecialistPromptTexts;
  shared: SharedPromptTexts;
  /** The validator system prompt — part of the run's prompt surface, not of any one item's route. */
  validatorPrompt: string;
  /** The bounded pre-validator answer-coverage repair prompt. */
  answerCoverageRevisionPrompt: string;
  /** Tool definitions exactly as sent to the model (order is significant). */
  tools: unknown;
};

const SPECIALIST_PROMPT_IDS: readonly SpecialistPromptId[] = [
  'bathroom',
  'dilution',
  // B0-746 — the former single `floor` id was split into four substrate specialists.
  'floor_wood_sport',
  'floor_concrete',
  'floor_stg',
  'floor_vct',
  'product',
  'recommendations',
  'cross_reference',
];

/**
 * B0-392 — was a private mirror of the `systemPromptForDecision` fallthrough; now the SAME function
 * that picks the prompt (`effectivePromptIdForDecision` in `product-support-prompts.ts`). Anything
 * that is not a known specialist (including `'ambiguous'` and an empty decision) runs the PRODUCT
 * policy, so it hashes to the product specialist's `promptVersion` — and a change to that
 * fallthrough can no longer move the prompt without moving the stamp.
 */
const specialistIdForDecision = effectivePromptIdForDecision;

/**
 * Deterministic JSON: object keys are sorted (recursively), so key ORDER in the source never
 * affects the hash. Array order IS significant — reordering tool definitions changes what the model
 * sees, so it must change the hash. `undefined` object values are dropped (as `JSON.stringify`
 * does); `undefined` array entries become `null`.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(',')}}`;
  }

  // Primitives; `JSON.stringify` returns undefined for functions/symbols, which we normalise.
  return JSON.stringify(value) ?? 'null';
}

/**
 * Length-prefixed, labelled field so concatenation is injective: no combination of field values can
 * be rearranged into a different but identically-hashing canonical string.
 */
function canonicalField(label: string, value: string): string {
  return `${label}${FIELD_SEPARATOR}${value.length}${FIELD_SEPARATOR}${value}${FIELD_SEPARATOR}`;
}

function sha256Hex(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Short display form of a full hash (chips, table cells). Storage always keeps the full hash. */
export function shortHash(hash: string, length: number = SHORT_HASH_LENGTH): string {
  return hash.slice(0, Math.max(0, length));
}

/**
 * Canonical input for a single item's `promptVersion`. Exported for tests/debugging so a failing
 * hash comparison can be diffed as text rather than guessed at.
 */
export function canonicalPromptVersionInput(input: {
  decision: string;
  specialists: SpecialistPromptTexts;
  shared: SharedPromptTexts;
}): string {
  const specialistId = specialistIdForDecision(input.decision);

  return [
    canonicalField('scheme', PROMPT_HASH_SCHEME),
    canonicalField('kind', 'promptVersion'),
    canonicalField('specialistId', specialistId),
    canonicalField('specialistPrompt', input.specialists[specialistId]),
    canonicalField('preamble', input.shared.preamble),
    canonicalField('sharedInstructions', input.shared.sharedInstructions),
  ].join('');
}

/**
 * Pure, injectable `promptVersion` — hashes the specialist policy selected by `decision` plus the
 * shared static instruction text. Never touches the per-message routing hint.
 */
export function computePromptVersionFrom(input: {
  decision: string;
  specialists: SpecialistPromptTexts;
  shared: SharedPromptTexts;
}): string {
  return sha256Hex(canonicalPromptVersionInput(input));
}

/**
 * Canonical input for the run-level `promptBundleVersion`: every specialist policy (in a fixed id
 * order, so declaration order in source is irrelevant), the shared static text, the validator
 * prompt, and the tool definitions as stable-key JSON.
 */
export function canonicalPromptBundleInput(input: PromptBundleInputs): string {
  return [
    canonicalField('scheme', PROMPT_HASH_SCHEME),
    canonicalField('kind', 'promptBundleVersion'),
    ...SPECIALIST_PROMPT_IDS.map((id) =>
      canonicalField(`specialist:${id}`, input.specialists[id]),
    ),
    canonicalField('preamble', input.shared.preamble),
    canonicalField('sharedInstructions', input.shared.sharedInstructions),
    canonicalField('validator', input.validatorPrompt),
    canonicalField('answerCoverageRevision', input.answerCoverageRevisionPrompt),
    canonicalField('tools', stableStringify(input.tools)),
  ].join('');
}

/** Pure, injectable `promptBundleVersion`. */
export function computePromptBundleVersionFrom(input: PromptBundleInputs): string {
  return sha256Hex(canonicalPromptBundleInput(input));
}

/** The specialist policies exactly as the product-support workflow runs them. */
export const PRODUCT_SUPPORT_SPECIALIST_PROMPTS: SpecialistPromptTexts = {
  bathroom: BATHROOM_SPECIALIST_SYSTEM_PROMPT,
  dilution: DILUTION_SPECIALIST_SYSTEM_PROMPT,
  floor_wood_sport: FLOOR_WOOD_SPORT_SPECIALIST_SYSTEM_PROMPT,
  floor_concrete: FLOOR_CONCRETE_SPECIALIST_SYSTEM_PROMPT,
  floor_stg: FLOOR_STG_SPECIALIST_SYSTEM_PROMPT,
  floor_vct: FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT,
  product: PRODUCT_SPECIALIST_SYSTEM_PROMPT,
  recommendations: RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT,
  cross_reference: CROSS_REFERENCE_SPECIALIST_SYSTEM_PROMPT,
};

const PRODUCT_SUPPORT_SHARED_PROMPTS: SharedPromptTexts = {
  preamble: PRODUCT_SUPPORT_PREAMBLE,
  sharedInstructions: PRODUCT_SUPPORT_SHARED_INSTRUCTIONS,
};

/** Memoized at module load — the inputs are compile-time constants, so this never changes at runtime. */
const promptVersionCache = new Map<SpecialistPromptId, string>();

/**
 * Per-item prompt stamp. `decision` is the routing decision; unknown/'ambiguous' decisions resolve
 * to the product specialist, exactly as prompt assembly does.
 */
export function computePromptVersion(decision: string): string {
  const specialistId = specialistIdForDecision(decision);
  const cached = promptVersionCache.get(specialistId);
  if (cached) return cached;

  const hash = computePromptVersionFrom({
    decision: specialistId,
    specialists: PRODUCT_SUPPORT_SPECIALIST_PROMPTS,
    shared: PRODUCT_SUPPORT_SHARED_PROMPTS,
  });
  promptVersionCache.set(specialistId, hash);
  return hash;
}

/** Short display form of the per-item stamp. Store `computePromptVersion()`; display this. */
export function computePromptVersionShort(decision: string): string {
  return shortHash(computePromptVersion(decision));
}

/** Per-run prompt stamp: all prompt constants + the tool definitions. Computed once at module load. */
export const PROMPT_BUNDLE_VERSION: string = computePromptBundleVersionFrom({
  specialists: PRODUCT_SUPPORT_SPECIALIST_PROMPTS,
  shared: PRODUCT_SUPPORT_SHARED_PROMPTS,
  validatorPrompt: VALIDATOR_SYSTEM_PROMPT,
  answerCoverageRevisionPrompt: ANSWER_COVERAGE_REVISION_SYSTEM_PROMPT,
  tools: productSupportTools,
});

/** Short display form of the per-run stamp. */
export const PROMPT_BUNDLE_VERSION_SHORT: string = shortHash(PROMPT_BUNDLE_VERSION);
