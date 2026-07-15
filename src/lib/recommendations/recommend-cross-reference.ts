import {
  retrieveBetcoCandidates,
  type BetcoCandidate,
} from '~/lib/recommendations/candidate-retrieval';
import {
  gateRecommendation,
  scoreRecommendation,
} from '~/lib/recommendations/confidence-scoring';
import { lookupCrossReference } from '~/lib/tools/cross-reference-lookup';
import {
  enrichCompetitorSpec,
  type EnrichCompetitorSpecInput,
  type EnrichedCompetitorSpec,
} from '~/lib/websearch/enrich-competitor-spec';
import { WebSearchService } from '~/lib/websearch/web-search-service';
import type { WebSearchResponse } from '~/lib/websearch/websearch-schemas';

/**
 * B0-85 — the cross-reference recommendation entry point.
 *
 * Step 1: legacy lookup. A confident legacy match (lookupCrossReference does not recommend a
 * fallback) is returned immediately, tagged `source: 'legacy'`, without spending a web search.
 * Step 2 (legacy miss / low confidence): the web-grounded path — spec enrichment (B0-86) →
 * candidate retrieval (B0-87) → scoring + threshold gate (B0-88). Returns a normalized result; a
 * sub-threshold web result is a decline (still returned + persistable). Every collaborator is
 * injectable so all paths are unit-testable with the mock web provider.
 */

/** The confidence at/below which the legacy lookup recommends a web fallback (cross-reference-lookup). */
const LEGACY_MATCH_THRESHOLD = 0.75;

export type RecommendationCandidateOut = {
  betcoProductKey: string | null;
  betcoProdId: string | null;
  betcoTitle: string | null;
  confidence: number | null;
  rank: number;
  url: string | null;
  rationale: string | null;
  source: Record<string, unknown>;
};

export type RecommendCrossReferenceResult = {
  source: 'legacy' | 'web';
  answered: boolean;
  overallConfidence: number;
  thresholdUsed: number;
  candidates: RecommendationCandidateOut[];
  evidence: Record<string, unknown>;
  declineReason: string | null;
};

export type RecommendCrossReferenceInput = {
  competitorProduct: string;
  competitorBrand?: string | null;
};

type LegacyLookupResult = Awaited<ReturnType<typeof lookupCrossReference>>;

export type RecommendCrossReferenceDeps = {
  lookupInternal: (input: {
    brand: string;
    productName: string;
    maxResults?: number;
  }) => Promise<LegacyLookupResult>;
  fetchWeb: (query: string) => Promise<WebSearchResponse>;
  enrich: (input: EnrichCompetitorSpecInput) => Promise<EnrichedCompetitorSpec>;
  retrieve: (input: { spec: EnrichedCompetitorSpec; limit?: number }) => Promise<BetcoCandidate[]>;
};

const defaultDeps: RecommendCrossReferenceDeps = {
  lookupInternal: (input) => lookupCrossReference(input),
  fetchWeb: (query) => new WebSearchService().search({ query }),
  enrich: (input) => enrichCompetitorSpec(input),
  retrieve: (input) => retrieveBetcoCandidates(input),
};

type LegacyMatch = {
  productKey?: string | null;
  competitorProductName?: string | null;
  betcoProductId?: number | null;
  legacyRowId?: string | null;
  matchType?: string | null;
  confidence?: number | null;
  productUrl?: string | null;
  betcoProduct?: { title?: string | null } | null;
};

function mapLegacyMatches(matches: LegacyMatch[]): RecommendationCandidateOut[] {
  return matches.map((m, index) => ({
    betcoProductKey: m.productKey ?? null,
    betcoProdId: m.betcoProductId != null ? String(m.betcoProductId) : null,
    betcoTitle: m.betcoProduct?.title ?? m.competitorProductName ?? null,
    confidence: m.confidence ?? null,
    rank: index + 1,
    url: m.productUrl ?? null,
    rationale: `Legacy cross-reference (${m.matchType ?? 'match'})`,
    source: { via: 'legacy', legacyRowId: m.legacyRowId ?? null, matchType: m.matchType ?? null },
  }));
}

function mapWebCandidates(candidates: BetcoCandidate[]): RecommendationCandidateOut[] {
  return candidates.map((c, index) => ({
    betcoProductKey: c.betcoProductKey,
    betcoProdId: null,
    betcoTitle: c.title,
    confidence: c.similarity,
    rank: index + 1,
    url: c.url,
    rationale: null,
    source: {
      via: 'web',
      documentId: c.documentId,
      productLineKey: c.betcoProductLineKey,
      evidence: c.evidence,
    },
  }));
}

export async function recommendCrossReference(
  input: RecommendCrossReferenceInput,
  deps: RecommendCrossReferenceDeps = defaultDeps,
): Promise<RecommendCrossReferenceResult> {
  const brand = input.competitorBrand?.trim() ?? '';

  // Step 1 — legacy lookup.
  const legacy = await deps.lookupInternal({
    brand,
    productName: input.competitorProduct,
    maxResults: 3,
  });
  const legacyMatches: LegacyMatch[] =
    legacy.ok && Array.isArray(legacy.matches) ? (legacy.matches as LegacyMatch[]) : [];
  const legacyConfident =
    legacy.ok && !legacy.fallbackRecommended && legacyMatches.length > 0;

  if (legacyConfident) {
    return {
      source: 'legacy',
      answered: true,
      overallConfidence: legacyMatches[0]?.confidence ?? 0,
      thresholdUsed: LEGACY_MATCH_THRESHOLD,
      candidates: mapLegacyMatches(legacyMatches),
      evidence: {
        source: 'legacy',
        normalizedInput: legacy.ok ? legacy.normalizedInput : null,
        totalCandidates: legacy.ok ? legacy.totalCandidates : 0,
      },
      declineReason: null,
    };
  }

  // Step 2 — web-grounded path.
  const web = await deps.fetchWeb(
    [brand, input.competitorProduct, 'disinfectant OR cleaner product specifications'].filter(Boolean).join(' '),
  );
  const text = web.results
    .map((r) => r.rawContent ?? r.snippet ?? '')
    .filter(Boolean)
    .join('\n\n');
  const sources = web.results.map((r) => ({ url: r.url, title: r.title }));

  const spec = await deps.enrich({ text, sources });
  const candidates = await deps.retrieve({ spec });
  const score = scoreRecommendation({ candidates, spec, brandKnown: brand.length > 0 });
  const gate = gateRecommendation({ overallConfidence: score.overallConfidence });

  return {
    source: 'web',
    answered: gate.answered,
    overallConfidence: score.overallConfidence,
    thresholdUsed: gate.thresholdUsed,
    candidates: mapWebCandidates(candidates),
    evidence: {
      source: 'web',
      spec,
      score: score.components,
      sources: web.results.map((r) => ({ url: r.url, title: r.title, score: r.score })),
    },
    declineReason: gate.declineReason,
  };
}
