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
 * B0-619 — the product-line lock decision behind a search-backed tool call (see
 * `ProductLineResolutionResult` in `~/lib/retrieval/product-line-resolution.ts`, which every
 * `ragQueryForProductKnowledgeWithMeta` branch already computes as `retrieval.productLineResolution`
 * — this just gives that shape a schema so it can be captured off the full tool payload the same way
 * `toolRetrievalParamsSchema` captures `retrieval.search`/`retrieval.selection`). Shared with
 * `productSupportFinalOutputSchema`'s run-level `productLineLock` so both persist the identical shape.
 */
export const productLineLockSchema = z.object({
  candidates: z.array(
    z.object({
      productLineKey: z.string(),
      label: z.string().nullable(),
      maxSimilarity: z.number(),
    }),
  ),
  lockedProductLineKey: z.string().nullable(),
  lockReason: z.enum([
    'explicit_filter',
    'high_confidence',
    'skipped_low_confidence',
    'skipped_ambiguous',
    'skipped_no_product_line',
    'resolution_disabled',
    // B0-873 — mirrors `ProductLineResolutionResult.lockReason` (product-line-resolution.ts).
    'skipped_knowledge_top_hit',
  ]),
  /**
   * B0-693 — mirrors `ProductKnowledgeRetrievalSummary.explicitKeySource`
   * (`~/lib/retrieval/product-knowledge.ts`), carried onto the lock decision itself so it survives
   * into `final_output.productLineLock` via the existing `extractProductLineLockFromToolTrace`
   * extraction — previously this distinction (alias-anchored vs. a bare broad-similarity lock)
   * was computed per call but never persisted anywhere a run's own trace could show it. Optional:
   * absent on rows written before this ticket.
   */
  explicitKeySource: z.string().nullable().optional(),
});

export type ProductLineLock = z.infer<typeof productLineLockSchema>;

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
  /**
   * B0-975 — hybrid RPC candidates returned by the lexical leg with a NULL `similarity` (no
   * embedding) and therefore excluded from ranking instead of being scored 0. Optional: absent on
   * rows written before this ticket.
   */
  lexicalOnlyCandidateCount: z.number().int().nonnegative().optional(),
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
  /**
   * B0-619 — the product-line lock decision for this call, when its retrieval summary carried one
   * (every `ragQueryForProductKnowledgeWithMeta` branch does). Optional so historical rows written
   * before this ticket still parse.
   */
  productLineResolution: productLineLockSchema.optional(),
});

export type ToolRetrievalParams = z.infer<typeof toolRetrievalParamsSchema>;

/**
 * B0-292 — the actual pages a `recommend_cross_reference` call's web search step found, captured
 * from the FULL tool payload at `executeToolCall` time (never reconstructed from the truncated
 * `outputPreview`, which routinely drops this — it sits well past the potentially-large `sources[]`/
 * `candidates[]` arrays in the payload). Present only when the call ran a web search that actually
 * returned a response (`recommend_cross_reference`'s web-grounded path, `evidence.webSearchResults`
 * in `recommend-cross-reference.ts`); absent for the confident-legacy fast path, a
 * budget-short-circuited or failed search, every other tool, and rows written before this ticket.
 * URLs, titles and snippets are transcribed exactly as the provider returned them — never truncated,
 * reworded, rounded, or summarized here.
 */
export const toolWebSearchParamsSchema = z.object({
  /** The exact query string sent to the search provider (see `buildRecommendationQuery`). */
  query: z.string(),
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      /** `null` only if the provider genuinely returned no snippet for this result. */
      snippet: z.string().nullable(),
    }),
  ),
  /** Provider queries actually spent (1 = basic only, 2 = escalated to advanced too). */
  searchesUsed: z.number(),
  /** Whether the search escalated from `basic` to `advanced` depth. */
  escalated: z.boolean(),
});

export type ToolWebSearchParams = z.infer<typeof toolWebSearchParamsSchema>;

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
  /** B0-292 — the web pages found by this call's web search step, when it ran one. */
  webSearch: toolWebSearchParamsSchema.optional(),
});

export type ToolTraceEntry = z.infer<typeof toolTraceEntrySchema>;

export const toolTraceSchema = z.array(toolTraceEntrySchema);
