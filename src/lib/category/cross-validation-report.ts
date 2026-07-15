import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-38 — on-demand cross-validation of the product→category taxonomy against the legacy catalog
 * and (optionally) the live betco.com category pages.
 *
 * Surfaces three discrepancy classes as a deterministic, diffable artifact:
 *   - unlinked — a legacy prod-line with no `product_category_link` row,
 *   - multiLinked — a prod-line mapped to more than one taxonomy node,
 *   - siteDisagreements — a prod-line whose linked node(s) don't match where betco.com lists it.
 * The pure builder does the reconciliation; the live generator loads the legacy prod-line universe +
 * links and accepts site placements from an injected scraper (there is no in-repo scraper — the
 * site-scrape pattern lives in the B0-33/B0-34 ingest). Every entry carries prod-line + node keys so
 * a UI can link each discrepancy back to the product and the taxonomy node.
 */

export type ProdLineIdentity = { prodLineKey: string; title: string | null };
export type CategoryLinkRow = { prodLineKey: string; categoryKey: string; source: string };
export type SitePlacement = { prodLineKey: string; categoryKey: string };

export type CrossValidationReport = {
  summary: {
    totalProdLines: number;
    linkedProdLines: number;
    unlinked: number;
    multiLinked: number;
    siteComparisonRun: boolean;
    siteEvaluated: number;
    siteDisagreements: number;
  };
  unlinked: Array<{ prodLineKey: string; title: string | null }>;
  multiLinked: Array<{
    prodLineKey: string;
    title: string | null;
    categories: Array<{ categoryKey: string; source: string }>;
  }>;
  siteDisagreements: Array<{
    prodLineKey: string;
    title: string | null;
    linkedCategories: string[];
    siteCategory: string;
  }>;
};

const byProdLineKey = <T extends { prodLineKey: string }>(a: T, b: T): number =>
  a.prodLineKey < b.prodLineKey ? -1 : a.prodLineKey > b.prodLineKey ? 1 : 0;

/** Pure reconciliation: legacy prod-lines + links (+ optional site placements) → diffable report. */
export function buildCrossValidationReport(input: {
  prodLines: ProdLineIdentity[];
  links: CategoryLinkRow[];
  sitePlacements?: SitePlacement[];
}): CrossValidationReport {
  const titleByLine = new Map(input.prodLines.map((p) => [p.prodLineKey, p.title]));

  // prod-line → distinct category links (deduped by category, first source wins for display).
  const linksByLine = new Map<string, Array<{ categoryKey: string; source: string }>>();
  for (const l of input.links) {
    const list = linksByLine.get(l.prodLineKey) ?? [];
    if (!list.some((x) => x.categoryKey === l.categoryKey)) {
      list.push({ categoryKey: l.categoryKey, source: l.source });
    }
    linksByLine.set(l.prodLineKey, list);
  }

  const unlinked: CrossValidationReport['unlinked'] = [];
  const multiLinked: CrossValidationReport['multiLinked'] = [];
  for (const p of input.prodLines) {
    const cats = linksByLine.get(p.prodLineKey) ?? [];
    if (cats.length === 0) {
      unlinked.push({ prodLineKey: p.prodLineKey, title: p.title });
    } else if (cats.length > 1) {
      multiLinked.push({ prodLineKey: p.prodLineKey, title: p.title, categories: cats });
    }
  }

  const siteComparisonRun = input.sitePlacements !== undefined;
  const siteDisagreements: CrossValidationReport['siteDisagreements'] = [];
  const sitePlacements = input.sitePlacements ?? [];
  for (const placement of sitePlacements) {
    const linkedCategories = (linksByLine.get(placement.prodLineKey) ?? []).map((c) => c.categoryKey);
    if (!linkedCategories.includes(placement.categoryKey)) {
      siteDisagreements.push({
        prodLineKey: placement.prodLineKey,
        title: titleByLine.get(placement.prodLineKey) ?? null,
        linkedCategories: [...linkedCategories].sort(),
        siteCategory: placement.categoryKey,
      });
    }
  }

  unlinked.sort(byProdLineKey);
  multiLinked.sort(byProdLineKey);
  siteDisagreements.sort(byProdLineKey);

  return {
    summary: {
      totalProdLines: input.prodLines.length,
      linkedProdLines: input.prodLines.length - unlinked.length,
      unlinked: unlinked.length,
      multiLinked: multiLinked.length,
      siteComparisonRun,
      siteEvaluated: sitePlacements.length,
      siteDisagreements: siteDisagreements.length,
    },
    unlinked,
    multiLinked,
    siteDisagreements,
  };
}

