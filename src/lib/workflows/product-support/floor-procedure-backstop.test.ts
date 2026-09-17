import { describe, expect, it } from 'vitest';

import {
  FLOOR_VCT_PROCEDURE_QUERIES,
  FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT,
} from '~/lib/agents/floor-specialist/floor-vct-specialist-system-prompt';
import {
  FLOOR_PROCEDURE_ENTRIES,
  draftDefersForProductIdentity,
  matchFloorProcedureEntry,
  requireFloorProcedureTool,
} from '~/lib/workflows/product-support/floor-procedure-backstop';
import { FLOOR_REOPEN_PROCEDURE_QUERY } from '~/lib/workflows/product-support/floor-reopen-backstop';

/**
 * B0-1031 — the four failing items of VCT Top 20 run `844f8eb3-5f88-461f-a90b-7b35c8eb6622`, with
 * their real `workflow_runs.user_input.message` text and the real opening lines of the answers that
 * scored 59 / 35 / 22.
 */
const STRIP_FAILURE_PROMPT = "Why didn't all the finish come off when I stripped the VCT floor?";
const STRIPPER_DWELL_PROMPT = 'How long should VCT stripper dwell before I start scrubbing?';
const POWDERING_PROMPT = 'the VCT finish is turning to white powder and flaking off';

const STRIP_FAILURE_DRAFT =
  'What exact stripper name or item number did you use? The product must be identified before comparing your process with its label.';
const STRIPPER_DWELL_DRAFT =
  'Which Betco VCT stripper are you using? Please provide the exact product name or item number, because dwell time is product-specific and should follow that stripper’s label.';
const POWDERING_DRAFT =
  'White powder and flaking indicate an adhesion or film-integrity failure, but the exact Betco finish must be identified before comparing the application and maintenance process to its label. What is the finish name or item number on the container?';

describe('draftDefersForProductIdentity (B0-1031)', () => {
  it.each([
    ['stripping failure', STRIP_FAILURE_DRAFT],
    ['stripper dwell', STRIPPER_DWELL_DRAFT],
    ['powdering/flaking', POWDERING_DRAFT],
  ])('detects the %s deferral from run 844f8eb3', (_label, draft) => {
    expect(draftDefersForProductIdentity(draft)).toBe(true);
  });

  it('does not treat a complete answer as a deferral', () => {
    expect(
      draftDefersForProductIdentity(
        'Work least-to-most aggressive: dust mop first, then a correctly diluted neutral cleaner with a red pad, then spray buff, then burnish.',
      ),
    ).toBe(false);
  });

  it('does not fire on an answer that merely offers the label check at the end', () => {
    expect(
      draftDefersForProductIdentity(
        'Per the VCT procedure document, keep the stripper wet for the whole dwell. If you tell me which stripper you used I can check its label.',
      ),
    ).toBe(false);
  });
});

describe('matchFloorProcedureEntry (B0-1031)', () => {
  it.each([
    [STRIP_FAILURE_PROMPT, 'floor_stripping_failure'],
    [STRIPPER_DWELL_PROMPT, 'floor_stripper_dwell'],
    [POWDERING_PROMPT, 'floor_finish_appearance_problem'],
    ['How often should we top-scrub the VCT floor?', 'floor_maintenance_frequency'],
    ['How long should VCT finish dry between coats?', 'floor_dry_between_coats'],
  ])('routes %s to %s', (userMessage, category) => {
    expect(matchFloorProcedureEntry({ userMessage, effectivePromptId: 'floor_vct' })?.category).toBe(
      category,
    );
  });

  it('is scoped to floor_vct — sibling substrate routes are untouched by this ticket', () => {
    for (const route of ['floor_wood_sport', 'floor_concrete', 'floor_stg']) {
      expect(
        matchFloorProcedureEntry({ userMessage: STRIPPER_DWELL_PROMPT, effectivePromptId: route }),
      ).toBeNull();
    }
  });

  it('never matches off the floor routes or without floor context', () => {
    expect(
      matchFloorProcedureEntry({ userMessage: STRIPPER_DWELL_PROMPT, effectivePromptId: 'product' }),
    ).toBeNull();
    expect(
      matchFloorProcedureEntry({
        userMessage: 'How long should the disinfectant dwell before I wipe?',
        effectivePromptId: 'floor_vct',
      }),
    ).toBeNull();
  });
});

