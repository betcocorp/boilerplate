import { describe, expect, it } from 'vitest';

import { buildApiRequestLogRow } from '~/lib/api/request-log';

describe('buildApiRequestLogRow', () => {
  it('maps attribution + metadata and rounds latency', () => {
    const row = buildApiRequestLogRow({
      keyId: 'k',
      appId: 'a',
      projectId: 'p',
      method: 'POST',
      path: '/api/v1/orchestrator',
      status: 200,
      latencyMs: 123.7,
    });
    expect(row).toEqual({
      key_id: 'k',
      app_id: 'a',
      project_id: 'p',
      method: 'POST',
      path: '/api/v1/orchestrator',
      status: 200,
      latency_ms: 124,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      error: null,
    });
  });

  it('carries token usage when present', () => {
    const row = buildApiRequestLogRow({
      keyId: 'k',
      appId: 'a',
      projectId: 'p',
      method: 'POST',
      path: '/x',
      status: 200,
      latencyMs: 10,
      usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
    });
    expect(row.prompt_tokens).toBe(100);
    expect(row.completion_tokens).toBe(40);
    expect(row.total_tokens).toBe(140);
  });

  it('clamps a negative latency to 0 and nulls a non-finite one', () => {
    expect(buildApiRequestLogRow({
      keyId: null, appId: null, projectId: null, method: 'GET', path: '/x', status: 401,
      latencyMs: -5,
    }).latency_ms).toBe(0);
    expect(buildApiRequestLogRow({
      keyId: null, appId: null, projectId: null, method: 'GET', path: '/x', status: 401,
      latencyMs: Number.NaN,
    }).latency_ms).toBeNull();
  });

  it('preserves an error message and unresolved attribution', () => {
    const row = buildApiRequestLogRow({
      keyId: 'k',
      appId: 'a',
      projectId: null,
      method: 'POST',
      path: '/api/v1/orchestrator',
      status: 401,
      latencyMs: 3,
      error: 'revoked',
    });
    expect(row.error).toBe('revoked');
    expect(row.project_id).toBeNull();
  });
});
