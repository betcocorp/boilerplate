import type { BetcoCandidate } from '~/lib/recommendations/candidate-retrieval';
import { compareProductKind, competitorKindText } from '~/lib/recommendations/product-kind';
import { getBooleanSetting, getNumberSetting } from '~/lib/settings/settings-service';
import type { EnrichedCompetitorSpec } from '~/lib/websearch/enrich-competitor-spec';

/**
 * B0-88 / B0-795 — calibrated 0–1 confidence for a cross-reference recommendation + the gate.
 *
 * Combines three weighted signals into `overallConfidence`:
 *   - retrieval similarity of the top candidate (0.55),
 *   - spec completeness (0.25),
 *   - candidate MARGIN — how far the top candidate leads the runner-up (0.20),
 *   then a company/brand factor (missing company → ×0.9 penalty, never a hard block).
 * A fourth signal, `categoryCompatibility`, is computed and reported but deliberately NOT weighted;
 * see below. The gate compares against a configurable threshold (settings row
 * `XREF_RECOMMENDATION_MIN_CONFIDENCE`, default 0.80, with an optional per-call override) and
 * declines below it. The chosen threshold is returned so callers persist it as `threshold_used`.
 *
 * ## B0-795 — what changed and what the measurement said
 *
 * The scorer previously used `candidateAgreement` (mean similarity across candidates) in the 0.20
 * slot. Measured over B0-97's labeled harvest (200 forced web-path runs against Betco's own curated
 * cross-reference table), that signal ranked correct answers BELOW wrong ones: AUC 0.117 on the
 * strict exact-SKU label and 0.389 on a product-line label — both worse than a coin flip. That is
 * the behaviour its shape predicts. Mean similarity rises when every candidate looks alike, which
 * is ambiguity, not confidence.
 *
 * `candidateMargin` replaces it and is the single strongest signal available: AUC 0.741 (exact) /
 * 0.574 (line) alone, against 0.516 / 0.561 for `topSimilarity`. A clear leader means retrieval
 * discriminated; a flat list means it did not.
 *
 * **`categoryCompatibility` is reported, not weighted, and that is a measured decision.** A
 * product-kind comparison (`~/lib/recommendations/product-kind`) was built specifically to catch the
 * failure this ticket names — an acid bowl cleaner answered with an acid-free disinfectant — and it
 * does classify accurately once claims text is excluded. It still carries no information about
 * correctness on this corpus: of the top candidates it judged the SAME kind, 10/53 were right; of
 * those it judged a domain MISMATCH, 1/6 were right. Those rates are indistinguishable, because
 * retrieval already lands in the right category ~82% of the time — the errors are *within-category
 * SKU* errors, which a category check is blind to by construction. Weighted in, it dropped combined
 * AUC from 0.66 to 0.24; applied as a mismatch penalty it would have suppressed one of only five
 * known-correct answers. It is computed on every run and persisted in `evidence.score` so the next
 * investigation has the feature already collected — but it must not move the number until data says
 * it should. Do not "finish the job" by giving it a weight without re-running
 * `scripts/calibrate-xref-threshold.ts`.
 */

export const DEFAULT_XREF_MIN_CONFIDENCE = 0.8;
/** Multiplicative penalty applied when the competitor company/brand is unknown (does not block). */
export const MISSING_COMPANY_PENALTY_FACTOR = 0.9;
export const XREF_DECLINE_COPY =
  "I couldn't confidently identify a Betco equivalent for this product. A Betco sales representative can help identify the right match — please reach out to your rep.";

const SIMILARITY_WEIGHT = 0.55;
const COMPLETENESS_WEIGHT = 0.25;
const MARGIN_WEIGHT = 0.2;

/**
 * Similarity gap at which the top candidate counts as fully separated from the runner-up. Set from
 * the observed spread of this corpus (candidate similarities cluster in a ~0.55–0.65 band, so a
 * 0.10 lead is decisive); sweeping it to 0.05 and 0.15 moved AUC by ≤0.003, i.e. the signal is not
 * sensitive to this constant.
 */
export const MARGIN_FULL_SEPARATION = 0.1;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const SPEC_FIELDS = [
  'chemistryClass',
  'epaRegistration',
  'contactTimeSeconds',
  'dilutionOzPerGal',
  'productCategory',
  'primaryUse',
  'formFactor',
] as const;

/** Fraction of the tracked spec fields (+ keyClaims) that resolved. */
export function computeSpecCompleteness(spec: EnrichedCompetitorSpec): number {
  const filled =
    SPEC_FIELDS.filter((f) => spec[f] != null).length + (spec.keyClaims.length > 0 ? 1 : 0);
  return round3(filled / (SPEC_FIELDS.length + 1));
}

/**
 * How far the top candidate leads the runner-up, normalized to `MARGIN_FULL_SEPARATION`.
 *
 * `null` (not 0) when there is no runner-up to compare against: a single surviving candidate is an
 * un-measurable margin, not a zero one, and scoring it as zero would punish a correctly narrow
 * retrieval. `null` components are excluded from the weighted mean and their weight is
 * redistributed, so a missing signal never silently drags the score down.
 */
export function computeCandidateMargin(candidates: BetcoCandidate[]): number | null {
  if (candidates.length < 2) return null;
  const [top, runnerUp] = candidates;
  return round3(clamp01((top!.similarity - runnerUp!.similarity) / MARGIN_FULL_SEPARATION));
}

