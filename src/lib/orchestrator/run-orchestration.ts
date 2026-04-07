import { runSmeAgent } from '~/lib/agents/sme/run-sme-agent';
import type { SmeAgentId } from '~/lib/agents/sme/types';

import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';

export type OrchestratorStep =
  | { id: string; status: 'completed'; note?: string }
  | { id: string; status: 'pending'; note?: string };

export type OrchestrationRouting = {
  decision: SmeAgentId | 'ambiguous';
  productScore: number;
  bathroomScore: number;
  rationale: string;
};

export type OrchestrationSmePayload = {
  agent: SmeAgentId;
  label: string;
  acknowledgement: string;
  focusAreas: string[];
  steps: OrchestratorStep[];
};

export type OrchestrationRunResult = {
  workflow: string;
  input: unknown;
  steps: OrchestratorStep[];
  routing?: OrchestrationRouting;
  sme?: OrchestrationSmePayload;
};

function extractChatMessage(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return '';
  }

  const msg = (input as Record<string, unknown>).message;

  return typeof msg === 'string' ? msg.trim() : '';
}

function extractModel(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }

  const model = (input as Record<string, unknown>).model;

  return typeof model === 'string' ? model : undefined;
}

function runBexChatOrchestration(input: unknown): OrchestrationRunResult {
  const message = extractChatMessage(input);
  const route = routeUserMessageToSme(message);

  const routing: OrchestrationRouting = {
    decision: route.agent ?? 'ambiguous',
    productScore: route.productScore,
    bathroomScore: route.bathroomScore,
    rationale: route.rationale,
  };

  const steps: OrchestratorStep[] = [
    {
      id: 'route-to-sme',
      status: 'completed',
      note: route.agent
        ? `Selected **${route.agent}** SME. ${route.rationale}`
        : `No single SME selected. ${route.rationale}`,
    },
  ];

  if (!route.agent) {
    steps.push({
      id: 'invoke-sme-agent',
      status: 'pending',
      note:
        'Ask a clearer Product (SKU, specs, model) or Bathroom (vanity, shower, layout) question.',
    });

    return {
      workflow: 'bex-chat',
      input,
      steps,
      routing,
    };
  }

  const smeResult = runSmeAgent(route.agent, {
    query: message,
    context: {
      source: 'bex-orchestrator',
      model: extractModel(input),
    },
  });

  const acknowledgement = [
    `${smeResult.label} **received your request** (orchestrator routed correctly).`,
    `Stub pipeline only — next steps are RAG + LLM answer.`,
    '',
    `**Your question:** ${message}`,
  ].join('\n');

  steps.push(
    {
      id: 'invoke-sme-agent',
      status: 'completed',
      note: `Dispatched to ${smeResult.label} (\`/api/v1/agents/${route.agent}\`).`,
    },
    ...smeResult.steps.map((step) => ({
      ...step,
      id: `sme:${step.id}`,
    })),
  );

  return {
    workflow: 'bex-chat',
    input,
    steps,
    routing,
    sme: {
      agent: smeResult.agent,
      label: smeResult.label,
      acknowledgement,
      focusAreas: smeResult.focusAreas,
      steps: smeResult.steps,
    },
  };
}

/**
 * Orchestration entry: for `bex-chat`, routes to Product or Bathroom SME stubs
 * so you can validate end-to-end behavior before adding LLM/RAG.
 */
export function runOrchestration(
  workflow: string | undefined,
  input: unknown,
): OrchestrationRunResult {
  const name =
    typeof workflow === 'string' && workflow.trim()
      ? workflow.trim()
      : 'default';

  if (name === 'bex-chat') {
    return runBexChatOrchestration(input);
  }

  return {
    workflow: name,
    input,
    steps: [
      { id: 'validate', status: 'completed' as const },
      {
        id: 'plan',
        status: 'pending' as const,
        note: 'Add retrieval, LLM, and side-effect steps here.',
      },
    ],
  };
}
