import { describe, expect, it } from 'vitest';

import {
  buildToolCallAuditPayload,
  extractToolFailureMessage,
} from '~/lib/workflows/product-support/run-product-support-workflow';

/**
 * B0-363 — `tool_failed` audit rows must carry the failure cause and a bounded
 * arguments preview. Before this, the payload was `{tool_name, call_id}` only, so a
 * schema rejection and a downstream retrieval/embedding throw were indistinguishable
 * for every run predating the `toolTrace` rollout.
 */

const FAILED_TRACE = {
  toolName: 'get_safety_constraints',
  callId: 'call_abc',
  ok: false,
  argumentsPreview: '{"productName":"pH7Q Dual"}',
  outputPreview: JSON.stringify({
    ok: false,
    error: 'Invalid input: expected string, received undefined at "productName"',
  }),
};

describe('extractToolFailureMessage', () => {
  it('pulls the message out of the {ok:false,error} envelope executeToolCall writes', () => {
    expect(extractToolFailureMessage(FAILED_TRACE.outputPreview)).toBe(
      'Invalid input: expected string, received undefined at "productName"',
    );
  });

  it('falls back to the raw preview when the output is not that envelope', () => {
    expect(extractToolFailureMessage('boom: connection reset')).toBe(
      'boom: connection reset',
    );
  });

  it('falls back to the raw preview when the JSON was truncated mid-object', () => {
    expect(extractToolFailureMessage('{"ok":false,"error":"half a mess')).toBe(
      '{"ok":false,"error":"half a mess',
    );
  });

  it('returns null for an empty preview rather than an empty string', () => {
    expect(extractToolFailureMessage('   ')).toBeNull();
  });

  it('bounds the message so a huge Zod report cannot bloat audit_logs', () => {
    const long = 'x'.repeat(5_000);
    const message = extractToolFailureMessage(JSON.stringify({ ok: false, error: long }));
    expect(message).toHaveLength(1_024 + '…[truncated]'.length);
    expect(message?.endsWith('…[truncated]')).toBe(true);
  });
});

describe('buildToolCallAuditPayload', () => {
  it('adds error_message and a bounded arguments_preview on failure', () => {
    expect(buildToolCallAuditPayload(FAILED_TRACE)).toEqual({
      tool_name: 'get_safety_constraints',
      call_id: 'call_abc',
      error_message: 'Invalid input: expected string, received undefined at "productName"',
      arguments_preview: '{"productName":"pH7Q Dual"}',
    });
  });

  it('leaves the tool_succeeded payload unchanged — no success args stored twice', () => {
    expect(
      buildToolCallAuditPayload({
        ...FAILED_TRACE,
        ok: true,
        outputPreview: '{"sources":[{"documentId":"doc-1"}]}',
      }),
    ).toEqual({ tool_name: 'get_safety_constraints', call_id: 'call_abc' });
  });

  it('truncates the arguments preview at the 512-char cap', () => {
    const payload = buildToolCallAuditPayload({
      ...FAILED_TRACE,
      argumentsPreview: 'a'.repeat(2_000),
    });
    expect(payload.arguments_preview).toHaveLength(512 + '…[truncated]'.length);
  });

  it('keeps a short arguments preview verbatim (no truncation marker)', () => {
    const payload = buildToolCallAuditPayload(FAILED_TRACE);
    expect(String(payload.arguments_preview)).not.toContain('[truncated]');
  });
});
