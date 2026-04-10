import { z } from 'zod';

export const toolTraceEntrySchema = z.object({
  toolName: z.string(),
  callId: z.string(),
  argumentsPreview: z.string().max(2000),
  outputPreview: z.string().max(4000),
  ok: z.boolean(),
  durationMs: z.number().optional(),
});

export type ToolTraceEntry = z.infer<typeof toolTraceEntrySchema>;

export const toolTraceSchema = z.array(toolTraceEntrySchema);
