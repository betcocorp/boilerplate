import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SNAPSHOT_SCHEMA_VERSION,
  buildSnapshot,
  parseSnapshot,
  readSnapshot,
  snapshotFileName,
  tallyUnscorable,
  writeSnapshot,
  type Snapshot,
  type SnapshotEpisodeResult,
  type SnapshotInput,
} from './snapshot';
import { DEFAULT_SCORING_OPTIONS } from './types';

function episodeResult(overrides: Partial<SnapshotEpisodeResult> = {}): SnapshotEpisodeResult {
  return {
    episodeId: 'tri-1',
    itemId: 'item-1',
    rowIndex: 0,
    question: 'What is the dilution?',
    passed: true,
    coverage: {
      requested: 4,
      resolved: 4,
      missing: 0,
      synthetic: 0,
      noChunkId: 0,
      resolvedShare: 1,
    },
    metrics: {
      'ap@10': { scored: true, value: 0.75 },
    },
    ...overrides,
  };
}

function snapshotInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    snapshotId: 'snap-1',
    createdAt: '2026-09-12T10:00:00.000Z',
    runId: 'run-abcdef12',
    questionSetId: 'qs-1',
    questionSetName: 'product-specialist-25',
    label: 'pre-docling',
    options: DEFAULT_SCORING_OPTIONS,
    episodeCount: 1,
    coverage: {
      requested: 4,
      resolved: 4,
      missing: 0,
      synthetic: 0,
      noChunkId: 0,
      resolvedShare: 1,
    },
    labelling: {
      items: 1,
      judgements: 1,
      labelled: 1,
      unlabelled: 0,
      documentLabelled: 1,
      entityLabelled: 0,
      orphanJudgements: 0,
      labelledShare: 1,
    },
    episodes: [episodeResult()],
    aggregates: [
      {
        metric: 'ap@10',
        value: 0.75,
        scoredCount: 1,
        unscorableCount: 0,
        unscorableByReason: {},
      },
    ],
    unscorableByReason: {},
    notes: null,
    ...overrides,
  };
}

async function scratchDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'phase3-snapshot-'));
}

describe('buildSnapshot', () => {
  it('stamps the current schema version', () => {
    expect(buildSnapshot(snapshotInput()).schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
  });
});

describe('parseSnapshot', () => {
  it('accepts a snapshot at the current version', () => {
    const result = parseSnapshot(buildSnapshot(snapshotInput()));
    expect(result.ok).toBe(true);
  });

  it('refuses a schema version it does not know rather than reading it best-effort', () => {
    const future = { ...buildSnapshot(snapshotInput()), schemaVersion: 99 };
    const result = parseSnapshot(future);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('99');
    expect(result.error).toContain('not supported');
  });

  it('refuses a snapshot with no schemaVersion', () => {
    const withVersion = buildSnapshot(snapshotInput()) as Partial<Snapshot>;
    delete withVersion.schemaVersion;
    const result = parseSnapshot(withVersion);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('schemaVersion');
  });

  it('reports validation issues with their path', () => {
    const broken = buildSnapshot(snapshotInput()) as unknown as Record<string, unknown>;
    broken.options = { ...DEFAULT_SCORING_OPTIONS, fusion: 'bogus' };

    const result = parseSnapshot(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues?.join('\n')).toContain('options.fusion');
  });

  it('preserves the scoring options that produced the numbers', () => {
    const options = { ...DEFAULT_SCORING_OPTIONS, fusion: 'first_call' as const, basis: 'retrieved' as const };
    const result = parseSnapshot(buildSnapshot(snapshotInput({ options })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.options).toEqual(options);
  });

  it('keeps an unscorable episode as a reason, never as a zero', () => {
    const result = parseSnapshot(
      buildSnapshot(
        snapshotInput({
          episodes: [
            episodeResult({
              metrics: { 'ap@10': { scored: false, reason: 'no_judgement', detail: 'unlabelled' } },
            }),
          ],
          aggregates: [
            {
              metric: 'ap@10',
              value: null,
              scoredCount: 0,
              unscorableCount: 1,
              unscorableByReason: { no_judgement: 1 },
            },
          ],
          unscorableByReason: { no_judgement: 1 },
        }),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.aggregates[0]?.value).toBeNull();
    expect(result.snapshot.episodes[0]?.metrics['ap@10']).toEqual({
      scored: false,
      reason: 'no_judgement',
      detail: 'unlabelled',
    });
  });

  it('rejects an unknown unscorable reason', () => {
    const broken = buildSnapshot(
      snapshotInput({
        episodes: [
          episodeResult({
            metrics: {
              'ap@10': { scored: false, reason: 'vibes' as never, detail: null },
            },
          }),
        ],
      }),
    );

    expect(parseSnapshot(broken).ok).toBe(false);
  });
});

describe('writeSnapshot / readSnapshot', () => {
  it('round-trips a snapshot through disk', async () => {
    const dir = await scratchDir();
    const file = path.join(dir, 'nested', 'snap.json');
    const snapshot = buildSnapshot(snapshotInput());

    await writeSnapshot(file, snapshot);
    const result = await readSnapshot(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot).toEqual(snapshot);
    expect((await readFile(file, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('refuses to write a snapshot that could not be read back', async () => {
    const dir = await scratchDir();
    const broken = { ...buildSnapshot(snapshotInput()), schemaVersion: 42 } as Snapshot;

    await expect(writeSnapshot(path.join(dir, 'snap.json'), broken)).rejects.toThrow(
      /Refusing to write an invalid snapshot/,
    );
  });

  it('reports unreadable JSON instead of throwing', async () => {
    const dir = await scratchDir();
    const file = path.join(dir, 'snap.json');
    await writeFile(file, '{not json', 'utf8');

    const result = await readSnapshot(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('not valid JSON');
  });

  it('reports a missing file instead of throwing', async () => {
    const dir = await scratchDir();
    const result = await readSnapshot(path.join(dir, 'nope.json'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Cannot read snapshot');
  });
});

describe('tallyUnscorable', () => {
  it('counts per (episode, metric), because one episode can be scoreable for one metric only', () => {
    const tally = tallyUnscorable([
      episodeResult({
        metrics: {
          'ap@10': { scored: false, reason: 'no_judgement', detail: null },
          entity_recall: { scored: true, value: 1 },
        },
      }),
      episodeResult({
        episodeId: 'tri-2',
        metrics: {
          'ap@10': { scored: false, reason: 'no_judgement', detail: null },
          entity_recall: { scored: false, reason: 'coverage_below_floor', detail: null },
        },
      }),
    ]);

    expect(tally).toEqual({ no_judgement: 2, coverage_below_floor: 1 });
  });
});

describe('snapshotFileName', () => {
  it('is filesystem-safe and sorts chronologically within a run', () => {
    const name = snapshotFileName('run-abcdef1234', '2026-09-12T10:00:00.000Z');
    expect(name).toBe('phase3-run-abcd-2026-09-12T10-00-00-000Z.json');
    expect(name).not.toMatch(/[:]/);
  });
});
