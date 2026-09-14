import { describe, expect, it } from 'vitest';

import {
  FLOOR_REOPEN_PROCEDURE_QUERY,
  buildFloorReopenInstruction,
  draftStatesTimingFigure,
  isFloorReopenQuestion,
  requireFloorReopenTool,
} from '~/lib/workflows/product-support/floor-reopen-backstop';

/** VCT golden `339b3004` — the prompt this backstop exists for. */
const GOLDEN_PROMPT = 'how soon can people walk on the VCT floor after the last coat?';

/** The 4.4.0 answer: a clarifying question in place of the schedule. */
const WITHHOLDING_DRAFT =
  'I need the exact Betco floor-finish name or item number before giving a walk-on time, because cure and traffic-return instructions vary by finish.';

describe('isFloorReopenQuestion (B0-976)', () => {
  it('matches the golden walk-on question', () => {
    expect(isFloorReopenQuestion(GOLDEN_PROMPT)).toBe(true);
  });

  it.each([
    'When can we reopen the hallway after the final coat of finish?',
    'How long before we can put the carts back on the freshly finished floor?',
    'What is the cure time before foot traffic on new VCT finish?',
    'when is it safe for rolling traffic after we recoat the tile',
    'How soon after the last coat can the floor go back into service?',
  ])('matches reopening phrasing: %s', (message) => {
    expect(isFloorReopenQuestion(message)).toBe(true);
  });

  it.each([
    'How many coats of finish does VCT need?',
    'What dilution should I use to strip a VCT floor?',
    'When can we reopen the store after the flood?',
    'What should I use on VCT floors?',
    '',
  ])('does not match non-reopening messages: %s', (message) => {
    expect(isFloorReopenQuestion(message)).toBe(false);
  });
});

describe('draftStatesTimingFigure (B0-976)', () => {
  it.each([
    'Light foot traffic is usually fine after 30-60 minutes per the reopening document.',
    'Allow 24 hours before rolling loads.',
    'Wait overnight before heavy traffic.',
    'Normal foot traffic after 2 to 4 hours.',
  ])('detects a timing figure: %s', (draft) => {
    expect(draftStatesTimingFigure(draft)).toBe(true);
  });

  it('does not treat the withholding draft as a schedule', () => {
    expect(draftStatesTimingFigure(WITHHOLDING_DRAFT)).toBe(false);
  });

  it('does not treat a coat count or a percentage as a timing figure', () => {
    expect(draftStatesTimingFigure('Apply 4 coats of finish at 25% solids.')).toBe(false);
  });
});

describe('requireFloorReopenTool (B0-976)', () => {
  const base = {
    userMessage: GOLDEN_PROMPT,
    effectivePromptId: 'floor_vct',
    draftAnswer: WITHHOLDING_DRAFT,
    toolNames: ['search_product_docs'],
  };

  it('forces get_floor_asset for the golden prompt when the draft withholds the schedule', () => {
    const decision = requireFloorReopenTool(base);
    expect(decision?.toolName).toBe('get_floor_asset');
    expect(decision?.category).toBe('floor_reopen_timing');
    expect(decision?.instruction).toContain(FLOOR_REOPEN_PROCEDURE_QUERY);
  });

  it('applies on every floor substrate route', () => {
    for (const route of ['floor_wood_sport', 'floor_concrete', 'floor_stg', 'floor_vct']) {
      expect(requireFloorReopenTool({ ...base, effectivePromptId: route })?.toolName).toBe(
        'get_floor_asset',
      );
    }
  });

  it('never fires outside the floor routes', () => {
    for (const route of ['product', 'bathroom', 'dilution', 'recommendations', 'cross_reference']) {
      expect(requireFloorReopenTool({ ...base, effectivePromptId: route })).toBeNull();
    }
    expect(requireFloorReopenTool({ ...base, effectivePromptId: null })).toBeNull();
  });

  it('is satisfied once get_floor_asset was called this turn', () => {
    expect(
      requireFloorReopenTool({ ...base, toolNames: ['search_product_docs', 'get_floor_asset'] }),
    ).toBeNull();
  });

  it('does not fire when the draft already states a timing figure', () => {
    expect(
      requireFloorReopenTool({
        ...base,
        draftAnswer: 'Per the VCT reopening document, light foot traffic after 30-60 minutes.',
      }),
    ).toBeNull();
  });

  it('does not fire for a non-reopening floor question or an empty draft', () => {
    expect(
      requireFloorReopenTool({ ...base, userMessage: 'How many coats does VCT need?' }),
    ).toBeNull();
    expect(requireFloorReopenTool({ ...base, draftAnswer: '   ' })).toBeNull();
  });
});

describe('buildFloorReopenInstruction (B0-976)', () => {
  it('is additive, attributes to the knowledge document, offers (not requires) the label check, and embeds no figure', () => {
    const instruction = buildFloorReopenInstruction();
    expect(instruction).toContain('`get_floor_asset`');
    expect(instruction).toContain('exactly as written');
    expect(instruction).toMatch(/Offer — do not require/);
    expect(instruction).toMatch(/Do not ask a clarifying question/);
    expect(instruction).toMatch(/never estimate a time/);
    // Regulated-data rule: the instruction names where the schedule lives, never a value.
    expect(instruction).not.toMatch(/\d+\s*(minutes?|hours?|days?)/i);
  });
});
