import { describe, expect, it } from 'vitest';

import {
  formatReportProgressCounter,
  isTerminalReportStatus,
  resolveRunReportButtonView,
  type RunReportProgress,
} from './RunReportButton';

/**
 * B0-943 — Testing Library is c360-only per AGENTS.md, so the polling effect is exercised by hand;
 * what is asserted here is the pure label/variant/disabled decision the button renders from.
 */

function progress(overrides: Partial<RunReportProgress> = {}): RunReportProgress {
  return {
    status: 'scoring',
    completedCases: 0,
    totalCases: 0,
    completedPasses: 0,
    totalPasses: 0,
    error: null,
    ...overrides,
  };
}

describe('isTerminalReportStatus', () => {
  it('treats completed and failed as terminal and everything else as in flight', () => {
    expect(isTerminalReportStatus('completed')).toBe(true);
    expect(isTerminalReportStatus('failed')).toBe(true);
    expect(isTerminalReportStatus('idle')).toBe(false);
    expect(isTerminalReportStatus('scoring')).toBe(false);
    expect(isTerminalReportStatus('synthesizing')).toBe(false);
    expect(isTerminalReportStatus(undefined)).toBe(false);
  });
});

describe('formatReportProgressCounter', () => {
  it('prefers (case, pass) units so a multi-pass report does not read as frozen', () => {
    expect(
      formatReportProgressCounter(
        progress({
          completedCases: 0,
          totalCases: 20,
          completedPasses: 14,
          totalPasses: 60,
        }),
      ),
    ).toBe('14/60');
  });

  it('falls back to case counts for legacy rows with no pass tracking', () => {
    expect(
      formatReportProgressCounter(
        progress({ completedCases: 7, totalCases: 20, totalPasses: 0 }),
      ),
    ).toBe('7/20');
  });

  it('omits the counter rather than rendering 0/0', () => {
    expect(formatReportProgressCounter(progress())).toBeNull();
    expect(formatReportProgressCounter(null)).toBeNull();
  });

  it('clamps a count that overshoots its total', () => {
    expect(
      formatReportProgressCounter(
        progress({ completedPasses: 61, totalPasses: 60 }),
      ),
    ).toBe('60/60');
  });
});

describe('resolveRunReportButtonView', () => {
  it('disables the button with a tooltip while the run itself is still going', () => {
    expect(
      resolveRunReportButtonView({
        enabled: false,
        hasExistingReport: false,
        report: null,
      }),
    ).toEqual({
      label: 'Generating report…',
      disabled: true,
      destructive: false,
      tooltip: 'Reports can only be generated once this run has finished.',
    });
  });

  it('links to the report when one already exists, even mid-run', () => {
    expect(
      resolveRunReportButtonView({
        enabled: false,
        hasExistingReport: true,
        report: null,
      }),
    ).toEqual({
      label: 'View report',
      disabled: false,
      destructive: false,
      tooltip: null,
    });
  });

  it('reads "View report" once the polled status flips to completed', () => {
    expect(
      resolveRunReportButtonView({
        enabled: true,
        hasExistingReport: false,
        report: progress({ status: 'completed' }),
      }),
    ).toEqual({
      label: 'View report',
      disabled: false,
      destructive: false,
      tooltip: null,
    });
  });

  it('shows unit progress while scoring', () => {
    expect(
      resolveRunReportButtonView({
        enabled: true,
        hasExistingReport: false,
        report: progress({ completedPasses: 14, totalPasses: 60 }),
      }),
    ).toEqual({
      label: 'Generating report… 14/60',
      disabled: false,
      destructive: false,
      tooltip: null,
    });
  });

  it('shows a bare generating label while synthesizing with no counts yet', () => {
    expect(
      resolveRunReportButtonView({
        enabled: true,
        hasExistingReport: false,
        report: progress({ status: 'synthesizing' }),
      }).label,
    ).toBe('Generating report…');
  });

  it('falls back to a bare generating label when the run finished but no state exists yet', () => {
    expect(
      resolveRunReportButtonView({
        enabled: true,
        hasExistingReport: false,
        report: null,
      }),
    ).toEqual({
      label: 'Generating report…',
      disabled: false,
      destructive: false,
      tooltip: null,
    });
  });

  it('surfaces a failed report with destructive colouring and the error as a tooltip', () => {
    expect(
      resolveRunReportButtonView({
        enabled: true,
        hasExistingReport: false,
        report: progress({ status: 'failed', error: 'grader timed out' }),
      }),
    ).toEqual({
      label: 'Report failed',
      disabled: false,
      destructive: true,
      tooltip: 'grader timed out',
    });
  });

  it('drops an empty error string rather than rendering a blank tooltip', () => {
    expect(
      resolveRunReportButtonView({
        enabled: true,
        hasExistingReport: false,
        report: progress({ status: 'failed', error: '   ' }),
      }).tooltip,
    ).toBeNull();
  });

  it('prefers an existing report over a stale failed state', () => {
    expect(
      resolveRunReportButtonView({
        enabled: true,
        hasExistingReport: true,
        report: progress({ status: 'failed', error: 'stale' }),
      }).label,
    ).toBe('View report');
  });
});