type LooseRow = Record<string, unknown>;

/** Load the legacy prod-line universe (distinct prodline attr keys) with a representative title. */
export async function loadLegacyProdLines(): Promise<ProdLineIdentity[]> {
  const supabase = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: string) => {
      from: (t: string) => {
        select: (cols: string) => {
          ilike: (col: string, v: string) => PromiseLike<{ data: LooseRow[] | null }>;
          in: (col: string, values: readonly unknown[]) => PromiseLike<{ data: LooseRow[] | null }>;
        };
      };
    };
  };
  const legacy = (t: string) => supabase.schema('legacy').from(t);

  const attrRes = await legacy('products_attr').select('ProductsKey, AttrKey').ilike('AttrTable', 'prodline');
  const repByLine = new Map<string, string>();
  for (const r of attrRes.data ?? []) {
    const line = String(r.AttrKey ?? '');
    const pk = typeof r.ProductsKey === 'string' ? r.ProductsKey : null;
    if (line && pk && !repByLine.has(line)) repByLine.set(line, pk);
  }

  const productKeys = [...new Set(repByLine.values())];
  const titleByKey = new Map<string, string | null>();
  if (productKeys.length > 0) {
    const prodRes = await legacy('products').select('ProductsKey, Title, SLDescr').in('ProductsKey', productKeys);
    for (const r of prodRes.data ?? []) {
      if (typeof r.ProductsKey === 'string') {
        titleByKey.set(r.ProductsKey, (r.Title as string | null) ?? (r.SLDescr as string | null) ?? null);
      }
    }
  }

  return [...repByLine.keys()].map((prodLineKey) => ({
    prodLineKey,
    title: titleByKey.get(repByLine.get(prodLineKey) as string) ?? null,
  }));
}

/** Load every product_category_link row. */
export async function loadAllCategoryLinks(): Promise<CategoryLinkRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('public')
    .from('product_category_link')
    .select('category_key, prod_line_key, source');
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    prodLineKey: String((r as LooseRow).prod_line_key),
    categoryKey: String((r as LooseRow).category_key),
    source: String((r as LooseRow).source ?? ''),
  }));
}

export type CrossValidationReportDeps = {
  loadProdLines: () => Promise<ProdLineIdentity[]>;
  loadLinks: () => Promise<CategoryLinkRow[]>;
  /** Optional live-site placements; omit to skip the site-disagreement comparison. */
  loadSitePlacements?: () => Promise<SitePlacement[]>;
};

const defaultDeps: CrossValidationReportDeps = {
  loadProdLines: () => loadLegacyProdLines(),
  loadLinks: () => loadAllCategoryLinks(),
};

/** Generate the report against live data. Site comparison runs only if a placement loader is given. */
export async function generateCrossValidationReport(
  deps: CrossValidationReportDeps = defaultDeps,
): Promise<CrossValidationReport> {
  const [prodLines, links, sitePlacements] = await Promise.all([
    deps.loadProdLines(),
    deps.loadLinks(),
    deps.loadSitePlacements ? deps.loadSitePlacements() : Promise.resolve(undefined),
  ]);
  return buildCrossValidationReport({ prodLines, links, sitePlacements });
}
