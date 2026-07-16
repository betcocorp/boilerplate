import { describe, expect, it, vi } from 'vitest';

import {
  buildClassifierPrompt,
  CLASSIFIER_PROMPT_VERSION,
  formatNodeOptions,
  type ClassifierResult,
} from '~/lib/category/classifier-prompt';
import type { ClassifierLink } from '~/lib/category/classifier-repository';
import type { TaxonomyNode } from '~/lib/category/category-resolver';
import {
  resolveClassifierOutcome,
  runProductClassifier,
  type ClassifyDeps,
} from '~/lib/category/product-classifier';

const NODES: TaxonomyNode[] = [
  { key: 'disinfectants', name: 'Disinfectants', path: ['Cleaning', 'Disinfectants'] },
  { key: 'floor-care', name: 'Floor Care', path: ['Cleaning', 'Floor Care'] },
];
const VALID = new Set(NODES.map((n) => n.key));

const result = (over: Partial<ClassifierResult> = {}): ClassifierResult => ({
  category_key: 'disinfectants',
  confidence: 0.9,
  rationale: 'quat disinfectant',
  ...over,
});

describe('resolveClassifierOutcome (B0-35)', () => {
  it('links a grounded, high-confidence result', () => {
    expect(resolveClassifierOutcome(result(), VALID, 0.7)).toEqual({
      categoryKey: 'disinfectants',
      outcome: 'linked',
    });
  });
  it('queues a grounded, below-threshold result for review', () => {
    expect(resolveClassifierOutcome(result({ confidence: 0.5 }), VALID, 0.7)).toEqual({
      categoryKey: 'disinfectants',
      outcome: 'queued',
    });
  });
  it('marks "none" as unclassified', () => {
    expect(resolveClassifierOutcome(result({ category_key: 'none' }), VALID, 0.7)).toEqual({
      categoryKey: null,
      outcome: 'unclassified',
    });
  });
  it('rejects a key not in the option set (grounding)', () => {
    expect(resolveClassifierOutcome(result({ category_key: 'made-up' }), VALID, 0.7)).toEqual({
      categoryKey: null,
      outcome: 'unclassified',
    });
  });
});

describe('runProductClassifier (B0-35)', () => {
  const inputs = [
    { prodLineKey: 'L1', prodLineId: 'P1', title: 'Quat Disinfectant', description: null },
    { prodLineKey: 'L2', prodLineId: 'P2', title: 'Mystery Product', description: null },
    { prodLineKey: 'L3', prodLineId: 'P3', title: 'Weak Floor Signal', description: null },
  ];

  it('routes each prod-line and persists only grounded proposals', async () => {
    const persisted: ClassifierLink[] = [];
    const byLine: Record<string, ClassifierResult> = {
      L1: result({ category_key: 'disinfectants', confidence: 0.95 }), // linked
      L2: result({ category_key: 'none', confidence: 0 }), // unclassified
      L3: result({ category_key: 'floor-care', confidence: 0.55 }), // queued
    };
    let idx = 0;
    const deps: ClassifyDeps = {
      loadNodes: async () => NODES,
      classify: async () => byLine[inputs[idx++].prodLineKey],
      persistLink: async (link) => { persisted.push(link); },
    };

    const { proposals, summary } = await runProductClassifier(inputs, deps, { minConfidence: 0.7 });

    expect(summary).toEqual({ total: 3, linked: 1, queued: 1, unclassified: 1 });
    // grounded proposals (linked + queued) are persisted; the unclassified one is not
    expect(persisted.map((p) => p.prodLineKey).sort()).toEqual(['L1', 'L3']);
    expect(proposals.every((p) => p.promptVersion === CLASSIFIER_PROMPT_VERSION)).toBe(true);
    expect(proposals.every((p) => p.optionCount === NODES.length)).toBe(true);
    expect(proposals.find((p) => p.prodLineKey === 'L2')?.categoryKey).toBeNull();
  });

  it('does not persist when nothing is grounded', async () => {
    const persist = vi.fn(async () => {});
    const deps: ClassifyDeps = {
      loadNodes: async () => NODES,
      classify: async () => result({ category_key: 'none', confidence: 0 }),
      persistLink: persist,
    };
    const { summary } = await runProductClassifier([inputs[0]], deps);
    expect(summary.unclassified).toBe(1);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('classifier prompt (B0-35)', () => {
  it('lists every node key as an option', () => {
    const options = formatNodeOptions(NODES);
    expect(options).toContain('disinfectants:');
    expect(options).toContain('floor-care:');
    const prompt = buildClassifierPrompt(NODES);
    expect(prompt).toContain('Disinfectants');
    expect(prompt).toContain('"none"');
  });
});
