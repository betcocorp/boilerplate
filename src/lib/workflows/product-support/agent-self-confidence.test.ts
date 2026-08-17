import { describe, expect, it } from 'vitest';

import {
  createAgentConfidenceStreamFilter,
  extractAgentSelfConfidence,
} from '~/lib/workflows/product-support/agent-self-confidence';

const MARKER = (agentConfidence: number, agentConfidenceBasis: string) =>
  `<!--BEX_AGENT_CONFIDENCE {"agentConfidence":${agentConfidence},"agentConfidenceBasis":"${agentConfidenceBasis}"}-->`;

describe('extractAgentSelfConfidence (B0-491)', () => {
  it('parses a valid trailer and strips it from the visible text', () => {
    const raw = `Use 2 oz per gallon of water.\n${MARKER(0.87, 'exact label dilution ratio cited')}`;

    const { text, selfConfidence } = extractAgentSelfConfidence(raw);

    expect(text).toBe('Use 2 oz per gallon of water.');
    expect(selfConfidence).toEqual({
      agentConfidence: 0.87,
      agentConfidenceBasis: 'exact label dilution ratio cited',
      reason: 'reported',
    });
  });

  it('reports not_reported and leaves the text untouched when no marker is present', () => {
    const raw = 'Use 2 oz per gallon of water.';

    const { text, selfConfidence } = extractAgentSelfConfidence(raw);

    expect(text).toBe(raw);
    expect(selfConfidence).toEqual({
      agentConfidence: null,
      agentConfidenceBasis: null,
      reason: 'not_reported',
    });
  });

  it('captures the confidence that drove a decline — the marker still parses on a decline answer', () => {
    const raw = `I don't have the information needed to answer that.\n${MARKER(0.95, 'no retrieved source stated the value')}`;

    const { text, selfConfidence } = extractAgentSelfConfidence(raw);

    expect(text).toBe("I don't have the information needed to answer that.");
    expect(selfConfidence.agentConfidence).toBe(0.95);
    expect(selfConfidence.reason).toBe('reported');
  });

  it('reports malformed and still strips the marker on invalid JSON', () => {
    const raw = 'Answer text.\n<!--BEX_AGENT_CONFIDENCE {not json}-->';

    const { text, selfConfidence } = extractAgentSelfConfidence(raw);

    expect(text).toBe('Answer text.');
    expect(selfConfidence).toEqual({
      agentConfidence: null,
      agentConfidenceBasis: null,
      reason: 'malformed',
    });
  });

  it('reports malformed when agentConfidence is missing or not a number', () => {
    const raw = 'Answer.\n<!--BEX_AGENT_CONFIDENCE {"agentConfidenceBasis":"no score field"}-->';

    const { selfConfidence } = extractAgentSelfConfidence(raw);

    expect(selfConfidence.agentConfidence).toBeNull();
    expect(selfConfidence.reason).toBe('malformed');
    expect(selfConfidence.agentConfidenceBasis).toBe('no score field');
  });

  it('reports out_of_range for a score outside [0, 1], but keeps the basis', () => {
    const raw = `Answer.\n${MARKER(1.4, 'overconfident')}`;

    const { selfConfidence } = extractAgentSelfConfidence(raw);

    expect(selfConfidence).toEqual({
      agentConfidence: null,
      agentConfidenceBasis: 'overconfident',
      reason: 'out_of_range',
    });
  });

  it('drops an opened-but-never-closed marker rather than leak a half-written tag', () => {
    const raw = 'Answer text.\n<!--BEX_AGENT_CONFIDENCE {"agentConfidence":0.9';

    const { text, selfConfidence } = extractAgentSelfConfidence(raw);

    expect(text).toBe('Answer text.');
    expect(selfConfidence.reason).toBe('malformed');
  });

  it('uses the LAST marker when more than one appears (e.g. the model echoed an example)', () => {
    const raw = `Here's the format: ${MARKER(0.1, 'example')}\n\nActual answer.\n${MARKER(0.9, 'real score')}`;

    const { selfConfidence } = extractAgentSelfConfidence(raw);

    expect(selfConfidence.agentConfidence).toBe(0.9);
    expect(selfConfidence.agentConfidenceBasis).toBe('real score');
  });

  it('trims trailing whitespace left behind after stripping', () => {
    const raw = `Answer.\n\n${MARKER(0.5, 'x')}\n\n`;
    const { text } = extractAgentSelfConfidence(raw);
    expect(text).toBe('Answer.');
  });
});

describe('createAgentConfidenceStreamFilter (B0-491)', () => {
  function run(chunks: string[]): string {
    let forwarded = '';
    const filter = createAgentConfidenceStreamFilter((delta) => {
      forwarded += delta;
    });
    for (const chunk of chunks) {
      filter.onDelta(chunk);
    }
    filter.finish();
    return forwarded;
  }

  it('forwards ordinary text untouched when no marker ever appears', () => {
    expect(run(['Use 2 oz ', 'per gallon ', 'of water.'])).toBe('Use 2 oz per gallon of water.');
  });

  it('never forwards the marker when it arrives in one chunk', () => {
    const forwarded = run(['Use 2 oz per gallon.\n', MARKER(0.9, 'grounded')]);
    expect(forwarded).toBe('Use 2 oz per gallon.\n');
    expect(forwarded).not.toContain('BEX_AGENT_CONFIDENCE');
  });

  it('never forwards the marker even when its opening tag is split across many small deltas', () => {
    const full = `Use 2 oz per gallon.\n${MARKER(0.9, 'grounded')}`;
    // Split into single characters — the worst case for a chunk-boundary split.
    const chars = full.split('');
    const forwarded = run(chars);
    expect(forwarded).toBe('Use 2 oz per gallon.\n');
  });

  it('forwards text after the marker, if any (should not normally happen, but must not be lost)', () => {
    const forwarded = run([`Answer.${MARKER(0.9, 'x')}TRAILING`]);
    expect(forwarded).toBe('Answer.TRAILING');
  });

  it('drops a marker that opens but never closes by the time the stream ends', () => {
    const forwarded = run(['Answer.\n<!--BEX_AGENT_CONFIDENCE {"agentConfidence":0.9']);
    expect(forwarded).toBe('Answer.\n');
  });

  it('flushes a short near-marker lookahead buffer that never actually became the marker', () => {
    // "<!--" alone is a plausible marker prefix but never completes into BEX_AGENT_CONFIDENCE.
    const forwarded = run(['Some text with an unrelated <!-- html comment --> in it.']);
    expect(forwarded).toBe('Some text with an unrelated <!-- html comment --> in it.');
  });
});
