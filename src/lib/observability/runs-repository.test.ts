import { describe, expect, it } from 'vitest';

import {
  isRunIdSearchTerm,
  readRunSource,
  readTtftMs,
} from '~/lib/observability/runs-repository';

/**
 * B0-428 — `final_output` is untyped `Json` written by three different code paths (completed,
 * early-decline, failed) plus every run recorded before the workflow was instrumented, so the
 * "Stream" column's reader has to tolerate all of them.
 */
describe('readTtftMs', () => {
  it('reads timingBreakdown.ttftMs from a completed run payload', () => {
    expect(
      readTtftMs({
        answerText: 'ok',
        timingBreakdown: { toolRounds: 2, cacheSource: null, searchMs: 120, ttftMs: 1840 },
      }),
    ).toBe(1840);
  });

  it('reads the failure path payload', () => {
    expect(readTtftMs({ error: 'boom', timingBreakdown: { ttftMs: 900 } })).toBe(900);
  });

  it('returns null when nothing was streamed', () => {
    expect(
      readTtftMs({ timingBreakdown: { toolRounds: 0, cacheSource: null, searchMs: null, ttftMs: null } }),
    ).toBeNull();
  });

  it('returns null for payloads predating the instrumentation', () => {
    expect(readTtftMs({ timingBreakdown: { toolRounds: 1, cacheSource: null, searchMs: 80 } })).toBeNull();
    expect(readTtftMs({ answerText: 'ok' })).toBeNull();
  });

  it('returns null for malformed payloads', () => {
    expect(readTtftMs(null)).toBeNull();
    expect(readTtftMs('nope')).toBeNull();
    expect(readTtftMs([{ timingBreakdown: { ttftMs: 10 } }])).toBeNull();
    expect(readTtftMs({ timingBreakdown: 'nope' })).toBeNull();
    expect(readTtftMs({ timingBreakdown: { ttftMs: '1840' } })).toBeNull();
    expect(readTtftMs({ timingBreakdown: { ttftMs: Number.NaN } })).toBeNull();
    expect(readTtftMs({ timingBreakdown: { ttftMs: -5 } })).toBeNull();
  });
});

/**
 * B0-416 — `workflow_runs.source` is stored text. The CHECK constraint only covers rows written
 * after the migration, and pre-migration runs are legitimately NULL, so the reader has to report
 * unknown as unknown rather than defaulting a run into a source it was never known to have.
 */
describe('readRunSource', () => {
  it('accepts every stored source value', () => {
    expect(readRunSource('harness')).toBe('harness');
    expect(readRunSource('bex_chat')).toBe('bex_chat');
    expect(readRunSource('orchestrator_api')).toBe('orchestrator_api');
  });

  it('returns null for the pre-instrumentation cohort', () => {
    expect(readRunSource(null)).toBeNull();
  });

  it('returns null rather than guessing for values outside the enum', () => {
    // 'live' was the old derived label; it was never a stored value.
    expect(readRunSource('live')).toBeNull();
    expect(readRunSource('')).toBeNull();
    expect(readRunSource('HARNESS')).toBeNull();
    expect(readRunSource(' harness')).toBeNull();
  });
});

/**
 * B0-431 — decides whether the observability search box does an id lookup or a prompt-text
 * match. A false negative here is silent: the id would be matched against prompt text and the
 * screen would report "no runs" for a run that exists.
 */
describe('isRunIdSearchTerm', () => {
  it('accepts a workflow run id in either case', () => {
    expect(isRunIdSearchTerm('0f9c1a2b-3d4e-5f60-8a9b-1c2d3e4f5a6b')).toBe(true);
    expect(isRunIdSearchTerm('0F9C1A2B-3D4E-5F60-8A9B-1C2D3E4F5A6B')).toBe(true);
  });

  it('treats ordinary prompt text as a text search', () => {
    expect(isRunIdSearchTerm('how do I dilute Green Earth')).toBe(false);
    expect(isRunIdSearchTerm('')).toBe(false);
    expect(isRunIdSearchTerm('1234')).toBe(false);
  });

  it('rejects near-misses rather than running an id lookup that cannot match', () => {
    // Wrong group lengths, non-hex characters, and surrounding text.
    expect(isRunIdSearchTerm('0f9c1a2b-3d4e-5f60-8a9b-1c2d3e4f5a6')).toBe(false);
    expect(isRunIdSearchTerm('0f9c1a2b3d4e5f608a9b1c2d3e4f5a6b')).toBe(false);
    expect(isRunIdSearchTerm('zzzzzzzz-3d4e-5f60-8a9b-1c2d3e4f5a6b')).toBe(false);
    expect(isRunIdSearchTerm('run 0f9c1a2b-3d4e-5f60-8a9b-1c2d3e4f5a6b')).toBe(false);
  });

  it('is stateless across calls', () => {
    const id = '0f9c1a2b-3d4e-5f60-8a9b-1c2d3e4f5a6b';
    expect(isRunIdSearchTerm(id)).toBe(true);
    expect(isRunIdSearchTerm(id)).toBe(true);
  });
});
