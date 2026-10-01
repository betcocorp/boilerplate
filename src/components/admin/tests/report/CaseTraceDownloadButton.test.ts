import { describe, expect, it } from 'vitest';

import { traceExportFilename } from './CaseTraceDownloadButton';

/**
 * B0-707 — Testing Library is c360-only per AGENTS.md, so only the pure filename helper is
 * asserted here; the button's fetch/download path is exercised by hand.
 */

describe('traceExportFilename', () => {
  it('names the file after the short case id and the workflow run', () => {
    expect(traceExportFilename('7f3c1a90-2b44-4f7e-9d11-8a2c0f6b5e33', 'wf-abc-123')).toBe(
      'case-7f3c1a90-run-trace-wf-abc-123.json',
    );
  });

  it('strips characters that would make a path or an unusable filename', () => {
    expect(traceExportFilename('a/b:c*d', 'run id?with"junk')).toBe(
      'case-a-b-c-d-run-trace-run-id-with-junk.json',
    );
  });

  it('caps each half so an absurd id cannot produce an unusable name', () => {
    const name = traceExportFilename('x'.repeat(200), 'y'.repeat(200));
    // The case half is the id's first 8 characters; the run half is capped at 60.
    expect(name).toBe(`case-${'x'.repeat(8)}-run-trace-${'y'.repeat(60)}.json`);
  });

  it('falls back to placeholders rather than emitting an empty segment', () => {
    expect(traceExportFilename('', '')).toBe('case-case-run-trace-run.json');
  });
});
