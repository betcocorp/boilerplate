import { z } from 'zod';

import { productLineLockSchema, toolTraceSchema } from '~/lib/audit/trace';
import { ragDocumentKindSchema } from '~/lib/rag/document-kind';
import { AGENT_CONFIDENCE_REASONS } from '~/lib/workflows/product-support/agent-self-confidence';
import { CONFIDENCE_PROVENANCES } from '~/lib/workflows/product-support/confidence-provenance';

export const validatorResultSchema = z.object({
  approved: z.boolean(),
  confidence: z.number().min(0).max(1),
  /**
   * B0-369 — UNSUPPORTED findings only (including partial support). Confirmations belong in
   * `supported_claims`; anything in here is treated as a defect and is fed to the revision pass.
   */
  issues: z.array(z.string()),
  /**
   * B0-369 — claims the validator positively verified. Trace/diagnostic only: never fed to the
   * revision pass. Optional so `workflow_run.final_output` payloads written before B0-369 parse.
   */
  supported_claims: z.array(z.string()).optional(),
  requires_human_review: z.boolean(),
});

export type ValidatorResult = z.infer<typeof validatorResultSchema>;

/**
 * B0-554 — per-model-call token usage, shared by every `workflow_steps.output` that records it
 * (currently `openai_responses_agent`, `validator`, `revision`) so cost-attribution readers have
 * one shape to parse regardless of which step wrote it.
 */
export const llmTokenUsageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  cachedPromptTokens: z.number().optional(),
});

export type LlmTokenUsageRecord = z.infer<typeof llmTokenUsageSchema>;

/**
 * B0-491 — provenance for `agentConfidence`. Always present (never inferred from context) so a null
 * score is never unexplained: `not_reported` (model didn't emit the marker this turn), `malformed`
 * (marker present but unparseable), `out_of_range` (parsed but outside 0-1), `no_model_call` (the
 * early-decline gate short-circuited before any model call existed).
 */
export const agentConfidenceReasonSchema = z.enum(AGENT_CONFIDENCE_REASONS);

export type AgentConfidenceReason = z.infer<typeof agentConfidenceReasonSchema>;

/**
 * B0-492 — which of the (up to six) mechanisms produced `confidence`. See
 * `~/lib/workflows/product-support/confidence-provenance.ts` for the full definition of each value
 * and the capping-chain rules.
 */
export const confidenceProvenanceSchema = z.enum(CONFIDENCE_PROVENANCES);

export type ConfidenceProvenance = z.infer<typeof confidenceProvenanceSchema>;

/** Rows from `rag.document` / `rag.document_chunk` returned by semantic search (aggregated across tool calls). */
export const retrievedDocumentChunkRefSchema = z.object({
  document_id: z.string(),
  chunk_id: z.string().nullable(),
  document_kind: z.string().nullable().optional(),
  document_title: z.string().nullable().optional(),
  /** B0-455 — `rag.entity.product_line_key` for the retrieved chunk's owning product/product line. */
  product_line_key: z.string().nullable().optional(),
});

export type RetrievedDocumentChunkRef = z.infer<typeof retrievedDocumentChunkRefSchema>;

/**
 * B0-388 — where the answer text the user actually saw came from. The workflow can replace or
 * recompose the model's draft on several paths, and without this the observability panel cannot
 * tell "the model wrote this" from "a deterministic branch wrote this".
 *
 * - `model_generated` — the agent loop's own text, unaltered.
 * - `template_override` — a fixed template replaced the draft.
 * - `cross_reference_composed` — `composeCrossReferenceUserFacingAnswer` wrapped the draft.
 * - `decline_gate` — the early-decline gate produced the text; no model call happened.
 * - `usage_safety_fallback` — the usage/safety coverage gate forced fallback copy.
 * - `validator_fallback` — the validator's disapproval forced fallback copy.
 * - `revision_pass` — the second (revision) model pass produced the final text.
 * - `validator_rejected_draft_retained` — B0-350 (resolves B0-262): the validator disapproved a
 *   substantive, non-decline draft with no flagged safety problem, so the streamed answer was kept
 *   visible instead of being hard-replaced; `requires_human_review` is always forced true alongside
 *   this value.
 * - `recommendation_engine_decline` — B0-356: the `recommend_cross_reference` engine did not answer
 *   (sub-threshold score, validator-forced `escalated`, or a B0-329 latency-ceiling trip), so its
 *   `declineReason` replaced the draft VERBATIM. A distinct value, not `validator_fallback`,
 *   because the deciding gate is the recommendation engine's own confidence/grounding gate, not
 *   this workflow's validator — conflating them would make an equivalence-claim decline
 *   indistinguishable from a general "could not verify" fallback.
 */