describe('requireFloorProcedureTool (B0-1031)', () => {
  it.each([
    [STRIP_FAILURE_PROMPT, STRIP_FAILURE_DRAFT, FLOOR_VCT_PROCEDURE_QUERIES.strippingFailure],
    [STRIPPER_DWELL_PROMPT, STRIPPER_DWELL_DRAFT, FLOOR_VCT_PROCEDURE_QUERIES.stripperDwell],
    [POWDERING_PROMPT, POWDERING_DRAFT, FLOOR_VCT_PROCEDURE_QUERIES.finishAppearanceProblem],
  ])('forces get_floor_asset for %s', (userMessage, draftAnswer, procedureQuery) => {
    const decision = requireFloorProcedureTool({
      userMessage,
      draftAnswer,
      effectivePromptId: 'floor_vct',
      // Exactly what the failing runs' toolTrace shows: one speculative semantic search, nothing else.
      toolNames: ['search_product_docs'],
    });
    expect(decision?.toolName).toBe('get_floor_asset');
    expect(decision?.instruction).toContain(`"${procedureQuery}"`);
    expect(decision?.instruction).toContain('verbatim');
  });

  it('is satisfied once get_floor_asset was called this turn', () => {
    expect(
      requireFloorProcedureTool({
        userMessage: STRIPPER_DWELL_PROMPT,
        draftAnswer: STRIPPER_DWELL_DRAFT,
        effectivePromptId: 'floor_vct',
        toolNames: ['search_product_docs', 'get_floor_asset'],
      }),
    ).toBeNull();
  });

  it('never re-drafts an answer that did not defer (B0-984)', () => {
    expect(
      requireFloorProcedureTool({
        userMessage: STRIPPER_DWELL_PROMPT,
        draftAnswer:
          'Per the Betco VCT stripping procedure, allow the documented dwell and keep the stripper wet the whole time.',
        effectivePromptId: 'floor_vct',
        toolNames: ['search_product_docs'],
      }),
    ).toBeNull();
  });

  it('preserves the B0-976 reopen behaviour as the first entry', () => {
    const decision = requireFloorProcedureTool({
      userMessage: 'how soon can people walk on the VCT floor after the last coat?',
      draftAnswer:
        'I need the exact Betco floor-finish name or item number before giving a walk-on time, because cure and traffic-return instructions vary by finish.',
      effectivePromptId: 'floor_vct',
      toolNames: ['search_product_docs'],
    });
    expect(decision?.category).toBe('floor_reopen_timing');
    expect(decision?.instruction).toContain(FLOOR_REOPEN_PROCEDURE_QUERY);
  });

  it('still applies the reopen check on every floor substrate route', () => {
    for (const route of ['floor_wood_sport', 'floor_concrete', 'floor_stg', 'floor_vct']) {
      expect(
        requireFloorProcedureTool({
          userMessage: 'When can we reopen the hallway after the final coat of finish?',
          draftAnswer: 'I need the exact finish name before I can give a walk-on time.',
          effectivePromptId: route,
          toolNames: ['search_product_docs'],
        })?.toolName,
      ).toBe('get_floor_asset');
    }
  });

  it('never fires off the floor routes', () => {
    for (const route of ['product', 'bathroom', 'dilution', 'recommendations', 'cross_reference']) {
      expect(
        requireFloorProcedureTool({
          userMessage: STRIPPER_DWELL_PROMPT,
          draftAnswer: STRIPPER_DWELL_DRAFT,
          effectivePromptId: route,
          toolNames: ['search_product_docs'],
        }),
      ).toBeNull();
    }
  });
});

describe('procedure strings are shared with the prompt, and carry no regulated value (B0-1031)', () => {
  it('every table entry sends the phrase the VCT prompt bullet names', () => {
    for (const entry of FLOOR_PROCEDURE_ENTRIES) {
      expect(Object.values(FLOOR_VCT_PROCEDURE_QUERIES)).toContain(entry.procedureQuery);
      expect(FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT).toContain(`"${entry.procedureQuery}"`);
    }
  });

  it("the reopen module's procedure string and the prompt's reopening bullet stay identical", () => {
    expect(FLOOR_VCT_PROCEDURE_QUERIES.reopenTiming).toBe(FLOOR_REOPEN_PROCEDURE_QUERY);
  });

  it('no instruction embeds a figure', () => {
    for (const entry of FLOOR_PROCEDURE_ENTRIES) {
      expect(entry.instruction).not.toMatch(/\d+\s*(?:minutes?|mins?|hours?|hrs?|days?|%|oz|ml)\b/i);
    }
  });
});
