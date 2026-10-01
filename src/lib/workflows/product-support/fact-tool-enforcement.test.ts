import type OpenAI from 'openai';
import type { Response, Tool } from 'openai/resources/responses/responses';
import { describe, expect, it, vi } from 'vitest';

import { runResponsesWithToolLoop } from '~/lib/openai/responses-runtime';
import {
  buildFactToolEnforcementInstruction,
  detectDraftFactCategories,
  requireFactToolForDraft,
} from '~/lib/workflows/product-support/fact-tool-enforcement';
import type { ToolTraceEntry } from '~/lib/audit/trace';

/**
 * B0-948 — "call at least one retrieval tool" is satisfied by the first `search_product_docs` call
 * and nothing downstream re-checks, so the dedicated fact tools were never called. These cases pin
 * the category → tool policy and the Responses loop's one forced round-trip.
 * `fact-tool-enforcement-ai-sdk.test.ts` mirrors the loop half for the AI SDK runtime.
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

/* -------------------------------------------------------------------------- *
 * The Responses loop's half: one forced `tool_choice` pin, then a re-draft.
 * -------------------------------------------------------------------------- */

type StubResponse = {
  id: string;
  output: Array<Record<string, unknown>>;
  output_text?: string;
};

function stubClient(responses: StubResponse[]) {
  const create = vi.fn(async (params: unknown) => {
    void params;
    const next = responses.shift();
    if (!next) {
      throw new Error('stub client ran out of responses');
    }
    return next as unknown as Response;
  });
  return { client: { responses: { create } } as unknown as OpenAI, create };
}

const functionTool = (name: string): Tool => ({
  type: 'function',
  name,
  description: name,
  parameters: { type: 'object', properties: {}, required: [] },
  strict: false,
});

const trace = (name: string, ok = true): ToolTraceEntry => ({
  toolName: name,
  callId: `call_${name}`,
  argumentsPreview: '',
  outputPreview: '',
  ok,
  durationMs: 0,
});

const answered = (id: string, text: string): StubResponse => ({ id, output: [], output_text: text });

const calling = (id: string, name: string): StubResponse => ({
  id,
  output: [{ type: 'function_call', call_id: `call_${name}`, name, arguments: '{}' }],
});

const offeredTools = [
  functionTool('search_product_docs'),
  functionTool('list_allowed_surfaces'),
  functionTool('get_efficacy_data'),
];

