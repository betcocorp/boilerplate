import { z } from 'zod';

import { toolTraceSchema } from '~/lib/audit/trace';
import { AGENT_CONFIDENCE_REASONS } from '~/lib/workflows/product-support/agent-self-confidence';

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
 */
export const answerProvenanceSchema = z.enum([
  'model_generated',
  'template_override',
  'cross_reference_composed',
  'decline_gate',
  'usage_safety_fallback',
  'validator_fallback',
  'revision_pass',
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
 */
export const gateIdSchema = z.enum([
  'keyword_routing',
  'early_decline_gate',
  'usage_safety_coverage',
  'recommendation_confidence',
  'regulated_claim_guardrail',
  'competitor_identity_resolution',
  'llm_intent_classifier_shadow',
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
});

export type ProductSupportFinalOutput = z.infer<typeof productSupportFinalOutputSchema>;
