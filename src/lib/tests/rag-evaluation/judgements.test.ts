import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EPISODE_FIXTURES } from './fixtures/episodes';
import {
  hasDocumentLabels,
  hasEntityLabels,
  indexJudgements,
  isUnlabelled,
  loadJudgementsFile,
  parseJudgements,
  summarizeLabellingCoverage,
} from './judgements';
import type { Judgement, RetrievalEpisode } from './types';

function judgement(overrides: Partial<Judgement> = {}): Judgement {
  return {
    itemId: 'item-1',
    relevantDocuments: [{ documentId: 'doc-a', gain: 2 }],
    entities: [],
    isNegative: false,
    notes: null,
    ...overrides,
  };
}

function episode(itemId: string): RetrievalEpisode {
  return { ...EPISODE_FIXTURES.clean, episodeId: `tri-${itemId}`, itemId };
}

async function scratchDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'phase3-judgements-'));
}

describe('parseJudgements', () => {
  it('accepts a bare array', () => {
    const result = parseJudgements([judgement()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgements).toHaveLength(1);
  });

  it('accepts a wrapper object so labelling provenance has somewhere to live', () => {
    const result = parseJudgements({ judgements: [judgement()], labeller: 'jake' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgements[0]?.itemId).toBe('item-1');
  });

  it('loads an empty file cleanly — no labels yet is the normal state, not an error', () => {
    expect(parseJudgements([])).toEqual({ ok: true, judgements: [], source: '<memory>' });
    const wrapped = parseJudgements({ judgements: [] });
    expect(wrapped.ok).toBe(true);
  });

  it('defaults the optional fields so a minimal hand-written entry validates', () => {
    const result = parseJudgements([{ itemId: 'item-1' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgements[0]).toEqual({
      itemId: 'item-1',
      relevantDocuments: [],
      entities: [],
      isNegative: false,
      notes: null,
    });
  });

  it('reports the path of a bad field rather than throwing', () => {
    const result = parseJudgements([
      judgement({ entities: [{ key: 'epa', kind: 'nope' as never, values: ['x'], required: true }] }),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe('0.entities.0.kind');
  });

  it('rejects an entity requirement with no accepted values', () => {
    const result = parseJudgements([
      judgement({ entities: [{ key: 'epa', kind: 'epa_registration', values: [], required: true }] }),
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate judgements for one item — ground truth must not depend on file order', () => {
    const result = parseJudgements([judgement(), judgement({ relevantDocuments: [] })]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain('Duplicate judgement for itemId item-1');
  });
});

describe('loadJudgementsFile', () => {
  it('treats a missing file as zero judgements — before D1/D2 there is no file', async () => {
    const dir = await scratchDir();
    const result = await loadJudgementsFile(path.join(dir, 'absent.json'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgements).toEqual([]);
  });

  it('treats an empty file as zero judgements', async () => {
    const dir = await scratchDir();
    const file = path.join(dir, 'empty.json');
    await writeFile(file, '   \n', 'utf8');

    const result = await loadJudgementsFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgements).toEqual([]);
  });

  it('reports malformed JSON rather than swallowing it', async () => {
    const dir = await scratchDir();
    const file = path.join(dir, 'bad.json');
    await writeFile(file, '{oops', 'utf8');

    const result = await loadJudgementsFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain('Invalid JSON');
  });

  it('loads a partial file and keeps the source path for reporting', async () => {
    const dir = await scratchDir();
    const file = path.join(dir, 'partial.json');
    await writeFile(file, JSON.stringify([judgement({ itemId: 'item-2' })]), 'utf8');

    const result = await loadJudgementsFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe(file);
    expect(result.judgements.map((j) => j.itemId)).toEqual(['item-2']);
  });
});

describe('isUnlabelled', () => {
  it('is true for an absent judgement', () => {
    expect(isUnlabelled(undefined)).toBe(true);
  });

  it('is true for a present-but-empty judgement — same evidential state as absent', () => {
    expect(isUnlabelled(judgement({ relevantDocuments: [], entities: [] }))).toBe(true);
  });

  it('is false for an explicit negative — "retrieve nothing" is a real expectation', () => {
    expect(isUnlabelled(judgement({ relevantDocuments: [], entities: [], isNegative: true }))).toBe(
      false,
    );
  });

  it('is false when only entities are labelled', () => {
    expect(
      isUnlabelled(
        judgement({
          relevantDocuments: [],
          entities: [{ key: 'epa', kind: 'epa_registration', values: ['1839-83'], required: true }],
        }),
      ),
    ).toBe(false);
  });
});

describe('hasDocumentLabels / hasEntityLabels', () => {
  it('separates the two dimensions so a run cannot claim coverage it lacks', () => {
    const entitiesOnly = judgement({
      relevantDocuments: [],
      entities: [{ key: 'din', kind: 'din', values: ['02245678'], required: true }],
    });

    expect(hasDocumentLabels(entitiesOnly)).toBe(false);
    expect(hasEntityLabels(entitiesOnly)).toBe(true);

    const docsOnly = judgement();
    expect(hasDocumentLabels(docsOnly)).toBe(true);
    expect(hasEntityLabels(docsOnly)).toBe(false);

    expect(hasDocumentLabels(judgement({ relevantDocuments: [], isNegative: true }))).toBe(true);
    expect(hasDocumentLabels(undefined)).toBe(false);
    expect(hasEntityLabels(undefined)).toBe(false);
  });
});

describe('summarizeLabellingCoverage', () => {
  it('reports labelled, unlabelled and orphan judgements', () => {
    const episodes = [episode('item-1'), episode('item-2'), episode('item-3')];
    const judgements = [
      judgement({ itemId: 'item-1' }),
      // Present but empty: counts as unlabelled, not as "nothing relevant".
      judgement({ itemId: 'item-2', relevantDocuments: [] }),
      // No such episode — a re-seeded question set.
      judgement({ itemId: 'item-ghost' }),
    ];

    const coverage = summarizeLabellingCoverage(episodes, judgements);

    expect(coverage.episodes).toBe(3);
    expect(coverage.items).toBe(3);
    expect(coverage.judgements).toBe(3);
    expect(coverage.labelledItemIds).toEqual(['item-1']);
    expect(coverage.unlabelledItemIds).toEqual(['item-2', 'item-3']);
    expect(coverage.orphanJudgementItemIds).toEqual(['item-ghost']);
    expect(coverage.labelledShare).toBeCloseTo(1 / 3);
  });

  it('reports document and entity labelling separately', () => {
    const episodes = [episode('item-1'), episode('item-2')];
    const judgements = [
      judgement({ itemId: 'item-1' }),
      judgement({
        itemId: 'item-2',
        relevantDocuments: [],
        entities: [{ key: 'dilution', kind: 'dilution', values: ['1:64'], required: true }],
      }),
    ];

    const coverage = summarizeLabellingCoverage(episodes, judgements);

    expect(coverage.documentLabelledItemIds).toEqual(['item-1']);
    expect(coverage.entityLabelledItemIds).toEqual(['item-2']);
    expect(coverage.unlabelledItemIds).toEqual([]);
  });

  it('deduplicates items repeated across episodes', () => {
    const coverage = summarizeLabellingCoverage(
      [episode('item-1'), { ...episode('item-1'), episodeId: 'tri-dup' }],
      [judgement({ itemId: 'item-1' })],
    );

    expect(coverage.episodes).toBe(2);
    expect(coverage.items).toBe(1);
    expect(coverage.labelledShare).toBe(1);
  });

  it('reports a null share rather than 0 when there are no items', () => {
    expect(summarizeLabellingCoverage([], []).labelledShare).toBeNull();
  });

  it('reports every item as unlabelled when no judgements exist at all', () => {
    const episodes = [episode('item-1'), episode('item-2')];
    const coverage = summarizeLabellingCoverage(episodes, []);

    expect(coverage.labelledItemIds).toEqual([]);
    expect(coverage.unlabelledItemIds).toEqual(['item-1', 'item-2']);
    expect(coverage.labelledShare).toBe(0);
  });
});

describe('indexJudgements', () => {
  it('keys by itemId', () => {
    const index = indexJudgements([judgement({ itemId: 'a' }), judgement({ itemId: 'b' })]);
    expect([...index.keys()]).toEqual(['a', 'b']);
  });
});