const paramsOf = (create: ReturnType<typeof stubClient>['create'], index: number) =>
  (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[index]![0];

describe('runResponsesWithToolLoop — fact-tool enforcement (B0-948)', () => {
  it('forces the owning tool and re-drafts when the draft claims a surface it never looked up', async () => {
    const { client, create } = stubClient([
      calling('resp_1', 'search_product_docs'),
      answered('resp_2', `Betco offers several strippers. ${COMPAT_SENTENCE}`),
      calling('resp_3', 'list_allowed_surfaces'),
      answered('resp_4', 'Rewritten against the approved-surface list.'),
    ]);
    const onFactToolEnforced = vi.fn();

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: offeredTools,
      userMessage: 'What is the strongest wood floor stripper?',
      requireFactTool: requireFactToolForDraft,
      onFactToolEnforced,
      executeTool: async ({ name }) => ({ output: '{"ok":true}', trace: trace(name) }),
    });

    expect(create).toHaveBeenCalledTimes(4);
    // The forced round is pinned to the tool that owns the claim…
    expect(paramsOf(create, 2).tool_choice).toEqual({
      type: 'function',
      name: 'list_allowed_surfaces',
    });
    // …and carries ONLY the instruction (the chain already holds everything else).
    expect(JSON.stringify(paramsOf(create, 2).input)).toContain('list_allowed_surfaces');
    expect(JSON.stringify(paramsOf(create, 2).input)).not.toContain('strongest wood floor stripper');
    // The re-draft is what the turn returns.
    expect(result.assistantText).toBe('Rewritten against the approved-surface list.');
    expect(result.toolTrace.map((entry) => entry.toolName)).toEqual([
      'search_product_docs',
      'list_allowed_surfaces',
    ]);
    expect(onFactToolEnforced).toHaveBeenCalledTimes(1);
    expect(onFactToolEnforced.mock.calls[0]?.[0]).toEqual({
      requiredTool: 'list_allowed_surfaces',
      enforced: true,
      toolSucceeded: true,
      // B0-984 — the first draft travels with the outcome so the run report can diff it.
      preEnforcementDraft: expect.any(String),
    });
  });

  it('finalizes unchanged when the owning tool was already called', async () => {
    const { client, create } = stubClient([
      calling('resp_1', 'list_allowed_surfaces'),
      answered('resp_2', `Betco offers several strippers. ${COMPAT_SENTENCE}`),
    ]);
    const onFactToolEnforced = vi.fn();

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: offeredTools,
      userMessage: 'What is the strongest wood floor stripper?',
      requireFactTool: requireFactToolForDraft,
      onFactToolEnforced,
      executeTool: async ({ name }) => ({ output: '{"ok":true}', trace: trace(name) }),
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.assistantText).toContain(COMPAT_SENTENCE);
    expect(onFactToolEnforced.mock.calls[0]?.[0]).toEqual({
      requiredTool: null,
      enforced: false,
      toolSucceeded: null,
    });
  });

  it('never forces twice — a model that ignores the pin ends the turn on its draft', async () => {
    const { client, create } = stubClient([
      answered('resp_1', COMPAT_SENTENCE),
      answered('resp_2', `Still ungrounded. ${COMPAT_SENTENCE}`),
    ]);
    const onFactToolEnforced = vi.fn();

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: offeredTools,
      userMessage: 'Can this go on linoleum?',
      requireFactTool: requireFactToolForDraft,
      onFactToolEnforced,
      executeTool: async ({ name }) => ({ output: '{"ok":true}', trace: trace(name) }),
    });

    // One forced round-trip, then the loop stops — never a second pin on the same turn.
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.assistantText).toBe(`Still ungrounded. ${COMPAT_SENTENCE}`);
    expect(onFactToolEnforced).toHaveBeenCalledTimes(1);
    expect(onFactToolEnforced.mock.calls[0]?.[0]).toMatchObject({
      requiredTool: 'list_allowed_surfaces',
      enforced: false,
      reason: 'model_declined_call',
    });
  });

  it('leaves the draft alone when this route does not offer the owning tool', async () => {
    const { client, create } = stubClient([answered('resp_1', COMPAT_SENTENCE)]);
    const onFactToolEnforced = vi.fn();

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [functionTool('search_product_docs')],
      userMessage: 'Can this go on linoleum?',
      requireFactTool: requireFactToolForDraft,
      onFactToolEnforced,
      executeTool: async ({ name }) => ({ output: '{"ok":true}', trace: trace(name) }),
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(onFactToolEnforced.mock.calls[0]?.[0]).toMatchObject({
      requiredTool: 'list_allowed_surfaces',
      enforced: false,
      reason: 'tool_not_offered',
    });
  });

  it('is inert for a caller that supplies no policy (every pre-B0-948 call site)', async () => {
    const { client, create } = stubClient([answered('resp_1', COMPAT_SENTENCE)]);

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: offeredTools,
      userMessage: 'Can this go on linoleum?',
      executeTool: async ({ name }) => ({ output: '{"ok":true}', trace: trace(name) }),
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.assistantText).toBe(COMPAT_SENTENCE);
  });

  it('reports the forced call as failed when the tool errored, and still returns an answer', async () => {
    const { client } = stubClient([
      answered('resp_1', COMPAT_SENTENCE),
      calling('resp_2', 'list_allowed_surfaces'),
      answered('resp_3', 'The approved-surface list is not on file for this product.'),
    ]);
    const onFactToolEnforced = vi.fn();

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: offeredTools,
      userMessage: 'Can this go on linoleum?',
      requireFactTool: requireFactToolForDraft,
      onFactToolEnforced,
      executeTool: async ({ name }) => ({
        output: '{"ok":false}',
        trace: trace(name, false),
      }),
    });

    expect(onFactToolEnforced.mock.calls[0]?.[0]).toEqual({
      requiredTool: 'list_allowed_surfaces',
      enforced: true,
      toolSucceeded: false,
      // B0-984 — the first draft travels with the outcome so the run report can diff it.
      preEnforcementDraft: expect.any(String),
    });
    expect(result.assistantText).toBe(
      'The approved-surface list is not on file for this product.',
    );
  });
});
