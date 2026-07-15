import {
  resolveCategoryFromDb,
  getProductsForCategory,
  type CategoryProduct,
} from '~/lib/category/taxonomy-repository';
import type { CategoryMatch } from '~/lib/category/category-resolver';
import { logInfo } from '~/lib/observability/logger';

/**
 * B0-29 — Category-First router.
 *
 * Runs the deterministic taxonomy resolver (B0-27) and, when a category is matched with high enough
 * confidence, short-circuits to category retrieval (B0-28 — no embeddings/LLM), returning the actual
 * web products for that node. Below threshold, on no match, or on any error it degrades safely to
 * `path: 'semantic'` so the caller runs the normal semantic pipeline. The result always names the
 * path taken (+ confidence + node), which is the response contract the agent tool (B0-30) exposes.
 *
 * The confidence gate is env-tunable, mirroring the existing `BEX_PRODUCT_LINE_LOCK_*` pattern.
 */

const DEFAULT_MIN_CONFIDENCE = 0.8; // ≥ resolver's normalized/alias tiers; fuzzy (≤0.75) → semantic

export type CategoryNodeRef = { key: string; name: string; path: string[] };

export type CategoryRouteResult =
  | {
      path: 'category';
      confidence: number;
      matchType: CategoryMatch['matchType'];
      node: CategoryNodeRef;
      products: CategoryProduct[];
      productCount: number;
      candidates: CategoryNodeRef[];
      latencyMs: number;
    }
  | {
      path: 'semantic';
      reason: 'below_threshold' | 'no_match' | 'error';
      confidence: number | null;
      topCandidate: CategoryNodeRef | null;
      latencyMs: number;
    };

export type RouteCategoryOptions = {
  /** Override the confidence gate (default: env `BEX_CATEGORY_ROUTE_MIN_CONFIDENCE` or 0.8). */
  minConfidence?: number;
};

function envMinConfidence(): number {
  const raw = process.env.BEX_CATEGORY_ROUTE_MIN_CONFIDENCE?.trim();
  if (!raw) return DEFAULT_MIN_CONFIDENCE;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_MIN_CONFIDENCE;
}

const toNodeRef = (m: CategoryMatch): CategoryNodeRef => ({
  key: m.node.key,
  name: m.node.name,
  path: m.node.path ?? [m.node.name],
});

/** Pure decision: given resolver candidates + a threshold, decide category vs semantic. */
export function classifyCategoryRoute(
  matches: CategoryMatch[],
  minConfidence: number,
): { decision: 'category'; match: CategoryMatch } | {
  decision: 'semantic';
  reason: 'below_threshold' | 'no_match';
  top: CategoryMatch | null;
} {
  const top = matches[0] ?? null;
  if (!top) return { decision: 'semantic', reason: 'no_match', top: null };
  if (top.confidence < minConfidence) {
    return { decision: 'semantic', reason: 'below_threshold', top };
  }
  return { decision: 'category', match: top };
}

/**
 * Route a raw query: confident category match → its web products (short-circuit); otherwise a
 * `semantic` verdict for the caller to run the embedding pipeline. Never throws — any resolver or
 * retrieval failure degrades to `path: 'semantic'` with `reason: 'error'`.
 */
export async function routeCategoryQuery(
  query: string,
  opts: RouteCategoryOptions = {},
): Promise<CategoryRouteResult> {
  const startedAt = Date.now();
  const minConfidence = opts.minConfidence ?? envMinConfidence();

  try {
    const matches = await resolveCategoryFromDb(query, { limit: 3 });
    const classified = classifyCategoryRoute(matches, minConfidence);

    if (classified.decision === 'semantic') {
      const result: CategoryRouteResult = {
        path: 'semantic',
        reason: classified.reason,
        confidence: classified.top?.confidence ?? null,
        topCandidate: classified.top ? toNodeRef(classified.top) : null,
        latencyMs: Date.now() - startedAt,
      };
      logRoute(query, result);
      return result;
    }

    const products = await getProductsForCategory(classified.match.node.key);
    const result: CategoryRouteResult = {
      path: 'category',
      confidence: classified.match.confidence,
      matchType: classified.match.matchType,
      node: toNodeRef(classified.match),
      products,
      productCount: products.length,
      candidates: matches.map(toNodeRef),
      latencyMs: Date.now() - startedAt,
    };
    logRoute(query, result);
    return result;
  } catch (error) {
    const result: CategoryRouteResult = {
      path: 'semantic',
      reason: 'error',
      confidence: null,
      topCandidate: null,
      latencyMs: Date.now() - startedAt,
    };
    logInfo('category_routing_error', {
      query_length: query.length,
      message: error instanceof Error ? error.message : 'unknown',
    });
    return result;
  }
}

/** B0-31 — best-effort routing telemetry (path, node, confidence, counts, latency). */
function logRoute(query: string, result: CategoryRouteResult): void {
  logInfo('category_routing', {
    path: result.path,
    confidence: result.confidence,
    latency_ms: result.latencyMs,
    query_length: query.length,
    ...(result.path === 'category'
      ? { node_key: result.node.key, node: result.node.path.join(' > '), product_count: result.productCount }
      : { reason: result.reason, top_candidate: result.topCandidate?.path.join(' > ') ?? null }),
  });
}
