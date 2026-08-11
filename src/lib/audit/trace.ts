import { z } from 'zod';

export const toolTraceEntrySchema = z.object({
  toolName: z.string(),
  callId: z.string(),
  argumentsPreview: z.string().max(2000),
  outputPreview: z.string().max(4000),
  ok: z.boolean(),
  durationMs: z.number().optional(),
  /**
   * B0-437 — size of the slimmed, model-facing payload, present only when it differs from the full
   * `output` this entry's `outputPreview` describes. Makes the model-vs-persisted split verifiable
   * from a production trace.
   */
  modelOutputChars: z.number().optional(),
});

export type ToolTraceEntry = z.infer<typeof toolTraceEntrySchema>;

export const toolTraceSchema = z.array(toolTraceEntrySchema);
