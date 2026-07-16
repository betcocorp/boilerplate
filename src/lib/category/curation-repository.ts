import {
  CLASSIFIER_LINK_SOURCE,
  HUMAN_CURATED_LINK_SOURCE,
  loadProdLineClassifierInputs,
} from '~/lib/category/classifier-repository';
import {
  buildCrossValidationReport,
  loadAllCategoryLinks,
  loadLegacyProdLines,
} from '~/lib/category/cross-validation-report';
import { DEFAULT_CLASSIFIER_MIN_CONFIDENCE } from '~/lib/category/product-classifier';
import { loadTaxonomyNodes } from '~/lib/category/taxonomy-repository';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-36 — reads + writes for the admin category-curation screen over `public.product_category_link`.
 *
 * Approvals and reassignments always land as `source='human_curated'`, which the delta sync (B0-37)
 * treats as frozen — so a human decision is never silently changed by a re-run. Numeric `confidence`
 * comes back from PostgREST as a string and is coerced here.
 */

export type CurationFilter = 'all' | 'low_confidence' | 'classifier' | 'human_curated' | 'unlinked';

export const CURATION_FILTERS: CurationFilter[] = [
  'all',
  'low_confidence',
  'classifier',
  'human_curated',
  'unlinked',
];

export function parseCurationFilter(value: string | null | undefined): CurationFilter {
  return (CURATION_FILTERS as string[]).includes(value ?? '')
    ? (value as CurationFilter)
    : 'all';
}

export type CurationLinkRow = {
  prodLineKey: string;
  prodLineId: string | null;
  prodLineTitle: string | null;
  categoryKey: string;
  categoryName: string | null;
  categoryPath: string[];
  source: string;
  confidence: number;
};

export type CurationTaxonomyOption = { key: string; name: string; path: string[] };

export type CurationListResult = {
  rows: CurationLinkRow[];
  page: number;
  pageSize: number;
  total: number;
};

const DEFAULT_PAGE_SIZE = 25;
const toNumber = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

type LooseRow = Record<string, unknown>;
type LinkQuery = {
  select: (cols: string, opts?: { count: 'exact' }) => LinkQuery;
  eq: (col: string, v: unknown) => LinkQuery;
  lt: (col: string, v: unknown) => LinkQuery;
  order: (col: string, opts: { ascending: boolean }) => LinkQuery;
  range: (from: number, to: number) => PromiseLike<{ data: LooseRow[] | null; count: number | null; error: { message: string } | null }>;
};

function linkTable(): LinkQuery {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: string) => { from: (t: string) => LinkQuery };
  };
  return sb.schema('public').from('product_category_link');
}

/** List category links for the curation table, filtered + paginated, with node + product display. */
export async function listCategoryLinkRows(input: {
  filter: CurationFilter;
  page?: number;
  pageSize?: number;
}): Promise<CurationListResult> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const from = (page - 1) * pageSize;

  let query = linkTable()
    .select('category_key, prod_line_key, prod_line_id, source, confidence', { count: 'exact' })
    .order('confidence', { ascending: true });

  if (input.filter === 'low_confidence') {
    query = query.eq('source', CLASSIFIER_LINK_SOURCE).lt('confidence', DEFAULT_CLASSIFIER_MIN_CONFIDENCE);
  } else if (input.filter === 'classifier') {
    query = query.eq('source', CLASSIFIER_LINK_SOURCE);
  } else if (input.filter === 'human_curated') {
    query = query.eq('source', HUMAN_CURATED_LINK_SOURCE);
  }

  const { data, count, error } = await query.range(from, from + pageSize - 1);
  if (error) throw new Error(error.message);
  const linkRows = data ?? [];

  const prodLineKeys = [...new Set(linkRows.map((r) => String(r.prod_line_key)))];

  const [nodes, prodInputs] = await Promise.all([
    loadTaxonomyNodes(),
    loadProdLineClassifierInputs(prodLineKeys),
  ]);
  const nodeByKey = new Map(nodes.map((n) => [n.key, n]));
  const titleByLine = new Map(prodInputs.map((p) => [p.prodLineKey, p.title]));

  const rows: CurationLinkRow[] = linkRows.map((r) => {
    const categoryKey = String(r.category_key);
    const node = nodeByKey.get(categoryKey);
    const prodLineKey = String(r.prod_line_key);
    return {
      prodLineKey,
      prodLineId: typeof r.prod_line_id === 'string' ? r.prod_line_id : null,
      prodLineTitle: titleByLine.get(prodLineKey) ?? null,
      categoryKey,
      categoryName: node?.name ?? null,
      categoryPath: node?.path ?? [],
      source: String(r.source ?? ''),
      confidence: toNumber(r.confidence),
    };
  });

  return { rows, page, pageSize, total: count ?? rows.length };
}

