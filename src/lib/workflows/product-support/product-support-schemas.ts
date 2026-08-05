import { z } from 'zod';

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
});

export type RetrievedDocumentChunkRef = z.infer<typeof retrievedDocumentChunkRefSchema>;

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
});

export type ProductSupportFinalOutput = z.infer<typeof productSupportFinalOutputSchema>;
