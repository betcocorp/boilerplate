import type { OrchestratorStep } from '~/lib/orchestrator/run-orchestration';

export type SmeAgentId = 'product' | 'bathroom';

export type SmeAgentInvokeBody = {
  query?: unknown;
  context?: unknown;
};

export type SmeAgentRunResult = {
  agent: SmeAgentId;
  label: string;
  summary: string;
  focusAreas: string[];
  query: string;
  context: Record<string, unknown> | null;
  steps: OrchestratorStep[];
};
