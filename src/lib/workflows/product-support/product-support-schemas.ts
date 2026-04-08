import { z } from 'zod';

export const validatorResultSchema = z.object({
  approved: z.boolean(),
  confidence: z.number().min(0).max(1),
  issues: z.array(z.string()),
  requires_human_review: z.boolean(),
});

export type ValidatorResult = z.infer<typeof validatorResultSchema>;

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
  confidence: z.number().min(0).max(1).optional(),
  workflowRunId: z.string().uuid(),
  latestOpenaiResponseId: z.string(),
  validation: validatorResultSchema,
  routingDecision: z.string().optional(),
});

export type ProductSupportFinalOutput = z.infer<typeof productSupportFinalOutputSchema>;
