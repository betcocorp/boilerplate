import type {
  OrchestratorStep,
  ProductSupportOutcome,
  SmeAgentId,
} from '~/lib/orchestrator/orchestrator-schemas';

export type { SmeAgentId };

/** Internal runner input (may be unvalidated when not from HTTP). */
export type SmeAgentInvokeBody = {
  query?: unknown;
  context?: unknown;
};

export type SmeAgentRunResult = {
  agent: SmeAgentId;
  label: string;
  summary: string;
  focusAreas: string[];
  /** SME system instructions for the model layer (Betco guardrails, tone, escalation rules). */
  systemPrompt: string;
  /** Suggested `context` keys clients should persist per session for better answers. */
  sessionContextGuide: string[];
  query: string;
  context: Record<string, unknown> | null;
  steps: OrchestratorStep[];
  /**
   * B0-520/521/522/523 — present once this agent is wired to `runProductSupportWorkflow`
   * (forced single-specialist routing, the same mechanism the Bex chat UI uses); the same
   * cherry-picked shape `run-orchestration.ts` returns as `productSupport`. Absent for any
   * agent still on the `runSmeAgent` placeholder (only `recommendations`, currently).
   */
  answer?: ProductSupportOutcome;
};
