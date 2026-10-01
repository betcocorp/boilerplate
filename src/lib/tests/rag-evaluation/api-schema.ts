import { z } from 'zod';

export const ragEvaluationPostBodySchema = z
  .object({ action: z.enum(['recompute']).optional() })
  .strict();
