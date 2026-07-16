import { z } from 'zod';
import { SME_AGENT_IDS, type SmeAgentId } from '~/lib/agents/agent-registry';

export type { SmeAgentId };

/** SME identifiers the orchestrator can route to or embed in results. */
export const smeAgentIdSchema = z.enum(SME_AGENT_IDS);

const stepId = z.string().min(1).max(256);
const stepNote = z.string().max(8000).optional();

export const orchestratorStepSchema = z.discriminatedUnion('status', [
  z.object({
    id: stepId,
    status: z.literal('completed'),
    note: stepNote,
  }),
  z.object({
    id: stepId,
    status: z.literal('pending'),
    note: stepNote,
  }),
]);

export type OrchestratorStep = z.infer<typeof orchestratorStepSchema>;

export const orchestrationRoutingSchema = z.object({
  decision: z.union([smeAgentIdSchema, z.literal('ambiguous')]),
  productScore: z.number().finite().int().nonnegative(),
  bathroomScore: z.number().finite().int().nonnegative(),
  dilutionScore: z.number().finite().int().nonnegative(),
  floorScore: z.number().finite().int().nonnegative(),
  recommendationScore: z.number().finite().int().nonnegative(),
  rationale: z.string().max(8000),
});

export type OrchestrationRouting = z.infer<typeof orchestrationRoutingSchema>;

export const orchestrationSmePayloadSchema = z.object({
  agent: smeAgentIdSchema,
  label: z.string().min(1).max(512),
  acknowledgement: z.string().max(32000),
  focusAreas: z.array(z.string().max(2000)),
  systemPrompt: z.string().max(32000),
  sessionContextGuide: z.array(z.string().max(1000)),
  steps: z.array(orchestratorStepSchema),
});

export type OrchestrationSmePayload = z.infer<typeof orchestrationSmePayloadSchema>;

export const sourceRefSchema = z.object({
  documentId: z.string(),
  chunkId: z.string().optional(),
  title: z.string(),
  snippet: z.string(),
  similarity: z.number().optional(),
});

export const validatorResultSchema = z.object({
  approved: z.boolean(),
  confidence: z.number(),
  issues: z.array(z.string()),
  requires_human_review: z.boolean(),
});

export const productSupportOutcomeSchema = z.object({
  answerText: z.string(),
  conversationId: z.string().uuid(),
  workflowRunId: z.string().uuid(),
  latestOpenaiResponseId: z.string(),
  traceId: z.string().uuid(),
  sources: z.array(sourceRefSchema).optional(),
  confidence: z.number().optional(),
  validation: validatorResultSchema,
  routingDecision: z.string().optional(),
  /** B0-117 — LLM token usage for per-request cost attribution in api_request_log. */
  usage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
});

export type ProductSupportOutcome = z.infer<typeof productSupportOutcomeSchema>;

export const orchestrationRunResultSchema = z.object({
  workflow: z.string().min(1).max(256),
  input: z.unknown(),
  steps: z.array(orchestratorStepSchema),
  routing: orchestrationRoutingSchema.optional(),
  sme: orchestrationSmePayloadSchema.optional(),
  productSupport: productSupportOutcomeSchema.optional(),
});

export type OrchestrationRunResult = z.infer<typeof orchestrationRunResultSchema>;

export const bexOrchestrateOkResponseSchema = z
  .object({ ok: z.literal(true) })
  .and(orchestrationRunResultSchema);

export type BexOrchestrateOkResponse = z.infer<typeof bexOrchestrateOkResponseSchema>;

/**
 * Normalizes orchestrator `bex-chat` workflow input: non-objects and wrong types
 * degrade to an empty message (same intent as the previous manual guards).
 */
export const bexChatOrchestrationInputSchema = z.preprocess(
  (raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
  z
    .object({
      message: z.unknown(),
      model: z.unknown(),
      conversationId: z.unknown(),
    })
    .strip()
    .transform(({ message, model, conversationId }) => {
      const m =
        typeof message === 'string'
          ? message.trim().slice(0, 16000)
          : '';
      const mod =
        typeof model === 'string' && model.trim()
          ? model.trim().slice(0, 128)
          : undefined;
      let conv: string | undefined;
      if (typeof conversationId === 'string' && conversationId.trim()) {
        const id = conversationId.trim();
        conv = z.string().uuid().safeParse(id).success ? id : undefined;
      }
      return { message: m, model: mod, conversationId: conv };
    }),
);

export type BexChatOrchestrationInput = z.infer<
  typeof bexChatOrchestrationInputSchema
>;

const trimmedNonEmpty = z
  .string()
  .max(16000)
  .transform((s) => s.trim())
  .pipe(z.string().min(1));

/** POST /api/v1/orchestrator when `message` is present (browser or API chat). */
export const orchestratorBexChatPostBodySchema = z
  .object({
    message: trimmedNonEmpty,
    model: z
      .union([z.string(), z.null(), z.undefined()])
      .transform((s) => {
        if (typeof s !== 'string' || !s.trim()) {
          return 'preview';
        }
        return s.trim().slice(0, 128);
      }),
    conversationId: z
      .union([z.string(), z.null(), z.undefined()])
      .transform((s) => {
        if (typeof s !== 'string' || !s.trim()) {
          return undefined;
        }
        const id = s.trim();
        return z.string().uuid().safeParse(id).success ? id : undefined;
      }),
    workflow: z
      .union([z.string(), z.null(), z.undefined()])
      .transform((s) => {
        if (typeof s !== 'string' || !s.trim()) {
          return 'bex-chat' as const;
        }
        return s.trim().slice(0, 256);
      }),
  })
  .strip();

export type OrchestratorBexChatPostBody = z.infer<
  typeof orchestratorBexChatPostBodySchema
>;

function asRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

export type ParsedOrchestratorPostBody =
  | {
      ok: true;
      mode: 'bex-chat';
      workflow: string;
      orchestrationInput: {
        message: string;
        model: string;
        conversationId?: string;
      };
    }
  | {
      ok: true;
      mode: 'generic';
      workflow: string | undefined;
      orchestrationInput: unknown;
    }
  | { ok: false; error: string; issues: z.core.$ZodIssue[] };

/**
 * Mirrors route branching: non-empty trimmed `message` → bex-chat payload; otherwise generic.
 * Raw JSON arrays / primitives yield generic mode with `undefined` workflow and `undefined` input.
 */
export function parseOrchestratorPostBody(raw: unknown): ParsedOrchestratorPostBody {
  const obj = asRecord(raw);
  const messageRaw = obj.message;

  if (typeof messageRaw === 'string' && messageRaw.trim().length > 0) {
    const parsed = orchestratorBexChatPostBodySchema.safeParse(obj);
    if (!parsed.success) {
      return {
        ok: false,
        error: 'Invalid orchestrator chat body',
        issues: parsed.error.issues,
      };
    }
    const { message, model, workflow, conversationId } = parsed.data;
    return {
      ok: true,
      mode: 'bex-chat',
      workflow,
      orchestrationInput: { message, model, conversationId },
    };
  }

  const workflow =
    typeof obj.workflow === 'string' && obj.workflow.trim()
      ? obj.workflow.trim().slice(0, 256)
      : undefined;

  return {
    ok: true,
    mode: 'generic',
    workflow,
    orchestrationInput: 'input' in obj ? obj.input : undefined,
  };
}

export function safeParseOrchestrationRunResult(
  value: unknown,
): z.ZodSafeParseResult<OrchestrationRunResult> {
  return orchestrationRunResultSchema.safeParse(value);
}