export const answerProvenanceSchema = z.enum([
  'model_generated',
  'template_override',
  'cross_reference_composed',
  'decline_gate',
  'usage_safety_fallback',
  'validator_fallback',
  'revision_pass',
  'validator_rejected_draft_retained',
  'recommendation_engine_decline',
  /**
   * B0-779 — the turn's resolved competitor identity (`extractCompetitorProduct`) had neither a
   * brand nor a confidently-extracted product, so any match line (the backstop's or one the model
   * drafted after calling `recommend_cross_reference` itself) was discarded in favor of the
   * standard decline. Distinct from `recommendation_engine_decline`, which is the engine's OWN
   * verdict on a resolved identity — this fires before the engine's verdict is even trusted.
   */
  'competitor_identity_unresolved_decline',
  /**
   * B0-700 follow-up — `maybeDiscloseAliasFuzzyMatch` (`~/lib/workflows/product-support/run-product-support-workflow.ts`)
   * deterministically prepended the "couldn't find an exact match for X, but found Y" disclosure
   * sentence because this turn's answer grounded on an `alias_fuzzy` resolution the model didn't
   * already disclose itself. Only set when the prepend actually changed the text (mirrors the
   * "last writer that actually changed the text wins" rule the other provenance values follow) —
   * a call that found nothing to disclose, or found the model already had, leaves the prior
   * provenance value untouched.
   */
  'alias_fuzzy_disclosure_prepended',
  /**
   * B0-875 — the competitor self-reference check (`classifyCompetitorSelfReference`) found that
   * what the user offered in place of a competitor product was a chemistry-class description
   * ("Diversey quat disinfectant", "peroxide cleaner"), so the cross-reference path was withdrawn
   * and `buildGenericChemistryClarification` (`~/lib/recommendations/cross-reference-decline.ts`)
   * replaced the draft with the clarifying question (which product — label name + EPA registration
   * number — and why it matters). Distinct from `competitor_identity_unresolved_decline`: an
   * identity WAS extracted, it just names a kind of product rather than a product.
   */
  'generic_chemistry_clarification',
  /**
   * B0-829 — `regulated_claim_guardrail` (`evaluateRegulatedClaimGrounding`,
   * `~/lib/workflows/product-support/validator.ts`) flagged one or more ungrounded regulated
   * claims, but every ungrounded category was TOKEN-shaped (`epa_registration`, `din_registration`,
   * `dilution_ratio`, `contact_time`, `cas_number` — an exact literal snippet, not reformatted
   * prose) and at least one OTHER detected category on the same draft WAS fully grounded. Instead
   * of the full-decline `validator_fallback` replacement, the run-product-support-workflow.ts
   * caller surgically redacts only the ungrounded snippet(s) (each literal occurrence replaced with
   * `(unable to verify)`) and keeps the rest of the draft — including the grounded regulated
   * content — intact, appending a note naming what was withheld. Sentence-shaped categories
   * `hazard` and `first_aid` never take this path: either being ungrounded still falls through to
   * `validator_fallback`'s full decline, as does every detected category being ungrounded.
   *
   * B0-871 — the same value also covers SENTENCE-level redaction of `compatibility` /
   * `efficacy_claim` (`planRegulatedClaimRedaction`, `mode: 'sentence_redaction'`): on a knowledge
   * answer (no locked product line, or knowledge-kind sources dominate) each ungrounded sentence is
   * replaced verbatim by a `[one … withheld — not verifiable against a retrieved label]` marker,
   * provided substantive content remains. Not a new enum member: "the draft was kept with the
   * ungrounded claim(s) removed" is one fact; which shape was removed is on the gate record
   * (`inputs.redactionMode`). Both redaction shapes set `activeGates.regulatedClaimGuardrail`
   * to `verdict: 'redacted'` (vs. `'rejected'` for the full decline).
   */
  'regulated_claim_partial_redaction',
]);

export type AnswerProvenance = z.infer<typeof answerProvenanceSchema>;

/**
 * B0-388 — the three LLM boundaries in the product-support workflow. Names match the
 * `workflow_steps.step_name` values the workflow already writes (`openai_responses_agent`,
 * `validator`); `revision` is the second validator-driven pass, which has no step row yet.
 */
export const promptStageSchema = z.enum([
  'openai_responses_agent',
  'validator',
  'revision',
]);

export type PromptStage = z.infer<typeof promptStageSchema>;

/**
 * B0-388 — exactly what was sent to a model at one boundary, for the reasoning-observability
 * panel. `instructions` is the resolved system/instructions text (not a hash) so a reviewer can
 * read what actually ran; `runtime` distinguishes the OpenAI Responses loop from the AI SDK
 * `streamText` loop, which build their model input differently.
 */
