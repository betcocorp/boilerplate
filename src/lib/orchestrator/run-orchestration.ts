import {
  BATHROOM_AGENT_CONTEXT_KEYS,
  runSmeAgent,
} from '~/lib/agents/sme/run-sme-agent';

import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';
import { bexChatOrchestrationInputSchema } from '~/lib/orchestrator/orchestrator-schemas';

export type {
  OrchestrationRouting,
  OrchestrationRunResult,
  OrchestrationSmePayload,
  OrchestratorStep,
} from './orchestrator-schemas';

import type {
  OrchestrationRouting,
  OrchestrationRunResult,
  OrchestratorStep,
} from './orchestrator-schemas';

function runBexChatOrchestration(input: unknown): OrchestrationRunResult {
  const { message, model } = bexChatOrchestrationInputSchema.parse(input);
  const route = routeUserMessageToSme(message);

  const routing: OrchestrationRouting = {
    decision: route.agent ?? 'ambiguous',
    productScore: route.productScore,
    bathroomScore: route.bathroomScore,
    dilutionScore: route.dilutionScore,
    floorScore: route.floorScore,
    rationale: route.rationale,
  };

  const steps: OrchestratorStep[] = [
    {
      id: 'route-to-sme',
      status: 'completed',
      note: route.agent
        ? `Selected **${route.agent}** SME. ${route.rationale}`
        : `Could not route to a specialist. ${route.rationale}`,
    },
  ];

  if (!route.agent) {
    steps.push({
      id: 'invoke-sme-agent',
      status: 'pending',
      note:
        'Ask a clearer question: Betco product / SDS, restroom care, dilution control hardware, or floor maintenance procedures.',
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
      ...(model !== undefined ? { model } : {}),
    },
  });

  const acknowledgement = [
    `${smeResult.label} **received your request** (orchestrator routed correctly).`,
    `Stub pipeline only — next steps are RAG + LLM answer with the SME system prompt and confidence gating.`,
    smeResult.sessionContextGuide.length > 0
      ? `**Session context (recommended):** ${(
          smeResult.agent === 'bathroom'
            ? BATHROOM_AGENT_CONTEXT_KEYS
            : smeResult.sessionContextGuide.map((line) =>
                line.replace(/^`([^`]+)`.*/, '$1'),
              )
        ).join(', ')} in \`context\` when calling the agent.`
      : '',
    '',
    `**Your question:** ${message}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

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
      systemPrompt: smeResult.systemPrompt,
      sessionContextGuide: smeResult.sessionContextGuide,
      steps: smeResult.steps,
    },
  };
}

/**
 * Orchestration entry: for `bex-chat`, routes to Product, Bathroom, Dilution, or Floor specialist stubs
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