/** The unlinked queue: legacy prod-lines with no category link, as curation rows (empty category). */
export async function listUnlinkedRows(input: {
  page?: number;
  pageSize?: number;
}): Promise<CurationListResult> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const [prodLines, links] = await Promise.all([loadLegacyProdLines(), loadAllCategoryLinks()]);
  const report = buildCrossValidationReport({ prodLines, links });
  const from = (page - 1) * pageSize;
  const rows: CurationLinkRow[] = report.unlinked
    .slice(from, from + pageSize)
    .map((u) => ({
      prodLineKey: u.prodLineKey,
      prodLineId: null,
      prodLineTitle: u.title,
      categoryKey: '',
      categoryName: null,
      categoryPath: [],
      source: '',
      confidence: 0,
    }));
  return { rows, page, pageSize, total: report.unlinked.length };
}

/** Taxonomy nodes for the reassignment dropdown. */
export async function listTaxonomyOptions(): Promise<CurationTaxonomyOption[]> {
  const nodes = await loadTaxonomyNodes();
  return nodes
    .map((n) => ({ key: n.key, name: n.name, path: n.path ?? [] }))
    .sort((a, b) => (a.path.join(' > ') < b.path.join(' > ') ? -1 : 1));
}

/** Approve a link: mark it human-curated so the delta sync (B0-37) never changes it. */
export async function approveCategoryLink(categoryKey: string, prodLineKey: string): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .schema('public')
    .from('product_category_link')
    .update({ source: HUMAN_CURATED_LINK_SOURCE })
    .eq('category_key', categoryKey)
    .eq('prod_line_key', prodLineKey);
  if (error) throw new Error(error.message);
}

/** Reassign a prod-line to a new node (human-curated), removing the old link. */
export async function reassignCategoryLink(input: {
  prodLineKey: string;
  prodLineId: string | null;
  fromCategoryKey: string;
  toCategoryKey: string;
  confidence?: number;
}): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { error: upsertError } = await supabase
    .schema('public')
    .from('product_category_link')
    .upsert(
      {
        category_key: input.toCategoryKey,
        prod_line_key: input.prodLineKey,
        prod_line_id: input.prodLineId,
        source: HUMAN_CURATED_LINK_SOURCE,
        confidence: input.confidence ?? 1,
      },
      { onConflict: 'category_key,prod_line_key' },
    );
  if (upsertError) throw new Error(upsertError.message);

  if (input.fromCategoryKey && input.fromCategoryKey !== input.toCategoryKey) {
    const { error: delError } = await supabase
      .schema('public')
      .from('product_category_link')
      .delete()
      .eq('category_key', input.fromCategoryKey)
      .eq('prod_line_key', input.prodLineKey);
    if (delError) throw new Error(delError.message);
  }
}

/** Remove a link outright. */
export async function deleteCategoryLink(categoryKey: string, prodLineKey: string): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .schema('public')
    .from('product_category_link')
    .delete()
    .eq('category_key', categoryKey)
    .eq('prod_line_key', prodLineKey);
  if (error) throw new Error(error.message);
}
