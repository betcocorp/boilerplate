import { z } from 'zod';

export const toolTraceEntrySchema = z.object({
  toolName: z.string(),
  callId: z.string(),
  argumentsPreview: z.string().max(2000),
  outputPreview: z.string().max(4000),
  ok: z.boolean(),
  durationMs: z.number().optional(),
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
