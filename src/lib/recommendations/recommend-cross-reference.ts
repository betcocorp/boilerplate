import {
  retrieveBetcoCandidates,
  type BetcoCandidate,
} from '~/lib/recommendations/candidate-retrieval';
import { lookupCrossReferenceRunScoped } from '~/lib/recommendations/legacy-lookup-cache';
import {
  gateRecommendation,
  resolveXrefThreshold,
  scoreRecommendation,
  XREF_DECLINE_COPY,
} from '~/lib/recommendations/confidence-scoring';
import {
  evaluateValidatorGate,
  filterGroundedCandidates,
  scanUnsupportedSafetyClaims,
} from '~/lib/recommendations/recommendation-guardrails';
import {
  runRecommendationWebSearch,
  type RecommendationSearchResult,
} from '~/lib/recommendations/recommendation-web-search';
import type { RecommendationStatus } from '~/lib/recommendations/recommendation-schemas';
import { lookupCrossReference } from '~/lib/tools/cross-reference-lookup';
import {
  enrichCompetitorSpec,
  type EnrichCompetitorSpecInput,
  type EnrichedCompetitorSpec,
} from '~/lib/websearch/enrich-competitor-spec';
import { getErrorMessage } from '~/lib/utils';
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
 *
 * Latency work layered on top: step 1 is de-duplicated against the `lookup_cross_reference` tool call
 * in the same turn (B0-322), every sub-step is timed into `evidence.timingBreakdown` (B0-323), and
 * each network/LLM-bound step plus the run as a whole is bounded by an env-tunable ceiling (B0-329).
 */

/** The confidence at/below which the legacy lookup recommends a web fallback (cross-reference-lookup). */
const LEGACY_MATCH_THRESHOLD = 0.75;

/** Legacy matches this engine asks for in step 1 (the `lookup_cross_reference` tool defaults to 3 too). */
const LEGACY_LOOKUP_MAX_RESULTS = 3;

/**
 * B0-323 — sub-step latency instrumentation.
 *
 * The tool call's observed total (2.8s–13.2s) is the sum of up to five sequential sub-steps, none of
 * which were individually measured. Every invocation now records per-step wall-clock into
 * `evidence.timingBreakdown`, which `persistRecommendation` writes to `recommendation.evidence`
 * (jsonb) and mirrors into the `cross_reference_recommendation` audit entry — so the bottleneck is
 * answerable from persisted data without a new table. Instrumentation only: no logic depends on it.
 */
export type XrefTimedStep =
  | 'legacyLookup'
  | 'webSearch'
  | 'enrich'
  | 'retrieve'
  | 'filterGrounded'
  | 'validate';

export type XrefTimingBreakdown = {
  /** Wall-clock for the whole `recommendCrossReference` call. */
  totalMs: number;
  /** Step 1. Always present. `null` for a step that did not run on this path. */
  legacyLookupMs: number | null;
  /** Step 2. */
  webSearchMs: number | null;
  /** Step 3. */
  enrichMs: number | null;
  /** Step 4a. */
  retrieveMs: number | null;
  /** Step 4b. */
  filterGroundedMs: number | null;
  /** Step 5. */
  validateMs: number | null;
  /** The steps that actually ran, in execution order. */
  stepsRun: XrefTimedStep[];
  /** Provider queries the budgeted web search spent (null when step 2 never ran). */
  searchesUsed: number | null;
  /** Whether the web search escalated from `basic` to `advanced` depth (null when step 2 never ran). */
  escalated: boolean | null;
  /** True when the legacy lookup was served from the run-scoped cache instead of the database (B0-322). */
  legacyCacheHit: boolean;
  /** B0-329 — the sub-step that hit its latency ceiling, or null when the run completed normally. */
  timedOutStep: XrefTimedStep | null;
};

type XrefTimer = {
  /** Time one sub-step. The duration is recorded even when `run` rejects (incl. a B0-329 timeout). */
  time: <T>(step: XrefTimedStep, run: () => Promise<T>) => Promise<T>;
  /** Wall-clock since the run started — the basis of the B0-329 total-duration ceiling. */
  elapsedMs: () => number;
  build: (extra?: {
    searchesUsed?: number | null;
    escalated?: boolean | null;
    legacyCacheHit?: boolean;
    timedOutStep?: XrefTimedStep | null;
  }) => XrefTimingBreakdown;
};

