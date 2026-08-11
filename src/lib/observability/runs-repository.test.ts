import { describe, expect, it } from 'vitest';

import { readTtftMs } from '~/lib/observability/runs-repository';

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