export const promptRecordSchema = z.object({
  stage: promptStageSchema,
  instructions: z.string(),
  model: z.string(),
  runtime: z.enum(['responses', 'ai-sdk']),
});

export type PromptRecord = z.infer<typeof promptRecordSchema>;

/**
 * B0-388 — the deterministic (non-LLM) rule nodes that can change a run's outcome.
 *
 * - `keyword_routing` — `routeUserMessageToSme` keyword scores (`orchestration_planner` step).
 * - `early_decline_gate` — `classifyEarlyDecline`; short-circuits before any model call.
 * - `usage_safety_coverage` — `evaluateUsageSafetyCoverage`; caps confidence when usage or
 *   safety evidence is missing.
 * - `recommendation_confidence` — `evaluateRecommendationGate`, the REC-4 calibration applied
 *   whenever cross-reference post-processing ran (similarity/brand/chemistry confidence caps).
 *   Distinct from `gateRecommendation`/`XREF_RECOMMENDATION_MIN_CONFIDENCE` in `~/lib/recommendations`.
 * - `regulated_claim_guardrail` — `evaluateRegulatedClaimGrounding` (B0-257); a hard verbatim-match
 *   requirement, not a numeric threshold, so `BEX_DISABLE_CONFIDENCE_GATING` normally leaves it
 *   running unconditionally. Only appears with `verdict: 'bypassed'`, recorded for the temporary
 *   testing mode where the flag also suppresses this gate's decline (see B0-452 follow-up).
 * - `competitor_identity_resolution` — `extractCompetitorProduct` (B0-357); the ONE deterministic
 *   (brand, product) tuple resolved per turn on the recommendations/cross-reference path, reused by
 *   the forced-lookup prefetch, the deterministic override safety net, and the B0-355 web-search
 *   backstop. Records which competitor was picked when the message named two.
 * - `llm_intent_classifier_shadow` — `classifyUserIntent` (B0-507); shadow-mode only, gated on
 *   `BEX_LLM_ROUTER_ENABLED` + `BEX_LLM_ROUTER_SHADOW_MODE`. Records what the LLM router would
 *   have routed to next to what `keyword_routing` actually routed to, for rollout comparison —
 *   never changes the turn's routing while this gate is the one being recorded.
 * - `semantic_router_live` / `semantic_router_shadow` — `classifyUserIntentSemantic` (B0-649/651),
 *   gated on `BEX_SEMANTIC_ROUTER_ENABLED` + `BEX_SEMANTIC_ROUTER_SHADOW_MODE`. Same
 *   live-vs-shadow split as the LLM classifier pair above; carries the per-route similarity
 *   scores, confidence, margin, which threshold passed, the path taken, and the latency split
 *   (`latencyMs` = `embeddingMs` + `scoringMs`). Built by
 *   `~/lib/workflows/product-support/semantic-router-decision.ts` and reduced into rollout
 *   metrics by `~/lib/observability/routing-health.ts`.
 * - `signals_analysis` — `analyzeTurnSignals` (B0-786), gated on `BEX_SIGNALS_ANALYSIS_ENABLED`.
 *   The ONE pre-orchestration signal-detection call: carries the whole `TurnSignals` object
 *   (routing intent + entities + the six signals that replaced keyword sites + the deterministic
 *   product-line/self-reference enrichment), so every consolidated decision this turn made is
 *   queryable from `/admin/observability` instead of being re-derived from nine call sites.
 */
export const gateIdSchema = z.enum([
  'keyword_routing',
  'early_decline_gate',
  'usage_safety_coverage',
  'recommendation_confidence',
  /**
   * B0-356 — `evaluateRecommendationEngineGate`: enforcement of the `recommend_cross_reference`
   * engine's OWN verdict (`answered` / `status` / `overallConfidence` / `thresholdUsed` /
   * `declineReason`). Distinct from `recommendation_confidence`, which is REC-4's retrieval-strength
   * calibration computed by this workflow — this one only ever REPORTS and enforces a decision the
   * engine already made.
   */
  'recommendation_engine_verdict',
  'regulated_claim_guardrail',
  'competitor_identity_resolution',
  'llm_intent_classifier_shadow',
  'llm_intent_classifier_live',
  'semantic_router_live',
  'semantic_router_shadow',
  'signals_analysis',
  /**
   * B0-699 — `evaluateVerifiedFactsDilutionCitation`: a narrower companion to
   * `regulated_claim_guardrail` that requires a cited `[doc:verified-facts]` dilution figure to
   * match the LOCKED product line's own fact row, not merely appear anywhere in the turn's shared
   * (possibly multi-product) evidence block. Never suppressed by `BEX_DISABLE_CONFIDENCE_GATING`.
   */
  'dilution_citation_guardrail',
]);

