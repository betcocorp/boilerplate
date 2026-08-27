import type { RagSearchMatch } from '~/lib/rag/search';

export type ProductLineCandidate = {
  productLineKey: string;
  label: string | null;
  maxSimilarity: number;
};

export type ProductLineResolutionResult = {
  candidates: ProductLineCandidate[];
  lockedProductLineKey: string | null;
  lockReason:
    | 'explicit_filter'
    | 'high_confidence'
    | 'skipped_low_confidence'
    | 'skipped_ambiguous'
    | 'skipped_no_product_line'
    | 'resolution_disabled';
};

/** Minimum top-line similarity to consider locking when the runner-up is clearly weaker. */
const MIN_LOCK_SIMILARITY = 0.5;
/** Minimum gap between #1 and #2 aggregate scores when both exist. */
const MIN_LOCK_MARGIN = 0.06;
/** Lock even if runner-up is close when the best line is strongly aligned with the query. */
const HIGH_CONFIDENCE_ABSOLUTE = 0.64;

const MAX_CANDIDATES = 3;

function readResolutionEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * From an unfiltered product similarity result set, derive the top few `product_line_key`
 * candidates and optionally lock retrieval to one line when confidence is high enough.
 *
 * B0-693 — `requireMarginForHighConfidence` closes the loophole where the absolute-threshold
 * shortcut below let a high top score lock even with a close, uncorroborated runner-up (reported:
 * a hazard/signal-word question for a 9% HCl SKU was answered with a 23% HCl SKU's hazard
 * profile). Callers set it for queries targeting a specific regulated GHS section (hazard, first
 * aid, dilution/contact-time, EPA reg, etc.) — general "what is this product" queries are
 * unaffected and keep the existing absolute-threshold shortcut.
 */
export function resolveProductLineFromMatches(
  matches: RagSearchMatch[],
  options: { requireMarginForHighConfidence?: boolean } = {},
): ProductLineResolutionResult {
  const minSim = readResolutionEnvNumber(
    'BEX_PRODUCT_LINE_LOCK_MIN_SIMILARITY',
    MIN_LOCK_SIMILARITY,
  );
  const margin = readResolutionEnvNumber(
    'BEX_PRODUCT_LINE_LOCK_MARGIN',
    MIN_LOCK_MARGIN,
  );
  const highAbs = readResolutionEnvNumber(
    'BEX_PRODUCT_LINE_LOCK_HIGH_CONFIDENCE',
    HIGH_CONFIDENCE_ABSOLUTE,
  );

  const byLine = new Map<
    string,
    { maxSimilarity: number; label: string | null }
  >();

  for (const m of matches) {
    const key = m.product_line_key?.trim();
    if (!key) {
      continue;
    }
    const sim = m.similarity;
    const label = m.document_title?.trim() || null;
    const prev = byLine.get(key);
    if (!prev || sim > prev.maxSimilarity) {
      byLine.set(key, { maxSimilarity: sim, label });
    }
  }

  if (byLine.size === 0) {
    return {
      candidates: [],
      lockedProductLineKey: null,
      lockReason: 'skipped_no_product_line',
    };
  }

  const candidates: ProductLineCandidate[] = [...byLine.entries()]
    .map(([productLineKey, v]) => ({
      productLineKey,
      label: v.label,
      maxSimilarity: v.maxSimilarity,
    }))
    .sort((a, b) => b.maxSimilarity - a.maxSimilarity)
    .slice(0, MAX_CANDIDATES);

  const first = candidates[0];
  const second = candidates[1];

  if (!first) {
    return {
      candidates,
      lockedProductLineKey: null,
      lockReason: 'skipped_no_product_line',
    };
  }

  const spread =
    second != null ? first.maxSimilarity - second.maxSimilarity : 1;
  const requireMargin = options.requireMarginForHighConfidence === true;

  if (first.maxSimilarity >= highAbs && !requireMargin) {
    return {
      candidates,
      lockedProductLineKey: first.productLineKey,
      lockReason: 'high_confidence',
    };
  }

  if (first.maxSimilarity < minSim) {
    return {
      candidates,
      lockedProductLineKey: null,
      lockReason: 'skipped_low_confidence',
    };
  }

  if (second != null && spread < margin) {
    return {
      candidates,
      lockedProductLineKey: null,
      lockReason: 'skipped_ambiguous',
    };
  }

  return {
    candidates,
    lockedProductLineKey: first.productLineKey,
    lockReason: 'high_confidence',
  };
}
