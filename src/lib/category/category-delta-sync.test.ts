import { describe, expect, it, vi } from 'vitest';

import type { ExistingCategoryLink } from '~/lib/category/classifier-repository';
import {
  reconcileClassifierLinks,
  runCategoryDeltaSync,
  type CategoryDeltaSyncDeps,
  type IncomingClassifierLink,
} from '~/lib/category/category-delta-sync';

const incoming = (prodLineKey: string, categoryKey: string, confidence = 0.9): IncomingClassifierLink => ({
  prodLineKey,
  prodLineId: `P-${prodLineKey}`,
  categoryKey,
  confidence,
});

const existing = (prodLineKey: string, categoryKey: string, source: string): ExistingCategoryLink => ({
  prodLineKey,
  categoryKey,
  source,
});

describe('reconcileClassifierLinks (B0-37)', () => {
  it('upserts a fresh classifier link when nothing exists', () => {
    const plan = reconcileClassifierLinks({
      deltaProdLineKeys: ['L1'],
      incoming: [incoming('L1', 'disinfectants')],
      existing: [],
    });
    expect(plan.upserts).toHaveLength(1);
    expect(plan.deletes).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.frozenProdLineKeys).toEqual([]);
  });

  it('freezes a prod-line that has a human-curated link (never re-linked)', () => {
    const plan = reconcileClassifierLinks({
      deltaProdLineKeys: ['L1'],
      incoming: [incoming('L1', 'floor-care')],
      existing: [existing('L1', 'disinfectants', 'human_curated')],
    });
    expect(plan.upserts).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.deletes).toEqual([]); // human-curated line is frozen — no classifier deletes either
    expect(plan.frozenProdLineKeys).toEqual(['L1']);
  });

  it('never overwrites an authoritative site-scrape link for the same pair', () => {
    const plan = reconcileClassifierLinks({
      deltaProdLineKeys: ['L1'],
      incoming: [incoming('L1', 'disinfectants')],
      existing: [existing('L1', 'disinfectants', 'betco_site_scrape')],
    });
    expect(plan.upserts).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });

  it('deletes a stale classifier link for a delta line no longer proposed', () => {
    const plan = reconcileClassifierLinks({
      deltaProdLineKeys: ['L1'],
      incoming: [incoming('L1', 'disinfectants')], // now proposes disinfectants
      existing: [existing('L1', 'floor-care', 'classifier')], // previously classified floor-care
    });
    expect(plan.upserts.map((u) => u.categoryKey)).toEqual(['disinfectants']);
    expect(plan.deletes).toEqual([{ categoryKey: 'floor-care', prodLineKey: 'L1' }]);
  });

  it('does not delete classifier links for prod-lines outside the delta', () => {
    const plan = reconcileClassifierLinks({
      deltaProdLineKeys: ['L1'],
      incoming: [incoming('L1', 'disinfectants')],
      existing: [existing('L2', 'floor-care', 'classifier')], // different line, untouched
    });
    expect(plan.deletes).toEqual([]);
  });

  it('is idempotent: re-proposing the same link yields an upsert and no deletes', () => {
    const args = {
      deltaProdLineKeys: ['L1'],
      incoming: [incoming('L1', 'disinfectants')],
      existing: [existing('L1', 'disinfectants', 'classifier')],
    };
    const plan = reconcileClassifierLinks(args);
    expect(plan.upserts).toHaveLength(1);
    expect(plan.deletes).toEqual([]);
  });
});

describe('runCategoryDeltaSync (B0-37)', () => {
  it('no-ops on an empty delta', async () => {
    const applyPlan = vi.fn(async () => {});
    const deps: CategoryDeltaSyncDeps = {
      loadDeltaProdLineKeys: async () => [],
      classify: async () => [],
      loadExisting: async () => [],
      applyPlan,
    };
    const result = await runCategoryDeltaSync(deps);
    expect(result.deltaProdLines).toBe(0);
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it('classifies the delta, reconciles, and applies the plan (preserving curation)', async () => {
    let applied: Parameters<CategoryDeltaSyncDeps['applyPlan']>[0] | null = null;
    const deps: CategoryDeltaSyncDeps = {
      loadDeltaProdLineKeys: async () => ['L1', 'L2'],
      classify: async () => [incoming('L1', 'disinfectants'), incoming('L2', 'floor-care')],
      loadExisting: async () => [existing('L2', 'odor-control', 'human_curated')],
      applyPlan: async (plan) => { applied = plan; },
    };
    const result = await runCategoryDeltaSync(deps);
    expect(result.deltaProdLines).toBe(2);
    expect(result.upserted).toBe(1); // L1 upserted; L2 frozen (human-curated)
    expect(result.frozen).toBe(1);
    expect(result.skipped).toBe(1);
    expect(applied?.upserts.map((u) => u.prodLineKey)).toEqual(['L1']);
  });
});
