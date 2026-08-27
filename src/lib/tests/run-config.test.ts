import { describe, expect, it } from 'vitest';

import { buildTestRunOptions, parseTestRunConfig } from '~/lib/tests/run-config';

/**
 * B0-351 — `test_results.run_options` is the immutable per-run config. These cases are taken from
 * the shapes actually present in the table (an empty `{}` on 53 rows, `modelTag`-only rows, and the
 * `modelTag`+`useValidator`+`routerType` rows), so a historical run can never start executing (or
 * displaying) differently from the way it originally ran.
 */
describe('parseTestRunConfig', () => {
  it('defaults a run that recorded nothing to the pre-B0-351 behaviour', () => {
    expect(parseTestRunConfig({})).toEqual({
      modelTag: null,
      useValidator: false,
      agentMode: 'orchestrator',
      routerType: null,
    });
  });

  it('treats null / non-object run_options the same as an empty blob', () => {
    for (const value of [null, undefined, 'nope', 42, ['a']]) {
      expect(parseTestRunConfig(value).agentMode).toBe('orchestrator');
      expect(parseTestRunConfig(value).useValidator).toBe(false);
    }
  });

  it('reads the fields a run actually recorded', () => {
    expect(
      parseTestRunConfig({
        modelTag: 'gpt-4.1',
        useValidator: true,
        agentMode: 'bathroom',
        routerType: 'llm',
      }),
    ).toEqual({
      modelTag: 'gpt-4.1',
      useValidator: true,
      agentMode: 'bathroom',
      routerType: 'llm',
    });
  });

  it('falls back to orchestrator for an agent mode that is not a real one', () => {
    expect(parseTestRunConfig({ agentMode: 'escalation_specialist' }).agentMode).toBe(
      'orchestrator',
    );
    expect(parseTestRunConfig({ agentMode: 7 }).agentMode).toBe('orchestrator');
  });

  it('only a literal true turns the validator on', () => {
    expect(parseTestRunConfig({ useValidator: 'true' }).useValidator).toBe(false);
    expect(parseTestRunConfig({ useValidator: 1 }).useValidator).toBe(false);
    expect(parseTestRunConfig({ useValidator: true }).useValidator).toBe(true);
  });

  it('keeps a blank model tag as null rather than inventing "preview"', () => {
    expect(parseTestRunConfig({ modelTag: '   ' }).modelTag).toBeNull();
    expect(parseTestRunConfig({ modelTag: ' gpt-4o ' }).modelTag).toBe('gpt-4o');
  });

  it('ignores a router override that is not a real router type', () => {
    expect(parseTestRunConfig({ routerType: 'magic' }).routerType).toBeNull();
  });

  it('leaves a search-eval run_options blob at all defaults', () => {
    expect(
      parseTestRunConfig({ useHybrid: true, useReranker: false, useMultiIntent: true }),
    ).toEqual({
      modelTag: null,
      useValidator: false,
      agentMode: 'orchestrator',
      routerType: null,
    });
  });
});

describe('buildTestRunOptions', () => {
  it('omits the defaults so a new run stays byte-comparable with older ones', () => {
    expect(
      buildTestRunOptions({
        modelTag: 'gpt-4.1',
        useValidator: false,
        agentMode: 'orchestrator',
      }),
    ).toEqual({ modelTag: 'gpt-4.1', useValidator: false });
  });

  it('records a forced agent mode and router override when they are set', () => {
    expect(
      buildTestRunOptions({
        modelTag: 'preview',
        useValidator: true,
        agentMode: 'dilution',
        routerType: 'semantic',
      }),
    ).toEqual({
      modelTag: 'preview',
      useValidator: true,
      agentMode: 'dilution',
      routerType: 'semantic',
    });
  });

  it('round-trips through the parser', () => {
    const options = buildTestRunOptions({
      modelTag: 'gpt-5.5',
      useValidator: true,
      agentMode: 'cross_reference',
      routerType: 'keyword',
    });
    expect(parseTestRunConfig(options)).toEqual({
      modelTag: 'gpt-5.5',
      useValidator: true,
      agentMode: 'cross_reference',
      routerType: 'keyword',
    });
  });
});