export type GateId = z.infer<typeof gateIdSchema>;

/**
 * B0-388 — one deterministic gate evaluation. The four gates read different signals (keyword
 * scores, a decline reason, usage/safety evidence booleans, a confidence number), so `inputs`
 * and `thresholds` are open string-keyed records rather than a per-gate union — but still
 * `unknown`-valued, so consumers must narrow instead of dotting into `any`.
 *
 * `verdict` is a short machine-readable outcome label (e.g. `applied`, `not_applied`, `capped`,
 * `declined`); `effect` says in one line what changed as a result (or that nothing did).
 */
export const gateRecordSchema = z.object({
  gate: gateIdSchema,
  inputs: z.record(z.string(), z.unknown()),
  thresholds: z.record(z.string(), z.unknown()),
  verdict: z.string().max(256),
  effect: z.string().max(2000),
});

export type GateRecord = z.infer<typeof gateRecordSchema>;

/**
 * B0-388 — the reasoning-observability additions to `workflow_steps.input`. Passthrough because
 * every step already writes its own step-specific keys (`model`, `message`, `reason`, …) which
 * must survive a round-trip through this schema untouched.
 */
export const productSupportStepInputSchema = z
  .object({
    prompt: promptRecordSchema.optional(),
    gate: gateRecordSchema.optional(),
    /** B0-349 — the answer as composed before this step's validator pass could touch it. Present on every run once this ships; absent on historical rows. */
    draftAnswer: z.string().optional(),
  })
  .loose();

export type ProductSupportStepInput = z.infer<typeof productSupportStepInputSchema>;

/**
 * B0-388 — the reasoning-observability additions to `workflow_steps.output`. `toolTrace` reuses
 * the canonical `toolTraceEntrySchema` from `~/lib/audit/trace` (the same schema
 * `~/lib/observability/timeline.ts` already parses these rows with) — deliberately not
 * redeclared here, so B0-390's forced-call attribution and truncation flag land in one place.
 * Passthrough for the same reason as the step-input schema.
 */
export const productSupportStepOutputSchema = z
  .object({
    toolTrace: toolTraceSchema.optional(),
    gate: gateRecordSchema.optional(),
    /**
     * B0-391 — the gate records a step row accumulated, in evaluation order. An array because one
     * row can own more than one gate: `usage_safety_coverage` and `recommendation_confidence` both
     * mutate `validation` at the `validator` step, so the single `gate` key above could only ever
     * have held one of them. The workflow writes `gates`; `gate` stays valid for a single-record
     * writer, and `readStepGateRecords` reads either spelling.
     */
    gates: z.array(gateRecordSchema).optional(),
    /** B0-554 — this step's total LLM usage, when it made at least one model call. */
    usage: llmTokenUsageSchema.optional(),
    /** B0-554 — per-model-call usage, in call order (the `validator` step can call the model twice). */
    usageByCall: z.array(llmTokenUsageSchema).optional(),
  })
  .loose();

export type ProductSupportStepOutput = z.infer<typeof productSupportStepOutputSchema>;

/**
 * B0-391 — every gate record on a persisted step row, whichever key it was written under.
 * Tolerant by design: an unparseable payload yields `[]` rather than throwing, because these rows
 * are read by observability surfaces that must still render a malformed historical run.
 */
export function readStepGateRecords(stepOutput: unknown): GateRecord[] {
  const parsed = productSupportStepOutputSchema.safeParse(stepOutput);
  if (!parsed.success) {
    return [];
  }
  return [...(parsed.data.gates ?? []), ...(parsed.data.gate ? [parsed.data.gate] : [])];
}

/**
 * B0-490 — the raw retrieval similarity (before `selectCuratedMatches` filtered/deduped/truncated
 * the set) versus the post-selection similarity of what actually reached the model, rolled up to
 * run level. Distinct fields so a chart can no longer conflate the two: `evaluateRecommendationGate`
 * was calibrated against the RAW top-hit score, but the workflow used to feed it the post-filter
 * max instead (the whole B0-490 bug). Optional — and every field independently nullable — so a
 * payload written before this ticket, or a turn where no search tool ran, is honestly absent/null
 * rather than defaulted to a number that was never computed.
 */
export const similaritySummarySchema = z.object({
  /** Max `RagSearchMatch.similarity` across the winning search's raw candidates, before curation. */
  rawTopSimilarity: z.number().nullable(),
  /** Max similarity across the sources that actually survived `selectCuratedMatches`. */
  selectedTopSimilarity: z.number().nullable(),
  /** Raw candidate count minus surviving source count, summed across this turn's search calls. */
  droppedByFilterCount: z.number().int().nonnegative().nullable(),
});