function createXrefTimer(now: () => number = Date.now): XrefTimer {
  const start = now();
  const durations = new Map<XrefTimedStep, number>();
  const stepsRun: XrefTimedStep[] = [];

  return {
    async time(step, run) {
      const startedAt = now();
      try {
        return await run();
      } finally {
        // Clamp: a coarse clock can read backwards (see workflow_steps skew), never persist negatives.
        durations.set(step, Math.max(0, now() - startedAt));
        stepsRun.push(step);
      }
    },
    elapsedMs() {
      return Math.max(0, now() - start);
    },
    build(extra) {
      return {
        totalMs: Math.max(0, now() - start),
        legacyLookupMs: durations.get('legacyLookup') ?? null,
        webSearchMs: durations.get('webSearch') ?? null,
        enrichMs: durations.get('enrich') ?? null,
        retrieveMs: durations.get('retrieve') ?? null,
        filterGroundedMs: durations.get('filterGrounded') ?? null,
        validateMs: durations.get('validate') ?? null,
        stepsRun: [...stepsRun],
        searchesUsed: extra?.searchesUsed ?? null,
        escalated: extra?.escalated ?? null,
        legacyCacheHit: extra?.legacyCacheHit ?? false,
        timedOutStep: extra?.timedOutStep ?? null,
      };
    },
  };
}

/**
 * B0-329 — latency ceiling / circuit breaker.
 *
 * `recommend_cross_reference` had no upper bound anywhere: a slow provider on any of the
 * network/LLM-bound sub-steps (web search, spec enrichment, candidate retrieval, validator) simply
 * extended the turn (2.8s–13.2s observed, unbounded in principle). Each of those steps now races a
 * timer, and the whole call additionally races `totalBudgetMs`, so no run can exceed the configured
 * ceiling. Every budget is env-tunable (no code deploy needed to retune in production).
 */
export type XrefLatencyPolicy = {
  /** Hard ceiling for the entire `recommendCrossReference` call. */
  totalBudgetMs: number;
  /** Per-step ceilings (each is additionally clamped by the remaining total budget). */
  webSearchBudgetMs: number;
  enrichBudgetMs: number;
  retrieveBudgetMs: number;
  validateBudgetMs: number;
};

/** Same shape as `loadRecommendationSearchPolicy`'s helper: invalid/absent/non-positive → fallback. */
function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadXrefLatencyPolicy(env: NodeJS.ProcessEnv = process.env): XrefLatencyPolicy {
  return {
    totalBudgetMs: positiveNumber(env.XREF_RECOMMENDATION_TIMEOUT_MS, 20_000),
    webSearchBudgetMs: positiveNumber(env.XREF_WEB_SEARCH_TIMEOUT_MS, 12_000),
    enrichBudgetMs: positiveNumber(env.XREF_ENRICH_TIMEOUT_MS, 8_000),
    retrieveBudgetMs: positiveNumber(env.XREF_RETRIEVE_TIMEOUT_MS, 8_000),
    validateBudgetMs: positiveNumber(env.XREF_VALIDATE_TIMEOUT_MS, 8_000),
  };
}

export class XrefStepTimeoutError extends Error {
  constructor(
    readonly step: XrefTimedStep,
    readonly budgetMs: number,
  ) {
    super(`recommend_cross_reference step "${step}" exceeded its ${budgetMs}ms latency ceiling`);
    this.name = 'XrefStepTimeoutError';
  }
}

/** Race `run` against `budgetMs`. A non-positive budget means the total ceiling is already spent. */
async function withDeadline<T>(
  step: XrefTimedStep,
  budgetMs: number,
  run: () => Promise<T>,
): Promise<T> {
  const budget = Math.floor(budgetMs);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new XrefStepTimeoutError(step, Math.max(0, budget));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new XrefStepTimeoutError(step, budget)), budget);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Times a sub-step (B0-323) and bounds it by both its own and the remaining total budget (B0-329). */
type StepGuard = <T>(step: XrefTimedStep, budgetMs: number, run: () => Promise<T>) => Promise<T>;

