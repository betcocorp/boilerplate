import { describe, expect, it } from 'vitest';

import {
  buildFactToolEnforcementInstruction,
  detectDraftFactCategories,
  requireFactToolForDraft,
} from '~/lib/workflows/product-support/fact-tool-enforcement';

/**
 * B0-948 — "call at least one retrieval tool" is satisfied by the first `search_product_docs` call
 * and nothing downstream re-checks, so the dedicated fact tools were never called. These cases pin
 * the category → tool policy. `fact-tool-enforcement-ai-sdk.test.ts` covers the loop half: the one
 * forced round-trip on the AI SDK runtime.
 */

/** The live sentence from golden run 61e80e45 row 2 that the guardrail could not verify. */
const COMPAT_SENTENCE =
  'The product is suitable for use on all types of resilient tile, including vinyl composition, vinyl, and linoleum.';
const CONTACT_TIME_SENTENCE = 'Allow a 10 minute contact time for disinfection.';

describe('detectDraftFactCategories (B0-948)', () => {
  it('reports the compatibility category for an approved-surface claim', () => {
    expect(detectDraftFactCategories(COMPAT_SENTENCE)).toContain('compatibility');
  });

  it('reports the contact_time category for a dwell-time claim', () => {
    expect(detectDraftFactCategories(CONTACT_TIME_SENTENCE)).toContain('contact_time');
  });

  it('reports storage_shelf_life only for an actual shelf-life / storage claim', () => {
    expect(detectDraftFactCategories('The shelf life is two years from the date of manufacture.')).toContain(
      'storage_shelf_life',
    );
    expect(
      detectDraftFactCategories('Store at temperatures between 40F and 100F.'),
    ).toContain('storage_shelf_life');
    // A passing mention of the topic is not a claim and must not force a tool call.
    expect(
      detectDraftFactCategories('Betco publishes storage and handling guidance for every product.'),
    ).not.toContain('storage_shelf_life');
  });

  it('reports nothing for a plain descriptive answer', () => {
    expect(
      detectDraftFactCategories('Hard As Nails is a Basic Coatings wood floor product.'),
    ).toEqual([]);
  });

  // The runtime hands over the RAW draft, so the B0-491 self-confidence marker is still attached
  // (the workflow strips it only after the runtime returns). It must not read as a claim.
  it('is not tripped by the B0-491 agent-confidence marker', () => {
    const marker =
      '\n<!--BEX_AGENT_CONFIDENCE {"agentConfidence":0.82,"agentConfidenceBasis":"retrieved_evidence","reason":"label retrieved"}-->';
    expect(
      detectDraftFactCategories(
        `Hard As Nails is a Basic Coatings wood floor product.${marker}`,
      ),
    ).toEqual([]);
  });
});

describe('requireFactToolForDraft (B0-948)', () => {
  it('demands list_allowed_surfaces when the draft makes a surface claim and only searched', () => {
    const decision = requireFactToolForDraft({
      draftAnswer: COMPAT_SENTENCE,
      toolNames: ['search_product_docs'],
    });
    expect(decision?.toolName).toBe('list_allowed_surfaces');
    expect(decision?.category).toBe('compatibility');
    expect(decision?.instruction).toBe(
      buildFactToolEnforcementInstruction({
        toolName: 'list_allowed_surfaces',
        category: 'compatibility',
      }),
    );
  });

  it('is satisfied by either tool that owns the category', () => {
    for (const called of ['list_allowed_surfaces', 'get_compatibility_rules']) {
      expect(
        requireFactToolForDraft({
          draftAnswer: COMPAT_SENTENCE,
          toolNames: ['search_product_docs', called],
        }),
      ).toBeNull();
    }
  });

  it('never lets the generic semantic search satisfy a requirement', () => {
    expect(
      requireFactToolForDraft({
        draftAnswer: CONTACT_TIME_SENTENCE,
        toolNames: ['search_product_docs', 'search_product_docs'],
      })?.toolName,
    ).toBe('get_efficacy_data');
  });

  it('routes each fact category to the tool that owns it', () => {
    const cases: Array<[string, string]> = [
      [CONTACT_TIME_SENTENCE, 'get_efficacy_data'],
      ['Dilute at 2 oz per gallon of water.', 'get_efficacy_data'],
      [COMPAT_SENTENCE, 'list_allowed_surfaces'],
      ['The shelf life is two years from the date of manufacture.', 'get_safety_constraints'],
      ['EPA Reg. No. 1677-129 applies to this product.', 'get_product_spec'],
    ];
    for (const [draftAnswer, toolName] of cases) {
      expect(
        requireFactToolForDraft({ draftAnswer, toolNames: ['search_product_docs'] })?.toolName,
        draftAnswer,
      ).toBe(toolName);
    }
  });

  // B0-984 — a compatibility claim in an answer where no Betco product resolved this turn has
  // nothing for `list_allowed_surfaces` to look up (the forced call on "3M Game Line Tape" and
  // "dilution control" returned unrelated product-line profiles and the re-draft opened with
  // "not on file"), so the requirement is skipped. Other categories are unaffected.
  it('skips the compatibility requirement when no product resolved this turn', () => {
    expect(
      requireFactToolForDraft({
        draftAnswer: COMPAT_SENTENCE,
        toolNames: ['search_product_docs'],
        context: { productResolved: false },
      }),
    ).toBeNull();
    expect(
      requireFactToolForDraft({
        draftAnswer: CONTACT_TIME_SENTENCE,
        toolNames: ['search_product_docs'],
        context: { productResolved: false },
      })?.toolName,
    ).toBe('get_efficacy_data');
    expect(
      requireFactToolForDraft({
        draftAnswer: COMPAT_SENTENCE,
        toolNames: ['search_product_docs'],
        context: { productResolved: true },
      })?.toolName,
    ).toBe('list_allowed_surfaces');
  });

  // B0-984 — the forced round is additive: the instruction must tell the model to keep its draft
  // and never to open with a non-finding.
  it('instructs an additive edit, never a rewrite that leads with "not on file"', () => {
    const instruction = buildFactToolEnforcementInstruction({
      toolName: 'get_efficacy_data',
      category: 'contact_time',
    });
    expect(instruction).toContain('return your draft answer again with these edits only');
    expect(instruction).toContain('return the draft unchanged and append one closing sentence');
    expect(instruction).toContain('do not lead with what is not on file');
    expect(instruction).not.toContain('rewrite your answer');
  });

  it('demands nothing for an empty or purely descriptive draft', () => {
    expect(requireFactToolForDraft({ draftAnswer: '   ', toolNames: [] })).toBeNull();
    expect(
      requireFactToolForDraft({
        draftAnswer: 'Hard As Nails is a Basic Coatings wood floor product.',
        toolNames: [],
      }),
    ).toBeNull();
  });
});