export type SimilaritySummary = z.infer<typeof similaritySummarySchema>;

/**
 * B0-493 — run-level rollup of the retrieval configuration used by every search-backed tool call
 * this turn made (see `ToolRetrievalParams` in `~/lib/audit/trace.ts` for the per-call record).
 * Each field is null when no search tool ran, the agreed-upon value when every search-backed call
 * this turn agreed, or null WITH the field name listed in `mixed` when calls disagreed — so a run
 * is labelled with "the retrieval configuration used" without a reader having to open every tool
 * call to check for disagreement.
 */
export const retrievalConfigFieldNameSchema = z.enum([
  'embeddingModel',
  'retrievalStrategy',
  'embeddingSource',
  'scope',
  'minSimilarity',
]);

export const retrievalConfigSummarySchema = z.object({
  embeddingModel: z.string().nullable(),
  retrievalStrategy: z.string().nullable(),
  embeddingSource: z.string().nullable(),
  scope: z.string().nullable(),
  /** The effective `selectCuratedMatches` floor applied (e.g. the silently-defaulted 0.2). */
  minSimilarity: z.number().nullable(),
  /** Field names above that disagreed across this turn's search calls, and are therefore null. */
  mixed: z.array(retrievalConfigFieldNameSchema),
});

export type RetrievalConfigSummary = z.infer<typeof retrievalConfigSummarySchema>;

/**
 * B0-494 — the resolved (not env-var-name) value of every behavior switch this run's execution
 * actually observed, so "was this run's behavior even comparable to that one" is answerable
 * without reading env vars or logs. Every field is a plain resolved value — never the flag name —
 * because two runs on different deploys could have the SAME flag name resolve to different
 * effective values (e.g. `isRerankerConfigured()` depends on whether COHERE_API_KEY happens to be
 * set), and it is the resolved value that determines behavior.
 */
