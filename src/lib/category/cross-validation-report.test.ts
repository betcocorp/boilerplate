import { describe, expect, it } from 'vitest';

import {
  buildCrossValidationReport,
  type CategoryLinkRow,
  type ProdLineIdentity,
  type SitePlacement,
} from '~/lib/category/cross-validation-report';

const prodLines: ProdLineIdentity[] = [
  { prodLineKey: 'L1', title: 'Disinfectant Line' },
  { prodLineKey: 'L2', title: 'Floor Line' },
  { prodLineKey: 'L3', title: 'Orphan Line' },
];

const link = (prodLineKey: string, categoryKey: string, source = 'betco_site_scrape'): CategoryLinkRow => ({
  prodLineKey,
  categoryKey,
  source,
});

describe('buildCrossValidationReport (B0-38)', () => {
  it('flags unlinked prod-lines', () => {
    const report = buildCrossValidationReport({
      prodLines,
      links: [link('L1', 'disinfectants'), link('L2', 'floor-care')],
    });
    expect(report.unlinked.map((u) => u.prodLineKey)).toEqual(['L3']);
    expect(report.summary.unlinked).toBe(1);
    expect(report.summary.linkedProdLines).toBe(2);
  });

  it('flags multi-linked prod-lines with all their categories', () => {
    const report = buildCrossValidationReport({
      prodLines,
      links: [link('L1', 'disinfectants'), link('L1', 'sanitizers', 'classifier'), link('L2', 'floor-care')],
    });
    expect(report.multiLinked).toHaveLength(1);
    expect(report.multiLinked[0].prodLineKey).toBe('L1');
    expect(report.multiLinked[0].categories.map((c) => c.categoryKey).sort()).toEqual([
      'disinfectants',
      'sanitizers',
    ]);
  });

  it('does not run the site comparison when no placements are provided', () => {
    const report = buildCrossValidationReport({
      prodLines,
      links: [link('L1', 'disinfectants')],
    });
    expect(report.summary.siteComparisonRun).toBe(false);
    expect(report.siteDisagreements).toEqual([]);
  });

  it('flags a site placement that disagrees with the linked node', () => {
    const sitePlacements: SitePlacement[] = [
      { prodLineKey: 'L1', categoryKey: 'sanitizers' }, // site says sanitizers, we linked disinfectants
      { prodLineKey: 'L2', categoryKey: 'floor-care' }, // agrees
      { prodLineKey: 'L3', categoryKey: 'odor-control' }, // site has it, we have no link
    ];
    const report = buildCrossValidationReport({
      prodLines,
      links: [link('L1', 'disinfectants'), link('L2', 'floor-care')],
      sitePlacements,
    });
    expect(report.summary.siteComparisonRun).toBe(true);
    expect(report.summary.siteEvaluated).toBe(3);
    expect(report.siteDisagreements.map((d) => d.prodLineKey)).toEqual(['L1', 'L3']);
    const l1 = report.siteDisagreements.find((d) => d.prodLineKey === 'L1');
    expect(l1?.linkedCategories).toEqual(['disinfectants']);
    expect(l1?.siteCategory).toBe('sanitizers');
  });

  it('produces deterministic ordering for a stable diff', () => {
    const links = [link('L2', 'floor-care'), link('L1', 'disinfectants')];
    const a = buildCrossValidationReport({ prodLines: [...prodLines].reverse(), links });
    const b = buildCrossValidationReport({ prodLines, links });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
