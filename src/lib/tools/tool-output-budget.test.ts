import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  enforceToolOutputBudget,
  TOOL_OUTPUT_TRUNCATION_MARKER,
} from '~/lib/tools/tool-output-budget';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('enforceToolOutputBudget', () => {
  it('tail-cuts only an oversized source body and keeps the payload valid JSON', () => {
    vi.stubEnv('BEX_TOOL_OUTPUT_CHAR_BUDGET', '1000');
    vi.stubEnv('BEX_TOOL_DOCUMENT_CHAR_BUDGET', '32');

    const result = enforceToolOutputBudget(
      JSON.stringify({ sources: [{ documentBody: 'x'.repeat(80), documentBodyChars: 80 }] }),
    );
    const payload = JSON.parse(result.output) as {
      sources: Array<{
        documentBody: string;
        documentBodyChars: number;
        documentBodyTruncated?: boolean;
      }>;
    };

    expect(result).toMatchObject({ applied: true, truncatedDocuments: 1, droppedSources: 0 });
    expect(payload.sources[0]).toEqual({
      documentBody: `x`.repeat(32 - TOOL_OUTPUT_TRUNCATION_MARKER.length) +
        TOOL_OUTPUT_TRUNCATION_MARKER,
      documentBodyChars: 32,
      documentBodyTruncated: true,
    });
  });

  it('drops only trailing sources before falling back to a raw cut', () => {
    vi.stubEnv('BEX_TOOL_OUTPUT_CHAR_BUDGET', '120');
    vi.stubEnv('BEX_TOOL_DOCUMENT_CHAR_BUDGET', '1000');

    const result = enforceToolOutputBudget(
      JSON.stringify({
        sources: [
          { id: 'first', documentBody: 'a'.repeat(20) },
          { id: 'second', documentBody: 'b'.repeat(80) },
        ],
      }),
    );
    const payload = JSON.parse(result.output) as {
      sources: Array<{ id: string }>;
      sourcesDroppedForBudget?: number;
    };

    expect(result.output.length).toBeLessThanOrEqual(120);
    expect(result).toMatchObject({ applied: true, droppedSources: 1 });
    expect(payload.sources).toEqual([{ id: 'first', documentBody: 'a'.repeat(20) }]);
    expect(payload.sourcesDroppedForBudget).toBe(1);
  });

  it('never exceeds an emergency-sized total cap', () => {
    vi.stubEnv('BEX_TOOL_OUTPUT_CHAR_BUDGET', '1');
    vi.stubEnv('BEX_TOOL_DOCUMENT_CHAR_BUDGET', '1');

    const result = enforceToolOutputBudget('a deliberately long non-JSON output');

    expect(result).toMatchObject({
      applied: true,
      output: TOOL_OUTPUT_TRUNCATION_MARKER.slice(0, 1),
    });
    expect(result.output.length).toBeLessThanOrEqual(1);
  });
});