export const runtimeConfigSchema = z.object({
  /** `input.useValidator ?? false` — off by default everywhere, including prod chat. */
  useValidator: z.boolean(),
  /** `settings.BEX_EARLY_DECLINE_GATE_ENABLED === 'true'` (B0-734: a settings row, default false). */
  earlyDeclineGateEnabled: z.boolean(),
  /**
   * Whether the AI SDK generation runtime ran this turn (vs the OpenAI Responses loop). The EFFECTIVE
   * decision, not the raw flag: `true` for every Anthropic model regardless of the
   * `BEX_AI_SDK_GENERATION_ENABLED` row, and the row's value for OpenAI models (B0-908).
   */
  aiSdkGenerationEnabled: z.boolean(),
  /**
   * Whether cross-encoder reranking actually ran this turn's retrieval, i.e.
   * `BEX_PRODUCT_SUPPORT_RERANKER !== 'false'` AND `isRerankerConfigured()` (COHERE_API_KEY
   * present). NOT the same as the generic `ENABLE_RERANKER` env var named in the ticket's starting
   * list — verified against the live code that this workflow always passes an explicit
   * `useReranker`, so the product-support retrieval path never actually reads `ENABLE_RERANKER`.
   */
  rerankerActive: z.boolean(),
  /** `BEX_DISABLE_CONFIDENCE_GATING === 'true'` — the B0-452 master confidence-gate kill switch. */
  confidenceGatingDisabled: z.boolean(),
  /**
   * B0-756 — split off `confidenceGatingDisabled`: `BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING`,
   * the recommendation/cross-reference-only kill switch (defaults to bypassed — real calibration
   * data showed the REC-4 similarity/brand/category-mismatch caps and the XREF recommendation gate
   * have an inverted/non-predictive signal). OPTIONAL like the semantic-router fields below:
   * `runtimeConfigSchema.safeParse` runs against already-persisted payloads that predate this
   * split, where absent means "this run predates the split", not `false`.
   */
  recommendationConfidenceGatingDisabled: z.boolean().optional(),
  /** The agent mode this run actually executed under. */
  agentMode: z.string(),
  /** `agentMode !== 'orchestrator'` — an admin forced direct routing, bypassing the router. */
  routedDirectly: z.boolean(),
  /**
   * B0-649 — the semantic-router rollout switches this run observed. OPTIONAL, unlike every field
   * above: `runtimeConfigSchema.safeParse` is run against ALREADY-PERSISTED payloads
   * (`~/lib/tests/response-payload.ts`), so making these required would make every pre-B0-649 run
   * fail to parse and silently drop its whole runtime-config badge. Absent means "this run predates
   * the semantic router", which is not the same as `false`.
   */
  semanticRouterEnabled: z.boolean().optional(),
  /** `BEX_SEMANTIC_ROUTER_SHADOW_MODE` — the router ran but did not decide. */
  semanticRouterShadowMode: z.boolean().optional(),
  /**
   * `'semantic'` (the router decided on its own scores), `'fallback'` (it degraded — embedding
   * failure, thresholds not met), or null when it was never called this turn.
   */
  semanticRouterPath: z.string().nullable().optional(),
  /** Whether the semantic router's route is the one this turn actually ran. */
  semanticRouterDecided: z.boolean().optional(),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

/**
 * B0-494 — per-gate activation state, distinct from the B0-391 `GateRecord` (which records WHAT a
 * gate that ran decided). This records WHETHER it ran at all, and if not, why:
 * - `ran` — the gate evaluated this turn (whatever its verdict).
 * - `skipped` — disabled by a flag entirely; never evaluated. Never rendered as passing, and never
 *   carries thresholds (extends the B0-396 "omit a gate that didn't run" rule to the disabled case).
 * - `bypassed` — the gate (or its cap) DID evaluate/detect something, but the B0-452 kill switch
 *   suppressed the effect (an unenforced cap/rejection is fiction if reported as if it capped).
 * - `not_applicable` — the gate's own trigger condition never occurred this turn (e.g. no
 *   usage/safety-shaped question, or no cross-reference post-processing) — distinct from `skipped`.
 */
export const gateActivationStateSchema = z.enum(['ran', 'skipped', 'bypassed', 'not_applicable']);

export const gateActivationRecordSchema = z.object({
  state: gateActivationStateSchema,
  /** e.g. `'disabled_by_flag'`, `'confidence_gating_disabled'`. Absent when `state === 'ran'`. */
  reason: z.string().max(256).optional(),
  /**
   * B0-358 — the outcome of a gate whose `state` is `'ran'`: `'passed'` (it evaluated and found
   * nothing to act on) versus `'capped'` / `'rejected'` / `'declined'` (it acted). Without this,
   * "the guardrail ran and passed" and "the guardrail ran and fired" were both just `ran`, so a
   * reader could not tell "nothing fired" from "nothing ran". Absent when `state !== 'ran'` (the
   * `state` already says what happened) and on runs written before this ticket.
   *
   * B0-871 — `regulatedClaimGuardrail` additionally uses `'redacted'`: the guardrail fired, but
   * the draft was kept with only the ungrounded claim(s) removed (`answerProvenance:
   * regulated_claim_partial_redaction`) rather than replaced with the decline copy (`'rejected'`).
   * `usageSafetyCoverage` (B0-872) may carry `reason: 'no_product_subject'` on a `not_applicable`
   * record: the question read like a usage/safety question but named no identifiable product.
   */
  verdict: z.string().max(64).optional(),
});

export type GateActivationRecord = z.infer<typeof gateActivationRecordSchema>;

export const activeGatesSchema = z.object({
  validator: gateActivationRecordSchema,
  earlyDeclineGate: gateActivationRecordSchema,
  usageSafetyCoverage: gateActivationRecordSchema,
  regulatedClaimGuardrail: gateActivationRecordSchema,
  recommendationConfidence: gateActivationRecordSchema,
  /**
   * B0-356 — enforcement of the recommendation engine's own verdict. OPTIONAL, unlike the five
   * above: `activeGatesSchema.safeParse` runs against ALREADY-PERSISTED payloads, so a required
   * field here would make every pre-B0-356 run fail to parse and silently drop its whole gate
   * badge. Absent means "this run predates the gate", which is not the same as `not_applicable`.
   */
  recommendationEngineVerdict: gateActivationRecordSchema.optional(),
  /**
   * B0-751 — the competitor self-reference check: did a turn the routers called cross-reference
   * actually name a Betco product / brand, a chemistry, or ask for a whole conversion list?
   * `not_applicable` when the turn was never a cross-reference candidate; `ran`/`passed` when it
   * was checked and a genuine competitor stood; `ran`/`suppressed` (with `reason` =
   * `<rule>:<matched>`) when the forcing and the engine path were withdrawn. OPTIONAL for the
   * same reason as `recommendationEngineVerdict`: already-persisted payloads predate the field.
   */
  crossReferenceSelfReference: gateActivationRecordSchema.optional(),
  /**
   * B0-699 — `evaluateVerifiedFactsDilutionCitation`'s activation state. OPTIONAL for the same
   * reason as `recommendationEngineVerdict`: already-persisted payloads predate the gate.
   * `not_applicable` when the draft never cited `[doc:verified-facts]` alongside a dilution
   * figure; `ran`/`passed` or `ran`/`rejected` otherwise. Never `bypassed` — this gate is
   * deliberately not wired to `BEX_DISABLE_CONFIDENCE_GATING`.
   */
  dilutionCitationGuardrail: gateActivationRecordSchema.optional(),
});

export type ActiveGates = z.infer<typeof activeGatesSchema>;

/**
 * B0-358 — the verification level a run's `validator` step actually reached, as a first-class
 * field rather than a magic string buried in `validation.issues`.
 *
 * On the live Bex path the LLM validator never runs: `useValidator` defaults to `false` and
 * `run-chat-turn.ts` never passes it, so every production turn takes the else-branch and gets
 * `{approved: true, confidence: sources.length > 0 ? 0.9 : 0.6, issues: ['validator_bypassed_for_testing']}`.
 * That bypass is the DELIBERATE REC-4 decision (a claims-validator requiring RAG evidence for every
 * assertion rejects competitive recommendations, which are grounded by a cross-reference match, not
 * by chunks) — this field does not change it, it only stops the persisted step from reading as
 * "this answer was validated".
 *
 * - `llm` — the validator's LLM pass genuinely ran and judged this answer.
 * - `bypassed` — no LLM pass ran. Which bypass (the `useValidator` toggle, or the B0-546
 *   high-similarity skip) is recorded on the step's own `reason` field; both mean the confidence
 *   number came from a heuristic, not a judgment.
 * - `not_run` — the early-decline gate short-circuited before a validator step existed at all.
 */
export const validatorModeSchema = z.enum(['llm', 'bypassed', 'not_run']);

export type ValidatorMode = z.infer<typeof validatorModeSchema>;

export const productSupportFinalOutputSchema = z.object({
  answerText: z.string(),
  sources: z
    .array(
      z.object({
        documentId: z.string(),
        chunkId: z.string().optional(),
        title: z.string(),
        snippet: z.string(),
        similarity: z.number().optional(),
        /**
         * B0-293 — which corpus the source came from (`rag.document.document_kind`, plus the
         * synthetic `facts` kind). Optional: absent on payloads written before this ticket, and on
         * any source whose kind the tool layer did not report.
         */
        documentKind: ragDocumentKindSchema.optional(),
      }),
    )
    .optional(),
  /** Union of all chunks retrieved via semantic search in this turn (matches `document_chunk.id` / `document_id`). */
  retrieved_document_chunks: z.array(retrievedDocumentChunkRefSchema).optional(),
  confidence: z.number().min(0).max(1).optional(),
  workflowRunId: z.string().uuid(),
  latestOpenaiResponseId: z.string(),
  validation: validatorResultSchema,
  routingDecision: z.string().optional(),
  timingBreakdown: z
    .object({
      toolRounds: z.number().int().nonnegative(),
      cacheSource: z.string().nullable(),
      searchMs: z.number().nullable(),
      /**
       * B0-428 / B0-429 — time to first assistant token, measured from workflow start (the same
       * anchor as the run's duration on `/admin/observability`). Recorded on every run: the first
       * streamed model token, or on the early-decline path the moment the decline text was produced
       * (no model call happens there). Null only when the run failed before any token existed.
       * Optional so `workflow_run.final_output` payloads written before B0-428 still parse.
       */
      ttftMs: z.number().nullable().optional(),
    })
    .optional(),
  /** B0-117 — LLM token usage from the agent tool loop, for per-request cost attribution. */
  usage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
      /**
       * B0-324 — prompt tokens served from the provider's automatic prompt cache. Optional so
       * historical `workflow_run.final_output` payloads written before B0-324 still parse.
       */
      cachedPromptTokens: z.number().optional(),
    })
    .optional(),
  /**
   * B0-388 — hash of the specialist prompt that actually ran, so a run can be tied back to the
   * exact prompt text. Optional so `workflow_run.final_output` payloads written before B0-388
   * still parse.
   */
  promptVersion: z.string().optional(),
  /**
   * B0-388 — hash of all prompt constants plus the tool definitions in force for the run. Moves
   * independently of `promptVersion`: a tool-schema edit changes the bundle without changing the
   * specialist prompt. Optional for the same historical-payload reason.
   */
  promptBundleVersion: z.string().optional(),
  /** B0-388 — which branch produced `answerText`. Optional for historical payloads. */
  answerProvenance: answerProvenanceSchema.optional(),
  /**
   * B0-388 — chat context the panel needs to avoid overclaiming completeness: in a chat turn the
   * captured `instructions` are NOT the whole model input. Prior conversation turns are replayed
   * (AI SDK runtime) or carried server-side by `previousResponseId` (Responses runtime), so a
   * panel showing only the instructions would imply the model saw less than it did.
   * Optional for historical payloads; `previousResponseId` is null on the first turn of a chat.
   */
  priorMessageCount: z.number().int().nonnegative().optional(),
  previousResponseId: z.string().nullable().optional(),
  /**
   * B0-519 — whether `priorMessageCount` exceeded `BEX_HISTORY_MAX_MESSAGES` this turn, which:
   * (a) capped the history actually replayed to the most recent messages, and (b), on the Responses
   * runtime only, intentionally broke the `previousResponseId` chain instead of resuming it. See
   * `capConversationHistory` in `run-product-support-workflow.ts`. Optional for historical payloads
   * written before this ticket.
   */
  historyCapApplied: z.boolean().optional(),
  /** B0-349 — the pre-validation draft answer. Optional for historical payloads. */
  draftAnswer: z.string().optional(),
  /**
   * B0-357 — the ONE (brand, product) competitor-identity tuple resolved this turn, when the
   * recommendations/cross-reference path needed one. Persisted on the run itself (not only inside a
   * step) so a bad resolution — e.g. the wrong one of two named competitor products — is
   * diagnosable directly from `workflow_runs.final_output` without reading the step trace. Absent
   * when the turn never needed competitor identity resolution.
   */
  resolvedCompetitor: z
    .object({
      brand: z.string().nullable(),
      product: z.string().nullable(),
      otherCompetitorProduct: z.string().nullable(),
    })
    .optional(),
  /** B0-490 — raw vs. post-selection top retrieval similarity for this turn. See schema doc above. */
  similaritySummary: similaritySummarySchema.optional(),
  /** B0-493 — run-level retrieval configuration rollup. See schema doc above. */
  retrievalConfig: retrievalConfigSummarySchema.optional(),
  /**
   * B0-619 — sum of `rerankMs` across every search-backed tool call this turn. Null when no
   * search tool ran. Optional so historical payloads written before this ticket still parse.
   */
  rerankMsTotal: z.number().nullable().optional(),
  /**
   * B0-619 — the product-line lock decision behind this turn's retrieval (see
   * `productLineLockSchema`), taken from the first search-backed tool call that carried one. Null
   * when no search tool ran. Optional for historical payloads.
   */
  productLineLock: productLineLockSchema.nullable().optional(),
  /**
   * B0-491 — the answering agent's OWN self-reported confidence (see
   * `~/lib/workflows/product-support/agent-self-confidence.ts`), distinct from `confidence`
   * (validator judgment / bypass heuristic / gate-capped value — never conflated with this field,
   * see B0-492). Null (with `agentConfidenceReason` explaining why) when the model returned no
   * parseable score, or when the early-decline gate never called a model at all. Optional so
   * historical payloads written before this ticket still parse.
   */
  agentConfidence: z.number().min(0).max(1).nullable().optional(),
  /** B0-491 — the short reason the agent gave for its own `agentConfidence`. */
  agentConfidenceBasis: z.string().max(500).nullable().optional(),
  /** B0-491 — always present alongside `agentConfidence` once this ticket's code runs. */
  agentConfidenceReason: agentConfidenceReasonSchema.optional(),
  /**
   * B0-492 — which mechanism produced `confidence` (validator judgment, bypass heuristic, decline
   * gate, agent self-score, or a gate cap). Always present alongside `confidence` once this
   * ticket's code runs; absent on historical payloads (readers must resolve that to `'unknown'`,
   * never default it to a judgment class — see `resolveConfidenceProvenance`).
   */
  confidenceProvenance: confidenceProvenanceSchema.optional(),
  /**
   * B0-492 — when `confidenceProvenance === 'gate_capped'`, the value `confidence` had immediately
   * before the FIRST cap in this run's chain (so `gate_capped` never hides what was capped). Null
   * for every other provenance.
   */
  confidencePreCapValue: z.number().min(0).max(1).nullable().optional(),
  /** B0-492 — the provenance of `confidencePreCapValue`, when present. */
  confidencePreCapProvenance: confidenceProvenanceSchema.nullable().optional(),
  /**
   * B0-494 — the resolved value of every behavior switch this run observed. Absent on historical
   * payloads written before this ticket (readers must render those as unknown, never
   * fully-enabled — see `resolveRuntimeConfig`).
   */
  runtimeConfig: runtimeConfigSchema.optional(),
  /**
   * B0-494 — per-gate activation state (ran / skipped-by-flag / bypassed-by-kill-switch /
   * not-applicable-this-turn). Absent on historical payloads for the same reason as
   * `runtimeConfig`.
   */
  activeGates: activeGatesSchema.optional(),
  /**
   * B0-358 — the run's actual verification level (see `validatorModeSchema`). Optional so payloads
   * written before this ticket still parse; readers must render an absent value as unknown, never
   * as `'llm'`.
   */
  validatorMode: validatorModeSchema.optional(),
});

export type ProductSupportFinalOutput = z.infer<typeof productSupportFinalOutputSchema>;