function createStepGuard(timer: XrefTimer, policy: XrefLatencyPolicy): StepGuard {
  return (step, budgetMs, run) =>
    timer.time(step, () =>
      withDeadline(step, Math.min(budgetMs, policy.totalBudgetMs - timer.elapsedMs()), run),
    );
}

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
  /**
   * B0-322 — optional turn-scoped variant of `lookupInternal` that also reports whether the cache
   * served it (so the timing breakdown can attribute a ~0ms step 1). Preferred when present;
   * `lookupInternal` remains the contract for tests and callers that inject their own lookup.
   */
  lookupInternalCached?: (input: {
    brand: string;
    productName: string;
    maxResults?: number;
  }) => Promise<{ result: LegacyLookupResult; cacheHit: boolean }>;
  /** B0-92 budgeted web search: capped searches, escalation, domain allowlist, cost/rate guards. */
  searchWeb: (input: { brand: string; product: string }) => Promise<RecommendationSearchResult>;
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
  lookupInternalCached: (input) => lookupCrossReferenceRunScoped(input),
  searchWeb: (input) => runRecommendationWebSearch(input),
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
  policy: XrefLatencyPolicy = loadXrefLatencyPolicy(),
): Promise<RecommendCrossReferenceResult> {
  const brand = input.competitorBrand?.trim() ?? '';
  const timer = createXrefTimer();
  const guard = createStepGuard(timer, policy);

  // Step 1 — legacy lookup. B0-322: reuses the result of the `lookup_cross_reference` tool call the
  // model almost always makes moments earlier in the same turn, instead of re-querying legacy.
  let legacyLookup: { result: LegacyLookupResult; cacheHit: boolean };
  try {
    legacyLookup = await guard('legacyLookup', policy.totalBudgetMs, () => {
      const lookupInput = {
        brand,
        productName: input.competitorProduct,
        maxResults: LEGACY_LOOKUP_MAX_RESULTS,
      };
      return deps.lookupInternalCached
        ? deps.lookupInternalCached(lookupInput)
        : deps.lookupInternal(lookupInput).then((result) => ({ result, cacheHit: false }));
    });
  } catch (error) {
    // B0-329: a step-1 timeout leaves us with no legacy data at all → decline. A hard legacy/database
    // failure keeps propagating (the tool boundary already reports it as a failed tool call).
    if (error instanceof XrefStepTimeoutError) {
      return latencyCeilingFallback({
        error,
        timer,
        policy,
        legacy: null,
        legacyMatches: [],
        legacyCacheHit: false,
        webSearch: null,
      });
    }
    throw error;
  }
  const legacy = legacyLookup.result;
  const legacyCacheHit = legacyLookup.cacheHit;
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
        // B0-323: the confident-legacy fast path runs step 1 only — record it so its (fast) profile
        // is distinguishable from a web-path run rather than absent from the data.
        timingBreakdown: timer.build({ legacyCacheHit }),
      },
      declineReason: null,
    };
  }

  // Steps 2–5 run under the B0-329 latency ceiling. Any timeout (or step failure) degrades to the
  // defined fallback below instead of hanging the turn or surfacing an unhandled error.
  const telemetry: { webSearch: WebSearchTelemetry | null } = { webSearch: null };
  try {
    return await runWebGroundedPath({ input, brand, deps, timer, guard, policy, legacyCacheHit, telemetry });
  } catch (error) {
    return latencyCeilingFallback({
      error,
      timer,
      policy,
      legacy,
      legacyMatches,
      legacyCacheHit,
      webSearch: telemetry.webSearch,
    });
  }
}

type WebSearchTelemetry = {
  searchesUsed: number;
  estimatedCostUsd: number;
  escalated: boolean;
  budgetExceeded: boolean;
};

type WebGroundedPathContext = {
  input: RecommendCrossReferenceInput;
  brand: string;
  deps: RecommendCrossReferenceDeps;
  timer: XrefTimer;
  guard: StepGuard;
  policy: XrefLatencyPolicy;
  legacyCacheHit: boolean;
  /** Carries step-2 telemetry out of this function so a later timeout can still report it. */
  telemetry: { webSearch: WebSearchTelemetry | null };
};

