import { runBexChatTurn } from '~/lib/bex/run-chat-turn';
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

async function runBexChatOrchestration(input: unknown): Promise<OrchestrationRunResult> {
  const { message, model, conversationId } =
    bexChatOrchestrationInputSchema.parse(input);

  const route = routeUserMessageToSme(message);

  const routing: OrchestrationRouting = {
    decision: route.agent ?? 'ambiguous',
    productScore: route.productScore,
    bathroomScore: route.bathroomScore,
    dilutionScore: route.dilutionScore,
    floorScore: route.floorScore,
    recommendationScore: route.recommendationScore,
    rationale: route.rationale,
  };

  const steps: OrchestratorStep[] = [
    {
      id: 'route-to-sme',
      status: 'completed',
      note: route.agent
        ? `Planner hint: **${route.agent}** SME. ${route.rationale}`
        : `No strong SME signal. ${route.rationale}`,
    },
  ];

  if (!message.trim()) {
    steps.push({
      id: 'product-support-workflow',
      status: 'pending',
      note: 'Empty message.',
    });
    return {
      workflow: 'bex-chat',
      input,
      steps,
      routing,
    };
  }

  const outcome = await runBexChatTurn({
    conversationId: conversationId ?? undefined,
    message,
    modelTag: model,
  });

  steps.push({
    id: 'product-support-workflow',
    status: 'completed',
    note: `Responses API + tools + validator (run ${outcome.workflowRunId}).`,
  });

  return {
    workflow: 'bex-chat',
    input,
    steps,
    routing,
    productSupport: {
      answerText: outcome.answerText,
      conversationId: outcome.conversationId,
      workflowRunId: outcome.workflowRunId,
      latestOpenaiResponseId: outcome.latestOpenaiResponseId,
      traceId: outcome.traceId,
      sources: outcome.sources,
      confidence: outcome.confidence,
      validation: outcome.validation,
      routingDecision: outcome.routingDecision,
      usage: outcome.usage,
    },
  };
}

/**
 * Orchestration entry: `bex-chat` runs the product-support Responses workflow with tools + validator.
 */
export async function runOrchestration(
  workflow: string | undefined,
  input: unknown,
): Promise<OrchestrationRunResult> {
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
        note: 'Non-bex-chat workflows are not implemented.',
      },
    ],
  };
}
