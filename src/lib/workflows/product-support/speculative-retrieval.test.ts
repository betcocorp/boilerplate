import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolTraceEntry } from '~/lib/audit/trace';
import { formatPreloadedEvidence } from '~/lib/openai/responses-runtime';
import { PRODUCT_SUPPORT_SHARED_INSTRUCTIONS } from '~/lib/workflows/product-support/product-support-prompts';
import { searchProductDocsInputSchema } from '~/lib/tools/tool-schemas';
import {
  buildPreloadedEvidence,
  buildSpeculativeSearchArgumentsJson,
  canReuseSpeculativeSearch,
  classifySpeculativeRetrievalSkip,
  createSpeculativeReuseExecutor,
  looksLikeExactEfficacyQuestion,
  runSpeculativeRetrieval,
} from '~/lib/workflows/product-support/speculative-retrieval';

const USER_MESSAGE = 'What dilution ratio does Norinse Floor Cleaner use?';

function trace(overrides: Partial<ToolTraceEntry> = {}): ToolTraceEntry {
  return {
    toolName: 'search_product_docs',
    callId: 'speculative-search-run_1',
    argumentsPreview: '',
    outputPreview: '',
    ok: true,
    durationMs: 120,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('looksLikeExactEfficacyQuestion (B0-788)', () => {
  it.each([
    'What is the dilution ratio for AF315 Disinfectant?',
    'How many oz per gallon should I use for TOP FLITE?',
    'What is the mL/L dilution for pH7Q?',
    'What is the contact time for disinfection?',
    'What is the required dwell time on this surface?',
    'What does this product kill? Give me the kill claim.',
    'What log reduction does this achieve against E. coli?',
    'What is the EPA registration number and efficacy data?',
    'How many gallons do I get from a 2-liter FastDraw bottle of pH7 ULTRA?',
    'What is the gallon yield from a 2-liter FastDraw bottle?',
    'How many gallons does a 2-liter FastDraw bottle of EXTREME ULTRA Floor Stripper make?',
  ])('matches an exact fact-shaped question: %s', (message) => {
    expect(looksLikeExactEfficacyQuestion(message)).toBe(true);
  });

  it.each([
    'How do I install a FastDraw dispenser?',
    'What surfaces is this floor finish approved for?',
    'How many coats of finish do I need?',
    'Tell me about your green cleaning products.',
  ])('does not match a non-fact-shaped question: %s', (message) => {
    expect(looksLikeExactEfficacyQuestion(message)).toBe(false);
  });
});

describe('classifySpeculativeRetrievalSkip (B0-436)', () => {
  it('speculates on the ordinary product / ambiguous routes', () => {
    for (const routingDecision of [
      'product',
      'ambiguous',
      'bathroom',
      'dilution',
      'floor_wood_sport',
      'floor_concrete',
      'floor_stg',
      'floor_vct',
      'recommendations',
    ]) {
      expect(
        classifySpeculativeRetrievalSkip({
          userMessage: USER_MESSAGE,
          forcedCrossReference: false,
          routingDecision,
        }),
      ).toBeNull();
    }
  });

  it('skips the forced cross-reference path so today’s behaviour is untouched', () => {
    expect(
      classifySpeculativeRetrievalSkip({
        userMessage: 'What is the Betco equivalent alternative to Spartan BNC-15?',
        forcedCrossReference: true,
        routingDecision: 'product',
      }),
    ).toBe('forced_cross_reference');
  });

  it('skips the cross_reference route, where lookup_cross_reference must come first', () => {
    expect(
      classifySpeculativeRetrievalSkip({
        userMessage: USER_MESSAGE,
        forcedCrossReference: false,
        routingDecision: 'cross_reference',
      }),
    ).toBe('cross_reference_route');
  });

  it('skips an empty message', () => {
    expect(
      classifySpeculativeRetrievalSkip({
        userMessage: '   ',
        forcedCrossReference: false,
        routingDecision: 'product',
      }),
    ).toBe('empty_message');
  });

  it('skips entirely when BEX_SPECULATIVE_RETRIEVAL=false', () => {
    vi.stubEnv('BEX_SPECULATIVE_RETRIEVAL', 'false');
    expect(
      classifySpeculativeRetrievalSkip({
        userMessage: USER_MESSAGE,
        forcedCrossReference: false,
        routingDecision: 'product',
      }),
    ).toBe('flag_disabled');
  });

  it('is enabled by default and for any value other than the literal "false"', () => {
    vi.stubEnv('BEX_SPECULATIVE_RETRIEVAL', 'true');
    expect(
      classifySpeculativeRetrievalSkip({
        userMessage: USER_MESSAGE,
        forcedCrossReference: false,
        routingDecision: 'product',
      }),
    ).toBeNull();
  });
});

describe('buildSpeculativeSearchArgumentsJson (B0-436)', () => {
  it('produces arguments the existing tool schema already accepts (no schema change needed)', () => {
    const parsed = searchProductDocsInputSchema.safeParse(
      JSON.parse(buildSpeculativeSearchArgumentsJson(USER_MESSAGE)) as unknown,
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.freeformQuery).toBe(USER_MESSAGE);
  });
});

describe('canReuseSpeculativeSearch (B0-436)', () => {
  const reuse = (args: Record<string, unknown>, toolName = 'search_product_docs') =>
    canReuseSpeculativeSearch({
      toolName,
      argumentsJson: JSON.stringify(args),
      userMessage: USER_MESSAGE,
    });

  it('reuses an identical freeform query', () => {
    expect(reuse({ freeformQuery: USER_MESSAGE })).toBe(true);
  });

  it('reuses a query that differs only by case and whitespace', () => {
    expect(reuse({ freeformQuery: `  what DILUTION   ratio does Norinse Floor Cleaner use?  ` })).toBe(
      true,
    );
  });

  it('reuses a topic-only call carrying the same text', () => {
    expect(reuse({ topic: USER_MESSAGE })).toBe(true);
  });

  it('reuses an empty-argument call, which would otherwise be a hard schema rejection', () => {
    expect(reuse({})).toBe(true);
    expect(
      canReuseSpeculativeSearch({
        toolName: 'search_product_docs',
        argumentsJson: '',
        userMessage: USER_MESSAGE,
      }),
    ).toBe(true);
  });

  it('does NOT reuse a different query', () => {
    expect(reuse({ freeformQuery: 'is Norinse Floor Cleaner flammable?' })).toBe(false);
  });

  it('does NOT reuse when the model narrowed the search', () => {
    expect(reuse({ freeformQuery: USER_MESSAGE, productName: 'Norinse Floor Cleaner' })).toBe(false);
    expect(reuse({ freeformQuery: USER_MESSAGE, surfaceType: 'VCT' })).toBe(false);
    expect(reuse({ freeformQuery: USER_MESSAGE, topic: 'dilution' })).toBe(false);
  });

  it('does NOT reuse for a different tool', () => {
    expect(reuse({ freeformQuery: USER_MESSAGE }, 'get_efficacy_data')).toBe(false);
  });

  it('does NOT reuse when the arguments are not parseable JSON', () => {
    expect(
      canReuseSpeculativeSearch({
        toolName: 'search_product_docs',
        argumentsJson: '{"freeformQuery":',
        userMessage: USER_MESSAGE,
      }),
    ).toBe(false);
  });
});

describe('runSpeculativeRetrieval (B0-436)', () => {
  /**
   * The audit / `toolOutputLog` guarantee: the speculative call goes through the workflow's own
   * `executeTool` closure, so the same bookkeeping runs for it as for a model-requested call.
   * This mirrors that closure's recording contract.
   */
  function recordingExecutor() {
    const log: Array<{ toolName: string; ok: boolean; output: string; trace: ToolTraceEntry }> = [];
    const execute = vi.fn(
      async (call: {
        name: string;
        argumentsJson: string;
        callId: string;
        speculative?: boolean;
      }) => {
        const out = {
          output: JSON.stringify({ ok: true, sources: [{ documentId: 'doc-1' }] }),
          trace: trace({
            callId: call.callId,
            argumentsPreview: call.argumentsJson,
            ...(call.speculative ? { speculative: true } : {}),
          }),
        };
        log.push({
          toolName: out.trace.toolName,
          ok: out.trace.ok,
          output: out.output,
          trace: out.trace,
        });
        return out;
      },
    );
    return { log, execute };
  }

  it('runs search_product_docs through the caller’s closure, landing in toolOutputLog', async () => {
    const { log, execute } = recordingExecutor();

    const outcome = await runSpeculativeRetrieval({
      userMessage: USER_MESSAGE,
      routingDecision: 'product',
      forcedCrossReference: false,
      callId: 'speculative-search-run_1',
      execute,
    });

    expect(outcome.skippedReason).toBeNull();
    expect(outcome.result).not.toBeNull();
    expect(execute).toHaveBeenCalledWith({
      name: 'search_product_docs',
      argumentsJson: buildSpeculativeSearchArgumentsJson(USER_MESSAGE),
      callId: 'speculative-search-run_1',
      speculative: true,
    });
    // The evidence the validator / regulated-claim guardrail read is the logged FULL output.
    expect(log).toHaveLength(1);
    expect(log[0]?.output).toContain('doc-1');
    expect(log[0]?.trace.speculative).toBe(true);
  });

  it('does not run a search at all when the run is skipped', async () => {
    const { log, execute } = recordingExecutor();

    const outcome = await runSpeculativeRetrieval({
      userMessage: USER_MESSAGE,
      routingDecision: 'product',
      forcedCrossReference: true,
      callId: 'speculative-search-run_1',
      execute,
    });

    expect(outcome).toEqual({ skippedReason: 'forced_cross_reference', result: null });
    expect(execute).not.toHaveBeenCalled();
    expect(log).toHaveLength(0);
  });
});

describe('createSpeculativeReuseExecutor (B0-436)', () => {
  const speculative = {
    output: JSON.stringify({ ok: true, sources: [{ documentId: 'doc-1' }] }),
    trace: trace({ speculative: true }),
  };

  it('serves a matching model call from the speculative result without re-querying RAG', async () => {
    const execute = vi.fn(async () => ({ output: '{}', trace: trace() }));
    const onReuse = vi.fn();
    const wrapped = createSpeculativeReuseExecutor({
      speculative,
      userMessage: USER_MESSAGE,
      execute,
      onReuse,
    });

    const result = await wrapped({
      name: 'search_product_docs',
      argumentsJson: JSON.stringify({ freeformQuery: USER_MESSAGE }),
      callId: 'call_model_1',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(onReuse).toHaveBeenCalledTimes(1);
    expect(result.output).toBe(speculative.output);
    // Honest trace: the model's own call id, marked as served from the speculative run.
    expect(result.trace.callId).toBe('call_model_1');
    expect(result.trace.reusedSpeculativeResult).toBe(true);
    expect(result.trace.speculative).toBeUndefined();
  });

  it('runs the tool for real when the model asks a different question', async () => {
    const execute = vi.fn(async () => ({ output: '{"real":true}', trace: trace() }));
    const wrapped = createSpeculativeReuseExecutor({
      speculative,
      userMessage: USER_MESSAGE,
      execute,
    });

    const result = await wrapped({
      name: 'search_product_docs',
      argumentsJson: JSON.stringify({ freeformQuery: 'PPE for Norinse Floor Cleaner' }),
      callId: 'call_model_2',
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.output).toBe('{"real":true}');
  });

  it('never reuses a failed speculative search', async () => {
    const execute = vi.fn(async () => ({ output: '{"real":true}', trace: trace() }));
    const wrapped = createSpeculativeReuseExecutor({
      speculative: {
        output: JSON.stringify({ ok: false, error: 'embedding failed' }),
        trace: trace({ ok: false, speculative: true }),
      },
      userMessage: USER_MESSAGE,
      execute,
    });

    await wrapped({
      name: 'search_product_docs',
      argumentsJson: JSON.stringify({ freeformQuery: USER_MESSAGE }),
      callId: 'call_model_3',
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('is a pass-through when nothing was speculated', async () => {
    const execute = vi.fn(async () => ({ output: '{"real":true}', trace: trace() }));
    const wrapped = createSpeculativeReuseExecutor({
      speculative: null,
      userMessage: USER_MESSAGE,
      execute,
    });

    await wrapped({
      name: 'search_product_docs',
      argumentsJson: JSON.stringify({ freeformQuery: USER_MESSAGE }),
      callId: 'call_model_4',
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('buildPreloadedEvidence (B0-436)', () => {
  it('labels the block with the search that produced it and carries the payload verbatim', () => {
    const evidence = buildPreloadedEvidence({
      userMessage: USER_MESSAGE,
      output: '{"ok":true,"sources":[]}',
    });

    expect(evidence.label).toContain('search_product_docs');
    expect(evidence.label).toContain(USER_MESSAGE);
    expect(evidence.text).toBe('{"ok":true,"sources":[]}');
  });
});

describe('preloaded evidence satisfies the mandatory-retrieval rule (B0-436)', () => {
  it('the prompt names the exact heading the runtimes emit', () => {
    const rendered = formatPreloadedEvidence(
      buildPreloadedEvidence({ userMessage: USER_MESSAGE, output: '{}' }),
    );
    const heading = '## Retrieved evidence (pre-fetched)';

    // If either side of this pair is renamed without the other, the model reads the mandatory
    // retrieval rule as unsatisfied and burns the round B0-436 exists to remove.
    expect(rendered).toContain(heading);
    expect(PRODUCT_SUPPORT_SHARED_INSTRUCTIONS).toContain(heading);
    // ...and the block must state plainly that it IS the required retrieval, not a hint to retrieve.
    expect(rendered).toContain('This IS the mandatory retrieval call');
  });
});