/** Steps 2–5: budgeted web search → spec enrichment → candidate retrieval + grounding → validator. */
async function runWebGroundedPath(ctx: WebGroundedPathContext): Promise<RecommendCrossReferenceResult> {
  const { input, brand, deps, timer, guard, policy, legacyCacheHit } = ctx;

  // Step 2 — web-grounded path (B0-92 budgeted search: capped, escalating, cost/rate-guarded).
  const search = await guard('webSearch', policy.webSearchBudgetMs, () =>
    deps.searchWeb({ brand, product: input.competitorProduct }),
  );
  const webSearch: WebSearchTelemetry = {
    searchesUsed: search.searchesUsed,
    estimatedCostUsd: search.estimatedCostUsd,
    escalated: search.escalated,
    budgetExceeded: search.budgetExceeded,
  };
  ctx.telemetry.webSearch = webSearch;

  // No evidence (budget short-circuit or search failure) → decline; never fabricate without grounding.
  if (!search.response) {
    return {
      source: 'web',
      answered: false,
      status: 'declined',
      overallConfidence: 0,
      thresholdUsed: resolveXrefThreshold(),
      candidates: [],
      evidence: { source: 'web', webSearch, timingBreakdown: buildTiming(timer, webSearch, legacyCacheHit) },
      declineReason: XREF_DECLINE_COPY,
    };
  }

  const web = search.response;
  const text = web.results
    .map((r) => r.rawContent ?? r.snippet ?? '')
    .filter(Boolean)
    .join('\n\n');
  const sources = web.results.map((r) => ({ url: r.url, title: r.title }));

  const spec = await guard('enrich', policy.enrichBudgetMs, () => deps.enrich({ text, sources }));
  const retrieved = await guard('retrieve', policy.retrieveBudgetMs, () => deps.retrieve({ spec }));

  // B0-91 grounding enforcement: keep only candidates that resolve to a real legacy product row, so
  // a fabricated SKU/URL can never inflate the score or reach the user. Score the survivors only.
  const { grounded, dropped } = await guard('filterGrounded', policy.retrieveBudgetMs, () =>
    deps.filterGrounded(retrieved),
  );
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
    const validator = await guard('validate', policy.validateBudgetMs, () =>
      deps.validate({ draftAnswer: draft, evidenceSummary }),
    );
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
      webSearch,
      timingBreakdown: buildTiming(timer, webSearch, legacyCacheHit),
    },
    declineReason,
  };
}

/**
 * B0-329 — the defined outcome when a sub-step blows its latency ceiling (or fails outright).
 *
 * Fallback order: the legacy lookup's matches when it produced any — they are always sub-threshold
 * here, because a confident legacy match returns from step 1 long before this point — otherwise a
 * plain decline. Weak legacy matches are carried as candidates and routed to human review
 * (`status: 'pending'`) with `XREF_DECLINE_COPY` shown, exactly as a sub-threshold web result behaves;
 * a degraded, unvalidated equivalence for an EPA-registered product is never surfaced as an answer.
 */
function latencyCeilingFallback(args: {
  error: unknown;
  timer: XrefTimer;
  policy: XrefLatencyPolicy;
  legacy: LegacyLookupResult | null;
  legacyMatches: LegacyMatch[];
  legacyCacheHit: boolean;
  webSearch: WebSearchTelemetry | null;
}): RecommendCrossReferenceResult {
  const { error, timer, policy, legacy, legacyMatches, legacyCacheHit, webSearch } = args;
  const timedOut = error instanceof XrefStepTimeoutError;
  const hasLegacy = legacyMatches.length > 0;

  const timeout = {
    timedOut,
    step: timedOut ? error.step : null,
    stepBudgetMs: timedOut ? error.budgetMs : null,
    totalBudgetMs: policy.totalBudgetMs,
    elapsedMs: timer.elapsedMs(),
    reason: timedOut ? 'latency_ceiling' : 'step_failure',
    message: getErrorMessage(error),
    fallback: hasLegacy ? 'legacy_matches' : 'decline',
  };
  const timingBreakdown = timer.build({
    searchesUsed: webSearch?.searchesUsed ?? null,
    escalated: webSearch?.escalated ?? null,
    legacyCacheHit,
    timedOutStep: timedOut ? error.step : null,
  });

  console.error(
    JSON.stringify({
      level: 'error',
      event: 'cross_reference_recommendation_latency_ceiling',
      ...timeout,
      timing_breakdown: timingBreakdown,
    }),
  );

  return {
    source: hasLegacy ? 'legacy' : 'web',
    answered: false,
    status: hasLegacy ? 'pending' : 'declined',
    overallConfidence: hasLegacy ? (legacyMatches[0]?.confidence ?? 0) : 0,
    thresholdUsed: hasLegacy ? LEGACY_MATCH_THRESHOLD : resolveXrefThreshold(),
    candidates: hasLegacy ? mapLegacyMatches(legacyMatches) : [],
    evidence: {
      source: hasLegacy ? 'legacy' : 'web',
      normalizedInput: legacy?.ok ? legacy.normalizedInput : null,
      totalCandidates: legacy?.ok ? legacy.totalCandidates : 0,
      webSearch,
      timeout,
      timingBreakdown,
    },
    declineReason: XREF_DECLINE_COPY,
  };
}

/** B0-323 — fold the existing `webSearch` telemetry (searches/escalation) into the timing payload. */
function buildTiming(
  timer: XrefTimer,
  webSearch: { searchesUsed: number; escalated: boolean },
  legacyCacheHit: boolean,
): XrefTimingBreakdown {
  return timer.build({
    searchesUsed: webSearch.searchesUsed,
    escalated: webSearch.escalated,
    legacyCacheHit,
  });
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
