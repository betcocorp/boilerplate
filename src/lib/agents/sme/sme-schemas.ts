import { z } from 'zod';

import {
  orchestratorStepSchema,
  productSupportOutcomeSchema,
  smeAgentIdSchema,
} from '~/lib/orchestrator/orchestrator-schemas';

const queryString = z
  .string()
  .max(16000)
  .transform((s) => s.trim())
  .pipe(
    z.string().min(1, { message: 'query is required and must be a non-empty string' }),
  );

/**
 * Validated POST body for `/api/v1/agents/{product|bathroom|dilution|floor}`.
 * Unknown `context` shapes are rejected; omit the field instead of sending arrays/primitives.
 * Bathroom specialist: optional `facilityType`, `primarySurfaces`, `issueOrTask` strings improve routing notes.
 */
export const smeAgentHttpInvokeSchema = z
  .object({
    query: queryString,
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

export type SmeAgentHttpInvoke = z.infer<typeof smeAgentHttpInvokeSchema>;

/** Loose JSON body before validation (non-objects → {}). */
export const smeAgentInvokeBodyLooseSchema = z.preprocess(
  (raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
  z
    .object({
      query: z.unknown().optional(),
      context: z.unknown().optional(),
    })
    .strip(),
);

export type SmeAgentInvokeBodyLoose = z.infer<typeof smeAgentInvokeBodyLooseSchema>;

export const smeAgentRunResultSchema = z.object({
  agent: smeAgentIdSchema,
  label: z.string().min(1).max(512),
  summary: z.string().max(32000),
  focusAreas: z.array(z.string().max(2000)),
  systemPrompt: z.string().max(32000),
  sessionContextGuide: z.array(z.string().max(1000)),
  query: z.string().max(16000),
  context: z.record(z.string(), z.unknown()).nullable(),
  steps: z.array(orchestratorStepSchema),
  /** Present once this agent is wired to the real product-support workflow (see `types.ts`). */
  answer: productSupportOutcomeSchema.optional(),
});

export type SmeAgentRunResultValidated = z.infer<typeof smeAgentRunResultSchema>;

export function safeParseSmeAgentRunResult(value: unknown) {
  return smeAgentRunResultSchema.safeParse(value);
}
