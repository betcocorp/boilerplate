import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyReportState, parseReportState, reportStateSchema } from './schemas';

/**
 * B0-943 — the advisory lease. Two workers grading the same report at once is not a correctness
 * bug (`pendingPasses` re-derives from `casePassScores` either way) but it is a real bill: three
 * `claude-opus-5` passes per case, paid twice. What is pinned here is that a background hop stands
 * down while somebody else's lease is live, that an expired lease does not block anyone, and that
 * an interactive caller is never blocked.
 *
 * Everything `generateReport` touches outside its own module is mocked — no database, no grading
 * model, no network.
 */

/**
 * The orchestrator mutates ONE state object in place across the whole call, so a spy that kept the
 * reference would show every checkpoint as the final state. Snapshot what each write actually saw.
 */
const savedStates: Array<{ activeWorker: string | null; activeUntil: string | null }> = [];
const saveReportState = vi.fn(async (_id: string, state: unknown) => {
  const { activeWorker, activeUntil } = state as {
    activeWorker: string | null;
    activeUntil: string | null;
  };
  savedStates.push({ activeWorker, activeUntil });
});
let reportStateRow: unknown = null;

vi.mock('~/lib/tests/repository', () => ({
  getTestResultById: vi.fn(async (id: string) => ({
    id,
    test_id: 'test-1',
    status: 'completed',
    report_state: reportStateRow,
    report_generated_at: null,
  })),
  getTestById: vi.fn(async () => ({ id: 'test-1', name: 'Test' })),
  getTestItemsByTestId: vi.fn(async () => [{ id: 'item-1' }]),
  listAllResultItemsByResultId: vi.fn(async () => []),
  saveReportMarkdown: vi.fn().mockResolvedValue(undefined),
  saveReportState: (...args: unknown[]) => saveReportState(...args),
}));

vi.mock('./expected-sources-repository', () => ({
  loadExpectedSourceIndexForItems: vi.fn(async () => new Map()),
}));

vi.mock('./grading-model', () => ({
  describeGradingProviderGap: () => null,
  effortForModel: () => undefined,
  effortFromState: () => undefined,
  loadGradingEffort: vi.fn(async () => undefined),
  loadGradingModelTag: vi.fn(async () => 'gpt-4.1'),
  resolveGradingModel: vi.fn(async () => 'gpt-4.1'),
}));

vi.mock('./consolidate', () => ({
  consolidateCasePasses: vi.fn(() => ({ score: {}, concepts: null })),
  loadConsistencyConfig: vi.fn(async () => ({ passes: 1, spreadThreshold: null })),
}));

vi.mock('./scoring-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scoring-config')>()),
  loadJudgedThresholds: vi.fn(async () => null),
  loadPassMark: vi.fn(async () => 70),
  loadScoringRules: vi.fn(async () => null),
}));

vi.mock('./case-scorer', () => ({
  GRADING_PROMPT_HASH: 'hash',
  scoreCase: vi.fn(),
  unableToEvaluateScore: vi.fn(() => ({})),
}));

vi.mock('./synthesizer', () => ({ synthesizeReportFindings: vi.fn() }));
vi.mock('./assemble', () => ({
  assembleReportCases: vi.fn(),
  indexLatestResultItems: vi.fn(() => new Map()),
}));
vi.mock('./render', () => ({ renderReportMarkdown: vi.fn() }));

const { generateReport } = await import('./orchestrator');

function leasedState(activeUntil: string | null, activeWorker: string | null) {
  return {
    ...emptyReportState('gpt-4.1', 1, 1),
    status: 'scoring' as const,
    activeWorker,
    activeUntil,
  };
}

beforeEach(() => {
  saveReportState.mockClear();
  savedStates.length = 0;
  reportStateRow = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('generateReport lease (B0-943)', () => {
  it('stands down without writing anything when another worker holds a live lease', async () => {
    reportStateRow = leasedState(
      new Date(Date.now() + 120_000).toISOString(),
      'someone-else',
    );

    const state = await generateReport('run-1', {
      workerId: 'background',
      skipIfLeased: true,
    });

    expect(state.activeWorker).toBe('someone-else');
    // No status write at all: the incumbent's checkpoint must not be overwritten.
    expect(saveReportState).not.toHaveBeenCalled();
  });

  it('takes the lease when the previous holder’s TTL has expired', async () => {
    reportStateRow = leasedState(
      new Date(Date.now() - 1_000).toISOString(),
      'dead-worker',
    );

    await generateReport('run-1', { workerId: 'background', skipIfLeased: true });

    expect(savedStates.length).toBeGreaterThan(0);
    expect(savedStates[0].activeWorker).toBe('background');
  });

  it('lets an interactive caller take over a live lease (no skipIfLeased)', async () => {
    reportStateRow = leasedState(
      new Date(Date.now() + 120_000).toISOString(),
      'background',
    );

    await generateReport('run-1', { workerId: 'human' });

    expect(savedStates.length).toBeGreaterThan(0);
    expect(savedStates[0].activeWorker).toBe('human');
  });

  it('re-entrantly renews its own lease rather than skipping itself', async () => {
    reportStateRow = leasedState(new Date(Date.now() + 120_000).toISOString(), 'me');

    await generateReport('run-1', { workerId: 'me', skipIfLeased: true });

    expect(saveReportState).toHaveBeenCalled();
  });
});

describe('report_state legacy compatibility (B0-943)', () => {
  it('parses a row persisted before activeWorker/activeUntil existed', () => {
    // A parse failure here would drop every already-scored case to the orchestrator's "start
    // fresh" path and throw away real grading spend, so this is the invariant that matters.
    const legacy = { ...emptyReportState('gpt-4.1', 3, 3) } as Record<string, unknown>;
    delete legacy.activeWorker;
    delete legacy.activeUntil;

    const parsed = parseReportState(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed?.activeWorker).toBeNull();
    expect(parsed?.activeUntil).toBeNull();
  });

  it('keeps both new fields nullable on a round-trip', () => {
    const result = reportStateSchema.safeParse({
      ...emptyReportState('gpt-4.1', 1, 1),
      activeWorker: 'w',
      activeUntil: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});
