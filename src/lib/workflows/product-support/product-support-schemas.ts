import { z } from 'zod';

import { toolTraceSchema } from '~/lib/audit/trace';

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
 */
export const gateIdSchema = z.enum([
  'keyword_routing',
  'early_decline_gate',
  'usage_safety_coverage',
  'recommendation_confidence',
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
  /** B0-349 — the pre-validation draft answer. Optional for historical payloads. */
  draftAnswer: z.string().optional(),
});

export type ProductSupportFinalOutput = z.infer<typeof productSupportFinalOutputSchema>;
