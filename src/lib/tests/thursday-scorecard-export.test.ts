import { describe, expect, it } from 'vitest';

import { describeThursdayScorecardScore } from '~/lib/tests/report-row-format';
import { formatChangePercent, formatChangePoints } from '~/lib/tests/report-trend';
import { formatEasternSweepLabel } from '~/lib/utils/time';
import {
  buildThursdayScorecardJson,
  EXPORT_THURSDAY_SCORECARD_JSON_COMMENT,
  renderThursdayScorecardMarkdown,
  sanitizeFilename,
  thursdayScorecardExportFileBase,
  thursdayScorecardFileBaseFor,
  thursdayScorecardJsonDocumentSchema,
} from '~/lib/tests/thursday-scorecard-export';
import {
  type ThursdayScorecardAgentRow,
  type ThursdayScorecardSnapshot,
  thursdayScorecardSnapshotSchema,
} from '~/lib/tests/thursday-scorecard-schemas';

const MINUS = '−';
const DASH = '—';

const SWEEP_ID = 'sweep-2026-09-24';
const PREVIOUS_SWEEP_ID = 'sweep-2026-09-17';

function row(overrides: Partial<ThursdayScorecardAgentRow>): ThursdayScorecardAgentRow {
  return {
    testId: 'test-a',
    testName: 'Golden Product',
    intendedAgent: 'product',
    agentLabel: 'Product Specialist',
    runId: 'run-a',
    ledgerStatus: 'completed',
    reportStatus: 'completed',
    score: 92.7,
    grade: 'A',
    failCount: 3,
    change: null,
    modelTag: 'gpt-4.1',
    appVersion: '8.0.0',
    averageTtftMs: 1234,
    averageElapsedMs: 8765,
    conceptPercent: 88,
    supporting: {
      speedScore: 81,
      speedRating: 'Good',
      avgTtftSeconds: 1.23,
      avgTotalSeconds: 8.77,
      similarityAvg: 0.84,
      evalConfidenceAvg: 91.5,
      passRate: 87.5,
      passMark: 75,
    },
    ...overrides,
  };
}

/** One of each shape the snapshot can hold, in a deliberate (non-alphabetical) order. */
const fixture: ThursdayScorecardSnapshot = {
  sweep: {
    id: SWEEP_ID,
    sweepTriggeredAt: '2026-09-25T00:00:50.461Z',
    status: 'completed',
    totalTests: 5,
    successfulTests: 4,
    failedTests: 1,
    timedOutTests: 0,
  },
  previousSweep: { id: PREVIOUS_SWEEP_ID, sweepTriggeredAt: '2026-09-18T00:00:48.000Z' },
  agents: [
    row({
      change: {
        runId: 'run-a',
        previousRunId: 'run-a-prev',
        previousScore: 86.4,
        deltaPoints: 6.3,
        changePercent: 7.2,
      },
    }),
    row({
      testId: 'test-b',
      testName: 'Golden Bathroom | Restroom',
      intendedAgent: 'bathroom',
      agentLabel: 'Bathroom | Restroom',
      runId: 'run-b',
      score: 88.1,
      grade: 'B',
      failCount: 5,
      change: {
        runId: 'run-b',
        previousRunId: 'run-b-prev',
        previousScore: 89.3,
        deltaPoints: -1.2,
        changePercent: -1.3,
      },
    }),
    row({
      testId: 'test-c',
      testName: 'Golden Dilution',
      intendedAgent: 'dilution',
      agentLabel: 'Dilution Specialist',
      runId: null,
      ledgerStatus: 'failed',
      reportStatus: null,
      score: null,
      grade: null,
      failCount: null,
      modelTag: null,
      appVersion: null,
      averageTtftMs: null,
      averageElapsedMs: null,
      conceptPercent: null,
      supporting: null,
    }),
    row({
      testId: 'test-d',
      testName: 'Golden Recommendations',
      intendedAgent: 'recommendations',
      agentLabel: 'Recommendations',
      runId: 'run-d',
      reportStatus: 'failed',
      score: null,
      grade: null,
      failCount: 2,
      conceptPercent: null,
      supporting: null,
    }),
    row({
      testId: 'test-e',
      testName: 'Golden Cross-reference',
      intendedAgent: 'cross_reference',
      agentLabel: 'Cross-reference',
      runId: 'run-e',
      score: 74.9,
      grade: 'C',
      failCount: 9,
      supporting: null,
    }),
  ],
};

function markdownTableRows(markdown: string): string[][] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim()),
    );
}

