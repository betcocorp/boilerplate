import { describe, expect, it, vi } from 'vitest';

const executeProductToolMock = vi.hoisted(() => vi.fn());

vi.mock('~/lib/tools/product-tools', () => ({
  executeProductTool: (...args: unknown[]) => executeProductToolMock(...args),
}));

import { executeToolCall } from '~/lib/tools/execute-tool-call';

const HUGE_BODY = [
  `## Section 1. Identification\n${'a'.repeat(6_000)}`,
  `## Section 12. Ecological information\n${'b'.repeat(9_000)}`,
  `## Section 4. First-aid measures\nIf in eyes: rinse cautiously with water for several minutes.`,
].join('\n\n');

describe('executeToolCall — model vs persisted payload (B0-437)', () => {
  it('returns the FULL payload as `output` and a smaller `modelOutput` for the model', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      sources: [
        {
          documentId: 'doc-1',
          chunkId: 'chunk-1',
          title: 'pH7Q Dual SDS',
          snippet: 'If in eyes: rinse cautiously with water',
          matchedChunkText: 'If in eyes: rinse cautiously with water for several minutes.',
          documentBody: HUGE_BODY,
          documentBodyChars: HUGE_BODY.length,
          documentBodyChunkCount: 3,
          documentBodyTruncated: false,
          documentBodyTokenEstimate: 4_000,
          documentBodyChunkIds: ['chunk-1', 'chunk-2', 'chunk-3'],
          confidence: 0.77,
          documentKind: 'sds',
          productLineKey: 'ph7q-dual',
          productKey: null,
          s3Key: 'sds/betco/ph7q.pdf',
          sourceUri: 's3://betco-sds/sds/betco/ph7q.pdf',
        },
      ],
    });

    const result = await executeToolCall({
      name: 'search_product_docs',
      argumentsJson: JSON.stringify({ freeformQuery: 'pH7Q Dual first aid' }),
      callId: 'call_1',
    });

    // The persisted copy — what the validator and the regulated-claim guardrail read — is untouched.
    const full = JSON.parse(result.output) as {
      sources: Array<Record<string, unknown>>;
    };
    expect(full.sources[0]?.documentBody).toBe(HUGE_BODY);
    expect(full.sources[0]?.snippet).toBe('If in eyes: rinse cautiously with water');
    expect(full.sources[0]?.matchedChunkText).toContain('rinse cautiously');

    // The model's copy is slimmer, keeps citation identity, and never claims to be complete.
    expect(result.modelOutput).toBeDefined();
    expect(result.modelOutput!.length).toBeLessThan(result.output.length);
    const model = JSON.parse(result.modelOutput!) as { sources: Array<Record<string, unknown>> };
    expect(model.sources[0]?.documentId).toBe('doc-1');
    expect('snippet' in (model.sources[0] ?? {})).toBe(false);
    expect('matchedChunkText' in (model.sources[0] ?? {})).toBe(false);
    expect(model.sources[0]?.documentBodyTruncated).toBe(true);
    // The regulated section survives the model-only cap.
    expect(String(model.sources[0]?.documentBody)).toContain('Section 4. First-aid measures');

    // `outputPreview` stays the audit record of the FULL payload; the slim size is recorded alongside.
    expect(result.trace.outputPreview).toBe(result.output.slice(0, 4000));
    expect(result.trace.modelOutputChars).toBe(result.modelOutput!.length);
  });

  it('omits `modelOutput` when there is nothing to slim', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      adapter: 'static_policy_v1',
      policy: { summary: 'Standard product-support escalation.', steps: ['Capture SKU.'] },
    });

    const result = await executeToolCall({
      name: 'get_escalation_policy',
      argumentsJson: JSON.stringify({ issueType: 'safety' }),
      callId: 'call_2',
    });

    expect(result.modelOutput).toBeUndefined();
    expect(result.trace.modelOutputChars).toBeUndefined();
    expect(JSON.parse(result.output)).toMatchObject({ ok: true });
  });

  it('omits `modelOutput` when the slim variant would not actually be smaller', async () => {
    executeProductToolMock.mockResolvedValueOnce({
      ok: true,
      sources: [{ documentId: 'doc-1', documentBody: 'short' }],
    });

    const result = await executeToolCall({
      name: 'search_product_docs',
      argumentsJson: '{}',
      callId: 'call_3',
    });

    // The projection adds explicit nulls for missing citation fields, so it is not smaller here.
    expect(result.modelOutput).toBeUndefined();
  });

  it('leaves failures alone — an error payload has no model variant', async () => {
    executeProductToolMock.mockRejectedValueOnce(new Error('embedding provider unavailable'));

    const result = await executeToolCall({
      name: 'search_product_docs',
      argumentsJson: '{"freeformQuery":"x"}',
      callId: 'call_4',
    });

    expect(result.trace.ok).toBe(false);
    expect(result.modelOutput).toBeUndefined();
    expect(JSON.parse(result.output)).toMatchObject({ ok: false });
  });
});
