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
  /**
   * B0-693 — NOT set by this function itself (it has no visibility into alias resolution, which
   * happens upstream in the caller). Callers (`~/lib/retrieval/product-knowledge.ts`) attach this
   * afterward, mirroring their own `explicitKeySource`, so the persisted lock decision itself
   * records whether it came from an alias match or the bare similarity probe. Absent/undefined
   * here; present once a caller merges it in.
   */
  explicitKeySource?: string | null;
};

/**
 * B0-757 — these three were previously each independently overridable via a
 * `BEX_PRODUCT_LINE_LOCK_*` env var (none of which was ever actually set in any environment).
 * They are now sourced from `public.settings` via `getProductLineLockThresholds()`
 * (~/lib/settings/settings-service.ts), read once by the one production call site
 * (`~/lib/retrieval/product-knowledge.ts`) and passed in through `options` below. Exported so that
 * getter can use the exact same numbers as its fallback defaults; kept here (rather than moved to a
 * config file) so this stays the single source of truth for "what does resolution do when nothing
 * overrides it" — the underlying lock/margin/high-confidence LOGIC below is unchanged.
 */
/** Minimum top-line similarity to consider locking when the runner-up is clearly weaker. */
export const DEFAULT_MIN_LOCK_SIMILARITY = 0.5;
/** Minimum gap between #1 and #2 aggregate scores when both exist. */
export const DEFAULT_MIN_LOCK_MARGIN = 0.06;
/** Lock even if runner-up is close when the best line is strongly aligned with the query. */
export const DEFAULT_HIGH_CONFIDENCE_ABSOLUTE = 0.64;

const MAX_CANDIDATES = 3;

/**
 * From an unfiltered product similarity result set, derive the top few `product_line_key`
 * candidates and optionally lock retrieval to one line when confidence is high enough.
 *
 * B0-693 — `requireMarginForHighConfidence` closes the loophole where the absolute-threshold
 * shortcut below let a high top score lock even with a close, uncorroborated runner-up (reported:
 * a hazard/signal-word question for a 9% HCl SKU was answered with a 23% HCl SKU's hazard
 * profile). Originally callers set it only for queries targeting a specific regulated GHS section
 * — confirmed incomplete: a general query with no explicit section (e.g. "what is the dilution
 * ratio for DAILY DISINFECT") could still lock a wrong product line with a razor-thin margin. The
 * one production call site (`ragQueryForProductKnowledgeWithMeta`, `~/lib/retrieval/product-
 * knowledge.ts`) now passes `true` unconditionally; the option stays a parameter (rather than being
 * hardwired into this function) so callers/tests can still exercise the old shortcut behavior
 * explicitly.
 */
export function resolveProductLineFromMatches(
  matches: RagSearchMatch[],
  options: {
    requireMarginForHighConfidence?: boolean;
    /** B0-757 — settings-backed override; falls back to `DEFAULT_MIN_LOCK_SIMILARITY`. */
    minLockSimilarity?: number;
    /** B0-757 — settings-backed override; falls back to `DEFAULT_MIN_LOCK_MARGIN`. */
    minLockMargin?: number;
    /** B0-757 — settings-backed override; falls back to `DEFAULT_HIGH_CONFIDENCE_ABSOLUTE`. */
    highConfidenceAbsolute?: number;
  } = {},
): ProductLineResolutionResult {
  const minSim = options.minLockSimilarity ?? DEFAULT_MIN_LOCK_SIMILARITY;
  const margin = options.minLockMargin ?? DEFAULT_MIN_LOCK_MARGIN;
  const highAbs = options.highConfidenceAbsolute ?? DEFAULT_HIGH_CONFIDENCE_ABSOLUTE;

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