describe('renderThursdayScorecardMarkdown', () => {
  const markdown = renderThursdayScorecardMarkdown(fixture);
  const [header, separator, ...body] = markdownTableRows(markdown);

  it('has the on-screen columns in the on-screen order, one table, and the Eastern sweep label', () => {
    expect(header).toEqual([
      '#',
      'Agent',
      'Score',
      'Change',
      'Fails',
      'Concept %',
      'TTFT/ELAP',
      'Model',
      'Version',
      'Speed',
      'Avg TTFT',
      'Similarity',
      'Eval conf.',
      'Pass rate',
    ]);
    expect(separator.every((cell) => cell === '---')).toBe(true);
    // The heading is the Eastern label of the sweep instant (Thursday evening, not the UTC Friday).
    const sweepLabel = formatEasternSweepLabel(fixture.sweep.sweepTriggeredAt);
    expect(sweepLabel).toMatch(/^Thu,? Sep 24, 2026 · 8:00 PM ET$/);
    expect(markdown.startsWith(`# Thursday scorecard — ${sweepLabel}`)).toBe(true);
    expect(markdown).toContain(`Sweep \`${SWEEP_ID}\` · 4 of 5 ran · status: completed.`);
    expect(markdown).toContain(
      `Change is against the previous Thursday-night sweep, ${formatEasternSweepLabel(fixture.previousSweep!.sweepTriggeredAt)}.`,
    );
    expect(markdown).toContain(
      'Scores are out of 100. "—" means not recorded. Speed and judged metrics are reported beside the grade and never feed it.',
    );
  });

  it('lists every agent in snapshot order', () => {
    expect(body.map((cells) => cells[0])).toEqual(['1', '2', '3', '4', '5']);
    expect(body.map((cells) => cells[1])).toEqual([
      'Product Specialist',
      'Bathroom \\| Restroom',
      'Dilution Specialist',
      'Recommendations',
      'Cross-reference',
    ]);
  });

  it('renders Score, Change and Fails through the shared formatters', () => {
    const score = (i: number) => body[i][2];
    const change = (i: number) => body[i][3];
    const fails = (i: number) => body[i][4];

    expect(score(0)).toBe('92.7 (A)');
    expect(score(0)).toBe(describeThursdayScorecardScore(fixture.agents[0]));
    expect(change(0)).toBe('+6.3 pts (+7.2%)');
    expect(change(0)).toBe(
      `${formatChangePoints(fixture.agents[0].change!)} (${formatChangePercent(fixture.agents[0].change!)})`,
    );
    expect(fails(0)).toBe('3');

    expect(change(1)).toBe(`${MINUS}1.2 pts (${MINUS}1.3%)`);
    expect(change(1)).not.toContain('-1.2');

    expect(score(2)).toBe('Failed');
    expect(change(2)).toBe(DASH);
    expect(fails(2)).toBe(DASH);

    expect(score(3)).toBe('Failed');
    expect(fails(3)).toBe('2');

    expect(score(4)).toBe('74.9 (C)');
    expect(change(4)).toBe(DASH);
  });

  it('transcribes the remaining cells, with — for every unrecorded value', () => {
    expect(body[0].slice(5)).toEqual([
      '88%',
      '1.23s / 8.77s',
      'gpt-4.1',
      '8.0.0',
      '81 · Good',
      '1.23s',
      '0.84',
      '91.5',
      '87.5%',
    ]);
    expect(body[2].slice(5)).toEqual([
      DASH,
      `${DASH} / ${DASH}`,
      DASH,
      DASH,
      DASH,
      DASH,
      DASH,
      DASH,
      DASH,
    ]);
    // supporting: null → every supporting column is —, the content columns are untouched.
    expect(body[4].slice(9)).toEqual([DASH, DASH, DASH, DASH, DASH]);
  });

  it('never prints a % on a score and never prints the literal "null"', () => {
    for (const cells of body) {
      expect(cells[2]).not.toContain('%');
    }
    expect(markdown).not.toMatch(/\bnull\b/);
  });

  it('has no earlier-sweep line when previousSweep is null', () => {
    const md = renderThursdayScorecardMarkdown({ ...fixture, previousSweep: null });
    expect(md).toContain('No earlier Thursday-night sweep; Change is not available.');
    expect(md).not.toContain('Change is against');
  });
});

describe('buildThursdayScorecardJson', () => {
  const document = buildThursdayScorecardJson(fixture, {
    exportedAt: '2026-10-08T14:00:00.000Z',
    appVersion: '8.0.0',
  });

  it('validates against its schema and names its source', () => {
    const parsed = thursdayScorecardJsonDocumentSchema.safeParse(document);
    expect(parsed.success).toBe(true);
    expect(document.$comment).toBe(EXPORT_THURSDAY_SCORECARD_JSON_COMMENT);
    expect(document.exportedAt).toBe('2026-10-08T14:00:00.000Z');
    expect(document.appVersion).toBe('8.0.0');
    expect(document.sweep.id).toBe(SWEEP_ID);
    expect(document.previousSweep?.id).toBe(PREVIOUS_SWEEP_ID);
  });

  it('carries the snapshot agents verbatim, in order, round-tripping the snapshot schema', () => {
    const agents = thursdayScorecardSnapshotSchema.shape.agents.parse(document.agents);
    expect(agents).toEqual(fixture.agents);
    expect(agents.map((a) => a.testId)).toEqual(fixture.agents.map((a) => a.testId));
    expect(agents.map((a) => [a.score, a.grade, a.failCount, a.change?.deltaPoints ?? null])).toEqual([
      [92.7, 'A', 3, 6.3],
      [88.1, 'B', 5, -1.2],
      [null, null, null, null],
      [null, null, 2, null],
      [74.9, 'C', 9, null],
    ]);
  });

  it('keeps null for unrecorded values — never a placeholder', () => {
    const text = JSON.stringify(document);
    expect(text).not.toContain(DASH);
    expect(text).not.toContain('"n/a"');
    expect(document.agents[2].score).toBeNull();
    expect(document.agents[2].supporting).toBeNull();
  });
});

describe('file naming', () => {
  it('uses the Eastern date of the sweep, not the UTC date', () => {
    expect(thursdayScorecardExportFileBase(fixture)).toBe('thursday-scorecard-2026-09-24');
    expect(thursdayScorecardFileBaseFor('2026-09-25T00:00:50.461Z')).toBe(
      'thursday-scorecard-2026-09-24',
    );
  });

  it('sanitizeFilename strips the characters a download name may not carry', () => {
    expect(sanitizeFilename('a/b\\c?d%e*f:g|h"i<j>k')).toBe('a-b-c-d-e-f-g-h-i-j-k');
    expect(sanitizeFilename('   ')).toBe('thursday-scorecard');
  });
});
