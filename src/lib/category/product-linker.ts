/**
 * B0-34 — Deterministic product→category linker.
 *
 * The authoritative signal is the live betco.com catalog itself: every category page lists its
 * products as `/products/<slug>/<stem>`, where `<stem>` is the product's SKU base. We scrape each
 * `betco_site` taxonomy node (B0-33) for its stems, match stems back to `legacy.products` by SKU
 * base, place each product at the *deepest* node it appears under, then roll placements up to a
 * `prod_line_key → node` link (the primary product-line signal the retrieval path consumes).
 *
 * This file is the pure, unit-testable core; the ingest runner supplies the scraped stems + product
 * rows and persists the returned links into `public.product_category_link`.
 */

export const LINK_SOURCE_SITE_SCRAPE = 'betco_site_scrape';

/** Minimum share of a prod-line's placed products that must agree on a node to link confidently. */
export const MIN_LINK_AGREEMENT = 0.5;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A product's SKU belongs to a betco category `stem` iff the SKU is `<stem><2-char pack code>-…`
 * (case-insensitive). Web SKUs are `<base><2-char pack><-variant>` (e.g. `104B5-00`, `09923-00`,
 * `167804-00`); internal `PL…` SKUs never appear as site stems, so they never match.
 */
export function skuMatchesStem(sku: string | null | undefined, stem: string): boolean {
  if (!sku || !stem) return false;
  return new RegExp(`^${escapeRegExp(stem)}[A-Za-z0-9]{2}-`, 'i').test(sku.trim());
}

/**
 * The stem a SKU would be listed under on betco.com — its base with the trailing 2-char pack code
 * dropped, lowercased to match the URL. Returns null when the SKU has no derivable base (e.g. the
 * internal `PL…` SKUs), which safely yields no placement rather than a wrong one.
 */
export function stemForSku(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const head = sku.trim().split('-')[0];
  if (head.length < 3) return null; // base(≥1) + 2-char pack code
  return head.slice(0, -2).toLowerCase();
}

export type ScrapedNode = { nodeKey: string; depth: number; stems: string[] };
export type LinkableProduct = {
  productKey: string;
  sku: string | null;
  prodLineKey: string | null;
};
export type CategoryLink = {
  prodLineKey: string;
  categoryKey: string;
  confidence: number;
  source: string;
};
export type NeedsClassifier = {
  prodLineKey: string;
  reason: 'no_site_placement' | 'ambiguous';
};
export type LinkResult = {
  links: CategoryLink[];
  needsClassifier: NeedsClassifier[];
  placedProducts: number;
};

/**
 * Place products at their deepest matching node and roll up to confident `prod_line → node` links.
 * Prod-lines whose placed products don't reach {@link MIN_LINK_AGREEMENT} on a single node, or that
 * have no placement at all, are returned in the needs-classifier bucket instead of being linked.
 */
export function buildCategoryLinks(
  scraped: ScrapedNode[],
  products: LinkableProduct[],
): LinkResult {
  // stem -> deepest node that lists it (site parent pages repeat descendant products; keep deepest)
  const stemToNode = new Map<string, { nodeKey: string; depth: number }>();
  for (const node of scraped) {
    for (const stem of node.stems) {
      const key = stem.toLowerCase();
      const prev = stemToNode.get(key);
      if (!prev || node.depth > prev.depth) {
        stemToNode.set(key, { nodeKey: node.nodeKey, depth: node.depth });
      }
    }
  }

  // per prod-line, tally how many of its products land on each node
  const byProdLine = new Map<string, { nodeCounts: Map<string, number>; placed: number }>();
  let placedProducts = 0;
  for (const product of products) {
    if (!product.prodLineKey) continue;
    const stem = stemForSku(product.sku);
    const hit = stem ? stemToNode.get(stem) : undefined;
    let bucket = byProdLine.get(product.prodLineKey);
    if (!bucket) {
      bucket = { nodeCounts: new Map(), placed: 0 };
      byProdLine.set(product.prodLineKey, bucket);
    }
    if (!hit) continue;
    placedProducts += 1;
    bucket.placed += 1;
    bucket.nodeCounts.set(hit.nodeKey, (bucket.nodeCounts.get(hit.nodeKey) ?? 0) + 1);
  }

  const links: CategoryLink[] = [];
  const needsClassifier: NeedsClassifier[] = [];
  for (const [prodLineKey, bucket] of byProdLine) {
    if (bucket.placed === 0) {
      needsClassifier.push({ prodLineKey, reason: 'no_site_placement' });
      continue;
    }
    let topNode = '';
    let topCount = 0;
    for (const [nodeKey, count] of bucket.nodeCounts) {
      if (count > topCount) {
        topCount = count;
        topNode = nodeKey;
      }
    }
    const share = topCount / bucket.placed;
    if (share < MIN_LINK_AGREEMENT) {
      needsClassifier.push({ prodLineKey, reason: 'ambiguous' });
      continue;
    }
    links.push({
      prodLineKey,
      categoryKey: topNode,
      confidence: Math.round(share * 100) / 100,
      source: LINK_SOURCE_SITE_SCRAPE,
    });
  }

  return { links, needsClassifier, placedProducts };
}