/** Weighted mean over `[weight, value]` pairs, skipping `null` values and renormalizing. */
function weightedMean(parts: Array<[number, number | null]>): number {
  const live = parts.filter((p): p is [number, number] => p[1] !== null);
  const totalWeight = live.reduce((sum, [w]) => sum + w, 0);
  if (totalWeight === 0) return 0;
  return live.reduce((sum, [w, v]) => sum + (w / totalWeight) * v, 0);
}

export type ScoreComponents = {
  topSimilarity: number;
  specCompleteness: number;
  /** B0-795 — top-vs-runner-up separation. `null` when there is no runner-up. */
  candidateMargin: number | null;
  /**
   * B0-795 — 1 same product kind / 0.5 same domain / 0 different domain, `null` when either side
   * cannot be classified. DIAGNOSTIC ONLY: recorded on every run, never folded into
   * `overallConfidence` (see the module header for the measurement that decided this).
   */
  categoryCompatibility: number | null;
  /** The kind labels behind `categoryCompatibility`, so a reviewer can audit a verdict. */
  categoryKinds: { competitor: string | null; candidate: string | null };
  brandKnown: boolean;
  brandFactor: number;
};

export type RecommendationScore = {
  overallConfidence: number;
  components: ScoreComponents;
};

export function scoreRecommendation(input: {
  candidates: BetcoCandidate[];
  spec: EnrichedCompetitorSpec;
  brandKnown: boolean;
}): RecommendationScore {
  const top = input.candidates[0] ?? null;
  const topSimilarity = top?.similarity ?? 0;
  const specCompleteness = computeSpecCompleteness(input.spec);
  const candidateMargin = computeCandidateMargin(input.candidates);
  const brandFactor = input.brandKnown ? 1 : MISSING_COMPANY_PENALTY_FACTOR;

  const kind = top
    ? compareProductKind({
        competitorText: competitorKindText(input.spec),
        candidateTitle: top.title,
        candidateEvidence: top.evidence,
      })
    : { score: null, competitor: null, candidate: null };

  const base = weightedMean([
    [SIMILARITY_WEIGHT, topSimilarity],
    [COMPLETENESS_WEIGHT, specCompleteness],
    [MARGIN_WEIGHT, candidateMargin],
  ]);

  return {
    overallConfidence: round3(clamp01(base * brandFactor)),
    components: {
      topSimilarity: round3(topSimilarity),
      specCompleteness,
      candidateMargin,
      categoryCompatibility: kind.score,
      categoryKinds: {
        competitor: kind.competitor ? `${kind.competitor.domain}/${kind.competitor.kind}` : null,
        candidate: kind.candidate ? `${kind.candidate.domain}/${kind.candidate.kind}` : null,
      },
      brandKnown: input.brandKnown,
      brandFactor,
    },
  };
}

/**
 * Resolve the gate threshold: explicit override → `settings.XREF_RECOMMENDATION_MIN_CONFIDENCE` →
 * default 0.80.
 *
 * B0-795 moved this off `process.env` (B0-638's sweep missed it). No env var was ever set, so the
 * live effective value was always the `DEFAULT_XREF_MIN_CONFIDENCE` fallback; the settings row is
 * seeded to that same 0.80, which makes the migration a no-op on behaviour by design. Note that the
 * gate is separately bypassed while `BEX_DISABLE_CONFIDENCE_GATING` is true — see
 * `isConfidenceGatingDisabled` below.
 */
export async function resolveXrefThreshold(override?: number | null): Promise<number> {
  if (typeof override === 'number' && Number.isFinite(override)) return override;
  return getNumberSetting('XREF_RECOMMENDATION_MIN_CONFIDENCE', DEFAULT_XREF_MIN_CONFIDENCE);
}

/**
 * B0-452 — temporary master kill-switch for every numeric confidence threshold/cap in the
 * recommendation and product-support answer pipeline (this gate, the validator confidence
 * floor, and the REC-4 similarity/brand confidence caps). The current threshold values are
 * unproven placeholders (see `src/docs/cross-reference-recommendations.md`) and are suppressing
 * correct answers; flip `BEX_DISABLE_CONFIDENCE_GATING` back off once real thresholds are
 * calibrated.
 *
 * B0-452 follow-up (explicit, deliberate widening — not scope creep): while this testing window
 * is open, the flag ALSO suppresses the regulated-claim grounding decline
 * (`evaluateRegulatedClaimGrounding` / `run-product-support-workflow.ts`) and the REC-4
 * category-mismatch rejection (`checkCategoryConsistency` above) — the two correctness/safety
 * checks this flag was originally documented as never touching. Both still run and are always
 * recorded (as a `regulated_claim_guardrail` / `recommendation_confidence` gate with
 * `verdict: 'bypassed'`, plus the untouched draft answer in `final_output.draftAnswer`) so a
 * reviewer can see exactly what would have been withheld and why, without it actually being
 * withheld. Evidence/candidate grounding and validator-not-approved / requires-human-review /
 * unsupported-safety-claim are NOT affected and keep running exactly as before.
 */
export async function isConfidenceGatingDisabled(): Promise<boolean> {
  return getBooleanSetting('BEX_DISABLE_CONFIDENCE_GATING', false);
}

export type RecommendationGate = {
  answered: boolean;
  thresholdUsed: number;
  declineReason: string | null;
};

export async function gateRecommendation(input: {
  overallConfidence: number;
  thresholdOverride?: number | null;
}): Promise<RecommendationGate> {
  const thresholdUsed = await resolveXrefThreshold(input.thresholdOverride);
  if (await isConfidenceGatingDisabled()) {
    return { answered: true, thresholdUsed, declineReason: null };
  }
  const answered = input.overallConfidence >= thresholdUsed;
  return { answered, thresholdUsed, declineReason: answered ? null : XREF_DECLINE_COPY };
}
