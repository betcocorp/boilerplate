import {
  retrieveBetcoCandidates,
  type BetcoCandidate,
} from '~/lib/recommendations/candidate-retrieval';
import {
  gateRecommendation,
  scoreRecommendation,
  XREF_DECLINE_COPY,
} from '~/lib/recommendations/confidence-scoring';
import {
  evaluateValidatorGate,
  filterGroundedCandidates,
  scanUnsupportedSafetyClaims,
} from '~/lib/recommendations/recommendation-guardrails';
import type { RecommendationStatus } from '~/lib/recommendations/recommendation-schemas';
import { lookupCrossReference } from '~/lib/tools/cross-reference-lookup';
import {
  enrichCompetitorSpec,
  type EnrichCompetitorSpecInput,
  type EnrichedCompetitorSpec,
} from '~/lib/websearch/enrich-competitor-spec';
import { WebSearchService } from '~/lib/websearch/web-search-service';
import type { WebSearchResponse } from '~/lib/websearch/websearch-schemas';
import { runValidatorPass } from '~/lib/workflows/product-support/validator';
import type { ValidatorResult } from '~/lib/workflows/product-support/product-support-schemas';

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
  /** Persistence status: 'answered' | 'declined' (below gate) | 'pending' (validator forced review). */
  status: RecommendationStatus;
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
  /** B0-91 grounding post-filter: drop candidates whose Betco key is not a real legacy row. */
  filterGrounded: (
    candidates: BetcoCandidate[],
  ) => Promise<{ grounded: BetcoCandidate[]; dropped: BetcoCandidate[] }>;
  /** B0-91 validator pass over the drafted recommendation before it is surfaced. */
  validate: (input: { draftAnswer: string; evidenceSummary: string }) => Promise<ValidatorResult>;
};

const defaultDeps: RecommendCrossReferenceDeps = {
  lookupInternal: (input) => lookupCrossReference(input),
  fetchWeb: (query) => new WebSearchService().search({ query }),
  enrich: (input) => enrichCompetitorSpec(input),
  retrieve: (input) => retrieveBetcoCandidates(input),
  filterGrounded: (candidates) => filterGroundedCandidates(candidates),
  validate: (input) => runValidatorPass(input),
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
      status: 'answered',
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
  const retrieved = await deps.retrieve({ spec });

  // B0-91 grounding enforcement: keep only candidates that resolve to a real legacy product row, so
  // a fabricated SKU/URL can never inflate the score or reach the user. Score the survivors only.
  const { grounded, dropped } = await deps.filterGrounded(retrieved);
  const score = scoreRecommendation({ candidates: grounded, spec, brandKnown: brand.length > 0 });
  const gate = gateRecommendation({ overallConfidence: score.overallConfidence });

  let answered = gate.answered;
  let status: RecommendationStatus = gate.answered ? 'answered' : 'declined';
  let declineReason = gate.declineReason;
  let validation: Record<string, unknown> | null = null;

  // B0-91 validator pass — only when the engine would otherwise answer. Safety scan + validator
  // verdict decide whether the drafted answer is surfaced or forced into human review ('pending').
  if (gate.answered) {
    const betcoEvidence = grounded.map((c) => c.evidence).filter(Boolean).join('\n\n');
    const draft = composeDraftAnswer(input, grounded);
    const evidenceSummary = composeEvidenceSummary(spec, sources, betcoEvidence);
    const unsupportedClaims = scanUnsupportedSafetyClaims({ draft, evidence: betcoEvidence });
    const validator = await deps.validate({ draftAnswer: draft, evidenceSummary });
    const verdict = evaluateValidatorGate({ validator, unsupportedClaims });
    validation = {
      approved: validator.approved,
      confidence: validator.confidence,
      requiresHumanReview: validator.requires_human_review,
      issues: validator.issues,
      unsupportedClaims,
      gatePassed: verdict.pass,
      reasons: verdict.reasons,
    };
    if (!verdict.pass) {
      answered = false;
      status = 'pending'; // route to human review rather than surface an unvalidated answer
      declineReason = XREF_DECLINE_COPY;
    }
  }

  return {
    source: 'web',
    answered,
    status,
    overallConfidence: score.overallConfidence,
    thresholdUsed: gate.thresholdUsed,
    candidates: mapWebCandidates(grounded),
    evidence: {
      source: 'web',
      spec,
      score: score.components,
      sources: web.results.map((r) => ({ url: r.url, title: r.title, score: r.score })),
      droppedCandidates: dropped.length,
      validation,
    },
    declineReason,
  };
}

/** Compose the conservative draft the validator + safety scan inspect. Asserts no PPE/dilution specifics. */
function composeDraftAnswer(
  input: RecommendCrossReferenceInput,
  candidates: BetcoCandidate[],
): string {
  const target = [input.competitorBrand, input.competitorProduct].filter(Boolean).join(' ');
  const lines = candidates.map(
    (c, i) => `${i + 1}. ${c.title}${c.betcoProductKey ? ` (${c.betcoProductKey})` : ''}`,
  );
  return [
    `Recommended Betco equivalent(s) for ${target || input.competitorProduct}:`,
    ...lines,
    'Each recommendation is a semantic match to the retrieved Betco product documents.',
  ].join('\n');
}

/** Evidence the validator scores the draft against: the enriched spec + Betco doc excerpts + sources. */
function composeEvidenceSummary(
  spec: EnrichedCompetitorSpec,
  sources: Array<{ url: string; title?: string }>,
  betcoEvidence: string,
): string {
  return [
    `Competitor spec (from web): ${JSON.stringify({
      chemistryClass: spec.chemistryClass,
      productCategory: spec.productCategory,
      primaryUse: spec.primaryUse,
      formFactor: spec.formFactor,
      keyClaims: spec.keyClaims,
    })}`,
    `Sources: ${sources.map((s) => s.url).join(', ') || 'none'}`,
    `Retrieved Betco documents:\n${betcoEvidence || 'none'}`,
  ].join('\n\n');
}
