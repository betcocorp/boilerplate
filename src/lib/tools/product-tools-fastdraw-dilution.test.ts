import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-636 — `get_efficacy_data`'s `fastDrawDilution` field: FastDraw-dispenser-specific
 * dilution/yield data, kept as a DISTINCT sibling to `facts` (general-use dilution from
 * `rag.product_line_fact`). The two are never merged — for some SKUs they legitimately disagree
 * because they describe different dilution contexts (general use vs. FastDraw dispenser).
 */

vi.mock('~/lib/rag/entity-context', () => ({
  resolveProductEntityByName: vi.fn(async (name: string) => ({
    productLineKey: name.trim() ? 'PL-1' : null,
    productKey: name.trim() ? 'PK-1' : null,
    resolutionSource: name.trim() ? 'title_exact' : null,
    ambiguousAlias: false,
    matchedAliasId: null,
    matchedAliasConfidence: null,
    matchedTitle: null,
  })),
}));

vi.mock('~/lib/retrieval/product-facts', () => ({
  buildFactsBlock: vi.fn(() => 'Rendered facts block'),
  fetchFactsForProductLineKey: vi.fn(async () => null),
  fetchFactsForProductLineKeys: vi.fn(async () => new Map()),
  fetchFactsForProduct: vi.fn(async () => null),
  fetchFactsForProductBatch: vi.fn(async () => []),
  // B0-700 follow-up — `executeProductTool`'s `get_efficacy_data` case now looks this up to label
  // the facts block with the resolved entity's real title; null here mirrors the DB-miss fallback
  // (the tests below assert on `facts`/`fastDrawDilution`, not on the facts-block title).
  fetchEntityTitle: vi.fn(async () => null),
}));

vi.mock('~/lib/retrieval/efficacy-lab-report', () => ({
  fetchCurrentEfficacyLabReport: vi.fn(async () => null),
  renderEfficacyLabReportCitation: vi.fn(() => 'citation'),
}));

vi.mock('~/lib/retrieval/fastdraw-dilution', () => ({
  fetchFastDrawDilution: vi.fn(async () => null),
}));

import { fetchFastDrawDilution } from '~/lib/retrieval/fastdraw-dilution';
import { fetchFactsForProduct } from '~/lib/retrieval/product-facts';
import { executeProductTool } from '~/lib/tools/product-tools';

function fastDrawLookup(overrides: Partial<Parameters<typeof fetchFastDrawDilution>[0]> = {}) {
  void overrides;
  return {
    fastDrawDilution: {
      dilution: '1:256',
      sprayDilution: null,
      gallonYieldPer2Liter: 66.5,
      gallonYieldPer2LiterSpray: null,
      conflictsWithLegacyDilutionCode: true,
    },
    documentId: 'doc-fd-1',
    chunkId: 'chunk-fd-1',
    title: 'FastDraw Dilution — pH7Q',
    documentBody: 'FastDraw dispenser dilution: 1:256, yield 66.5 gal per 2L.',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('get_efficacy_data: fastDrawDilution (B0-636)', () => {
  it('populates fastDrawDilution when a FastDraw chunk exists, without touching facts', async () => {
    vi.mocked(fetchFastDrawDilution).mockResolvedValueOnce(fastDrawLookup());
    vi.mocked(fetchFactsForProduct).mockResolvedValueOnce(null);

    const out = await executeProductTool('get_efficacy_data', { productId: 'pH7Q' });

    expect(out.facts).toBeNull();
    expect(out.fastDrawDilution).toEqual({
      dilution: '1:256',
      sprayDilution: null,
      gallonYieldPer2Liter: 66.5,
      gallonYieldPer2LiterSpray: null,
      conflictsWithLegacyDilutionCode: true,
    });
    const sources = out.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0]?.title).toBe('FastDraw Dispenser Dilution (structured)');
    expect(sources[0]?.documentId).toBe('doc-fd-1');
    expect(sources[0]?.documentKind).toBe('fastdraw_dilution');
    // Distinct from the general facts citation label.
    expect(sources.some((s) => s.title === 'Verified Product Facts (structured)')).toBe(false);
  });

  it('returns fastDrawDilution: null and leaves facts unaffected when no FastDraw chunk exists', async () => {
    vi.mocked(fetchFastDrawDilution).mockResolvedValueOnce(null);
    vi.mocked(fetchFactsForProduct).mockResolvedValueOnce({
      entityId: 'entity-1',
      dilutionOzPerGal: 2,
      dilutionDisplay: '1:64',
      coverageSqFt: null,
      chemistryClass: null,
      productApplication: null,
      productApplicationConfidence: null,
      epaRegistration: null,
      contactTimeSeconds: null,
      confidence: 1,
      efficacy: [],
    });

    const out = await executeProductTool('get_efficacy_data', { productId: 'AF315' });

    expect(out.fastDrawDilution).toBeNull();
    expect(out.facts).toEqual(
      expect.objectContaining({ dilutionDisplay: '1:64', dilutionOzPerGal: 2 }),
    );
    const sources = out.sources as Array<Record<string, unknown>>;
    expect(sources.some((s) => s.documentKind === 'fastdraw_dilution')).toBe(false);
  });

  it('conflicting SKU: facts.dilutionDisplay and fastDrawDilution.dilution both populate independently, neither overwrites the other', async () => {
    vi.mocked(fetchFastDrawDilution).mockResolvedValueOnce(fastDrawLookup());
    vi.mocked(fetchFactsForProduct).mockResolvedValueOnce({
      entityId: 'entity-1',
      dilutionOzPerGal: 2.5,
      // Deliberately a DIFFERENT ratio than the FastDraw chunk's "1:256" — general-use vs.
      // FastDraw-dispenser context legitimately disagree for this SKU.
      dilutionDisplay: '1:64',
      coverageSqFt: null,
      chemistryClass: null,
      productApplication: null,
      productApplicationConfidence: null,
      epaRegistration: null,
      contactTimeSeconds: null,
      confidence: 1,
      efficacy: [],
    });

    const out = await executeProductTool('get_efficacy_data', { productId: 'pH7Q' });

    expect((out.facts as { dilutionDisplay: string | null }).dilutionDisplay).toBe('1:64');
    expect((out.fastDrawDilution as { dilution: string }).dilution).toBe('1:256');

    const sources = out.sources as Array<Record<string, unknown>>;
    const titles = sources.map((s) => s.title);
    expect(titles).toContain('Verified Product Facts (structured)');
    expect(titles).toContain('FastDraw Dispenser Dilution (structured)');
    // Two independent citations, not one merged one.
    expect(sources).toHaveLength(2);
  });

  it('threads both productLineKey and productKey into the FastDraw lookup', async () => {
    vi.mocked(fetchFastDrawDilution).mockResolvedValueOnce(null);
    await executeProductTool('get_efficacy_data', { productId: 'pH7Q' });
    expect(fetchFastDrawDilution).toHaveBeenCalledWith('PL-1', 'PK-1');
  });
});
