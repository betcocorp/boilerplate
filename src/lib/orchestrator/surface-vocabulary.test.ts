import { describe, expect, it } from 'vitest';

import {
  hasNamedSurfaceContext,
  NAMED_SURFACE_TERMS,
  resolveFloorSpecialistForSurface,
  SURFACE_VOCABULARY_PROMPT_EXAMPLES,
} from '~/lib/orchestrator/surface-vocabulary';

/**
 * B0-1034 — `resolveFloorSpecialistForSurface` is the deterministic half of the fix that keeps a
 * product-selection ask for a named floor substrate with its substrate specialist instead of
 * `recommendations` (B0-977, exercised through `applyFloorSurfaceRoutingOverride`). It shipped with
 * no test of its own, so a re-worded pattern or a re-ordered `FLOOR_SURFACE_OWNERS` list could
 * silently stop resolving VCT — the exact regression the VCT golden run hit. These tests pin the
 * ownership map, the resilient-before-`tile` ordering, and the deliberate `null` for non-floor
 * surfaces.
 */
describe('resolveFloorSpecialistForSurface — B0-1034 substrate ownership', () => {
  it.each([
    ['vct', 'floor_vct'],
    ['VCT', 'floor_vct'],
    ['VCT floor', 'floor_vct'],
    ['vinyl composition tile', 'floor_vct'],
    ['vinyl tile', 'floor_vct'],
    ['LVT', 'floor_vct'],
    ['luxury vinyl tile', 'floor_vct'],
    ['terrazzo', 'floor_vct'],
    ['linoleum', 'floor_vct'],
    ['rubber flooring', 'floor_vct'],
    ['resilient tile', 'floor_vct'],
  ] as const)('resolves resilient substrate %j to %s', (surface, expected) => {
    expect(resolveFloorSpecialistForSurface(surface)).toBe(expected);
  });

  it.each([
    ['hardwood', 'floor_wood_sport'],
    ['wood floor', 'floor_wood_sport'],
    ['gym floor', 'floor_wood_sport'],
    ['sports floor', 'floor_wood_sport'],
    ['basketball court', 'floor_wood_sport'],
    ['maple', 'floor_wood_sport'],
    ['concrete', 'floor_concrete'],
    ['polished concrete', 'floor_concrete'],
    ['grout', 'floor_stg'],
    ['ceramic tile', 'floor_stg'],
    ['porcelain tile', 'floor_stg'],
    ['marble', 'floor_stg'],
    ['granite', 'floor_stg'],
    ['natural stone', 'floor_stg'],
    ['tile', 'floor_stg'],
  ] as const)('resolves %j to %s', (surface, expected) => {
    expect(resolveFloorSpecialistForSurface(surface)).toBe(expected);
  });

  it('prefers the resilient owner over the bare `tile` group when both could match', () => {
    // Ordering guard: `vinyl tile` and `terrazzo tile` must never fall through to floor_stg's `tiles?`.
    expect(resolveFloorSpecialistForSurface('vinyl tile')).toBe('floor_vct');
    expect(resolveFloorSpecialistForSurface('terrazzo tile')).toBe('floor_vct');
    expect(resolveFloorSpecialistForSurface('VCT tile')).toBe('floor_vct');
  });

  it.each(['stainless steel', 'carpet', 'brick', 'drywall', 'upholstery', 'laminate', 'epoxy'])(
    'returns null for non-floor surface %j — no floor specialist owns it',
    (surface) => {
      expect(resolveFloorSpecialistForSurface(surface)).toBeNull();
    },
  );

  it.each([null, undefined, '', '   '])('never guesses from an absent surface (%j)', (surface) => {
    expect(resolveFloorSpecialistForSurface(surface)).toBeNull();
  });
});

describe('surface vocabulary invariants', () => {
  it('keeps every prompt example inside the canonical term list it is sampled from', () => {
    for (const example of SURFACE_VOCABULARY_PROMPT_EXAMPLES) {
      expect(hasNamedSurfaceContext(example), `${example} is a recognised surface`).toBe(true);
    }
  });

  it('matches a named surface inside a full sentence, and not in unrelated prose', () => {
    expect(hasNamedSurfaceContext('What should I use on my VCT floor?')).toBe(true);
    expect(hasNamedSurfaceContext('How often should we reorder cases?')).toBe(false);
  });

  it('has no duplicate and no blank canonical terms', () => {
    const terms = [...NAMED_SURFACE_TERMS];
    expect(new Set(terms).size).toBe(terms.length);
    for (const term of terms) expect(term.trim()).toBe(term);
  });
});
