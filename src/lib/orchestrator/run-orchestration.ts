import { runBexChatTurn } from '~/lib/bex/run-chat-turn';
import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';
import {
  bexChatOrchestrationInputSchema,
  orchestrationRoutingSchema,
} from '~/lib/orchestrator/orchestrator-schemas';

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

  /**
   * B0-511 — since the cutover, the LLM intent classifier inside `runProductSupportWorkflow` makes
   * the actual routing decision; the keyword route computed here is comparison metadata only (the
   * five scores keep their wire-contract slots). `routing.decision` is overwritten from the
   * workflow's real decision after the run, so this response never misreports what routed the turn.
   */
  const route = routeUserMessageToSme(message);

  const routing: OrchestrationRouting = {
    decision: route.agent ?? 'ambiguous',
    productScore: route.productScore,
    bathroomScore: route.bathroomScore,
    dilutionScore: route.dilutionScore,
    floorScore: route.floorScore,
    recommendationScore: route.recommendationScore,
    crossReferenceScore: route.crossReferenceScore,
    rationale: route.rationale,
  };

  const steps: OrchestratorStep[] = [
    {
      id: 'route-to-sme',
      status: 'completed',
      note: `Keyword pre-route (comparison only): ${route.agent ?? 'no signal'}. The workflow's LLM intent classifier makes the routing decision — see routing.decision / productSupport.routingDecision.`,
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
    // B0-416 — this path is only reachable through the token-authenticated
    // `/api/v1/orchestrator` route (server-to-server); the browser uses `/api/bex/*`.
    source: 'orchestrator_api',
    modelTag: model,
  });

  steps.push({
    id: 'product-support-workflow',
    status: 'completed',
    note: `Responses API + tools + validator (run ${outcome.workflowRunId}).`,
  });

  // B0-511 — report the decision that actually routed the turn (classifier-driven), not the
  // keyword pre-route; the scores stay as comparison metadata. Parsed through the wire enum so a
  // forced direct agentMode (or any future decision value outside it) leaves the pre-route intact
  // rather than corrupting the contract.
  const actualDecision = orchestrationRoutingSchema.shape.decision.safeParse(
    outcome.routingDecision,
  );
  if (actualDecision.success) {
    routing.decision = actualDecision.data;
    routing.rationale =
      routing.decision === (route.agent ?? 'ambiguous')
        ? routing.rationale
        : `LLM intent classifier routed this turn to "${routing.decision}" (keyword comparison would have chosen "${route.agent ?? 'ambiguous'}": ${route.rationale})`;
  }

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
      // B0-388 — this object is a cherry-pick, not a spread: anything added to
      // `ProductSupportFinalOutput` must be listed here or it never reaches API callers.
      promptVersion: outcome.promptVersion,
      promptBundleVersion: outcome.promptBundleVersion,
      answerProvenance: outcome.answerProvenance,
      priorMessageCount: outcome.priorMessageCount,
      previousResponseId: outcome.previousResponseId,
      // B0-519 — whether the history cap capped/reset this turn's replay; see
      // `capConversationHistory` in `run-product-support-workflow.ts`.
      historyCapApplied: outcome.historyCapApplied,
      // B0-491 — the answering agent's own self-reported confidence, distinct from `confidence`.
      agentConfidence: outcome.agentConfidence,
      agentConfidenceBasis: outcome.agentConfidenceBasis,
      agentConfidenceReason: outcome.agentConfidenceReason,
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
