import { describe, expect, it } from 'vitest';

import { createRunBodySchema } from '~/lib/tests/create-run-body';
import { buildTestRunOptions } from '~/lib/tests/run-config';

/**
 * B0-880 — `POST /api/admin/tests/runs` must persist the same `run_options` blob `runTestAction`
 * would for the same choices, and a body that omits `agentMode`/`routerType` (every CI request
 * today) must keep producing the exact pre-B0-880 blob.
 */
describe('createRunBodySchema', () => {
  it('parses a testId-only body to the defaults and persists the pre-B0-880 blob', () => {
    const parsed = createRunBodySchema.parse({ testId: 'test-1' });

    expect(parsed).toEqual({
      testId: 'test-1',
      runMode: 'full',
      modelTag: 'gpt-4.1',
      useValidator: false,
      agentMode: 'orchestrator',
      routerType: undefined,
      useHybrid: false,
      useReranker: false,
      useMultiIntent: false,
    });

    const { modelTag, useValidator, agentMode, routerType } = parsed;
    const runOptions = buildTestRunOptions({ modelTag, useValidator, agentMode, routerType });
    expect(runOptions).toEqual({ modelTag: 'gpt-4.1', useValidator: false });
    expect(Object.keys(runOptions)).toEqual(['modelTag', 'useValidator']);
  });

  it('carries a non-default agentMode and routerType through to run_options', () => {
    const parsed = createRunBodySchema.parse({
      testId: 'test-1',
      agentMode: 'dilution',
      routerType: 'keyword',
    });

    expect(parsed.agentMode).toBe('dilution');
    expect(parsed.routerType).toBe('keyword');

    const { modelTag, useValidator, agentMode, routerType } = parsed;
    expect(buildTestRunOptions({ modelTag, useValidator, agentMode, routerType })).toEqual({
      modelTag: 'gpt-4.1',
      useValidator: false,
      agentMode: 'dilution',
      routerType: 'keyword',
    });
  });

  it('rejects an agentMode that is not a real agent mode', () => {
    const result = createRunBodySchema.safeParse({
      testId: 'test-1',
      agentMode: 'escalation_specialist',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['agentMode']);
    }
  });

  it('rejects a routerType that is not a real router type', () => {
    const result = createRunBodySchema.safeParse({ testId: 'test-1', routerType: 'magic' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['routerType']);
    }
  });
});
