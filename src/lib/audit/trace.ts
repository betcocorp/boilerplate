import { z } from 'zod';

/**
 * B0-390 — why a tool call happened. Not every persisted call was chosen by the model, and a
 * reader who assumes otherwise reads the workflow's own forced calls as model misbehaviour.
 *
 * - `model_chosen` — the model asked for it in a tool-call round.
 * - `tool_choice_forced` — the request pinned `tool_choice` to this function, so the model had no
 *   choice on that round (`shouldForceCrossReferenceLookup` → `lookup_cross_reference`).
 * - `workflow_injected` — the workflow executed the tool itself, outside any model round
 *   (the `forced-search-*` cross-reference RAG search).
 * - `safety_net_override` — the deterministic cross-reference safety net, which calls the lookup
 *   directly with the raw user message when the model's own lookup surfaced no match.
 */
export const toolCallOriginSchema = z.enum([
  'model_chosen',
  'tool_choice_forced',
  'workflow_injected',
  'safety_net_override',
]);

export type ToolCallOrigin = z.infer<typeof toolCallOriginSchema>;

/**
 * B0-493 — the exact retrieval parameters and strategy/cache outcome of a search-backed tool call,
 * captured from the FULL tool payload at `executeToolCall` time (never reconstructed from the
 * truncated `outputPreview`, which routinely drops this — it sits after the potentially-large
 * `sources[]` array in the payload). Present only on calls whose tool actually ran a RAG search
 * (`search_product_docs`, `get_product_spec`, `get_approved_usage_guidance`,
 * `get_safety_constraints`, `get_compatibility_rules`, `list_allowed_surfaces`,
 * `list_disallowed_uses`); absent on every other tool and on rows written before this ticket.
 */
export const toolRetrievalParamsSchema = z.object({
  /** Embedding model used for the query vector. */
  model: z.string(),
  /** Candidate fetch limit passed to `searchProductChunks` (not the final document-source limit). */
  limit: z.number(),
  scope: z.string(),
  productLineKey: z.string().nullable(),
  productKey: z.string().nullable(),
  sectionType: z.string().nullable(),
  /** `searchProductChunks`'s own `minSimilarity` option; null on every call site today (none pass one). */
  minSimilarity: z.number().nullable(),
  retrievalStrategy: z.string(),
  embeddingSource: z.string(),
  timings: z.object({
    totalMs: z.number(),
    queryEmbeddingMs: z.number(),
    queryRewriteMs: z.number(),
    cacheLookupMs: z.number(),
    embeddingCreateMs: z.number(),
    cachePersistMs: z.number(),
    similaritySearchMs: z.number(),
    rerankMs: z.number(),
  }),
  /**
   * The `selectCuratedMatches` options actually applied when curating this call's sources,
   * INCLUDING the silently-defaulted 0.2 `minSimilarity` floor recorded as an applied value.
   */
  selection: z.object({
    limit: z.number(),
    minSimilarity: z.number(),
    maxPerDocument: z.number(),
    requiredDocumentKinds: z.array(z.string()),
  }),
});

export type ToolRetrievalParams = z.infer<typeof toolRetrievalParamsSchema>;

export const toolTraceEntrySchema = z.object({
  toolName: z.string(),
  callId: z.string(),
  argumentsPreview: z.string().max(2000),
  outputPreview: z.string().max(4000),
  ok: z.boolean(),
  durationMs: z.number().optional(),
  /** B0-390 — absent on rows written before the attribution landed (treat as unknown, not model-chosen). */
  origin: toolCallOriginSchema.optional(),
  /**
   * B0-390 — the previews are sliced at write time and tool outputs carry label/SDS text (dilution
   * ratios, EPA registration numbers, ppm, contact times). These flags say outright that a preview
   * was cut, so a reader never mistakes a truncated regulated value for the complete one. Absent on
   * historical rows, where truncation is simply unknown.
   */
  argumentsTruncated: z.boolean().optional(),
  outputTruncated: z.boolean().optional(),
  /**
   * B0-436 — this retrieval ran speculatively, BEFORE the first model call, rather than because the
   * model asked for it. Persisted so an `/admin/observability` trace stays honest about what ran.
   */
  speculative: z.boolean().optional(),
  /**
   * B0-436 — the model did ask for this tool, but the answer was served from the speculative run
   * above instead of re-querying RAG. `durationMs` is therefore the speculative call's duration.
   */
  reusedSpeculativeResult: z.boolean().optional(),
  /**
   * B0-437 — size of the slimmed, model-facing payload, present only when it differs from the full
   * `output` this entry's `outputPreview` describes. Makes the model-vs-persisted split verifiable
   * from a production trace.
   */
  modelOutputChars: z.number().optional(),
  /**
   * B0-382 — the model-facing output was additionally capped by the tool-output size budget
   * (`~/lib/tools/tool-output-budget`). The persisted `output` this entry's `outputPreview`
   * describes is never capped by it. Absent when the budget did not bite.
   */
  modelOutputBudgetApplied: z.boolean().optional(),
  /** B0-493 — retrieval parameters/strategy for this call, when it ran a RAG search. */
  retrieval: toolRetrievalParamsSchema.optional(),
});

export type ToolTraceEntry = z.infer<typeof toolTraceEntrySchema>;

export const toolTraceSchema = z.array(toolTraceEntrySchema);
