import { describe, expect, it } from 'vitest';

import { readRunPayloadView } from '~/lib/observability/run-payload';

describe('readRunPayloadView', () => {
  it('reports every field as absent for a run with no final_output', () => {
    const view = readRunPayloadView(null, null);

    expect(view).toEqual({
      answerText: null,
      error: null,
      validation: null,
      usage: null,
      timing: null,
      similarity: null,
      chunks: [],
      modelTag: null,
      // B0-358 — absent means UNKNOWN verification level, never "validated".
      validatorMode: null,
      activeGates: null,
    });
  });

  it('reads the B0-358 validator mode and gate activation off a payload that carries them', () => {
    const view = readRunPayloadView(
      {
        answerText: 'ok',
        validatorMode: 'bypassed',
        activeGates: {
          validator: { state: 'skipped', reason: 'disabled_by_flag' },
          earlyDeclineGate: { state: 'ran', verdict: 'passed' },
          usageSafetyCoverage: { state: 'not_applicable' },
          regulatedClaimGuardrail: { state: 'ran', verdict: 'passed' },
          recommendationConfidence: { state: 'not_applicable' },
        },
      },
      null,
    );

    expect(view.validatorMode).toBe('bypassed');
    // The guardrail that RAN AND PASSED is distinguishable from the ones that never ran.
    expect(view.activeGates?.regulatedClaimGuardrail).toEqual({
      state: 'ran',
      verdict: 'passed',
    });
    expect(view.activeGates?.usageSafetyCoverage).toEqual({ state: 'not_applicable' });
  });

  it('reports an unknown validatorMode as absent rather than coercing it', () => {
    expect(readRunPayloadView({ validatorMode: 'sort_of' }, null).validatorMode).toBeNull();
  });

  it('reads an error-only payload without treating it as an answer', () => {
    const view = readRunPayloadView(
      { error: 'TypeError: fetch failed' },
      { message: 'hi', modelTag: 'preview' },
    );

    expect(view.error).toBe('TypeError: fetch failed');
    expect(view.answerText).toBeNull();
    expect(view.validation).toBeNull();
    expect(view.usage).toBeNull();
    expect(view.modelTag).toBe('preview');
  });

  it('reads answer, similarity, timing, validation and usage off a full payload', () => {
    const view = readRunPayloadView(
      {
        answerText: '## Answer\n\nUse 2 oz/gal.',
        sources: [
          { documentId: 'd1', title: 't', snippet: 's', similarity: 0.4 },
          { documentId: 'd2', title: 't', snippet: 's', similarity: 0.8 },
        ],
        retrieved_document_chunks: [{ document_id: 'd1', chunk_id: 'c1' }],
        timingBreakdown: { toolRounds: 2, cacheSource: null, searchMs: 12.5 },
        validation: {
          approved: false,
          confidence: 0.4,
          issues: ['regulated_claim_unverified:epa_registration'],
          requires_human_review: true,
        },
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          cachedPromptTokens: 64,
        },
      },
      { modelTag: 'gpt-5' },
    );

    expect(view.answerText).toBe('## Answer\n\nUse 2 oz/gal.');
    expect(view.similarity).toEqual({ min: 0.4, max: 0.8, avg: 0.6000000000000001 });
    expect(view.timing).toEqual({ toolRounds: 2, cacheSource: null, searchMs: 12.5 });
    expect(view.validation?.requires_human_review).toBe(true);
    expect(view.usage?.totalTokens).toBe(120);
    expect(view.chunks).toHaveLength(1);
  });

  it('keeps usage absent (not zeroed) when the run predates token accounting', () => {
    const view = readRunPayloadView(
      { answerText: 'ok', timingBreakdown: { toolRounds: 0, cacheSource: null, searchMs: null } },
      {},
    );

    expect(view.usage).toBeNull();
    expect(view.timing).toEqual({ toolRounds: 0, cacheSource: null, searchMs: null });
    expect(view.similarity).toBeNull();
    expect(view.chunks).toEqual([]);
  });
});
