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
});

export type ToolTraceEntry = z.infer<typeof toolTraceEntrySchema>;

export const toolTraceSchema = z.array(toolTraceEntrySchema);
