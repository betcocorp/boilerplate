import { writeAuditLog } from '~/lib/audit/audit-log';
import type { ToolTraceEntry } from '~/lib/audit/trace';
import { updateConversation } from '~/lib/conversations/conversation-repository';
import type { SourceRef } from '~/lib/conversations/conversation-schemas';
import {
  insertMessage,
  jsonContent,
} from '~/lib/conversations/message-repository';
import {
  completeWorkflowStep,
  insertReviewTask,
  insertWorkflowRun,
  insertWorkflowStep,
  updateWorkflowRun,
} from '~/lib/conversations/workflow-repository';
import { logError, logInfo } from '~/lib/observability/logger';
import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { runResponsesWithToolLoop } from '~/lib/openai/responses-runtime';
import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';
import { productSupportTools } from '~/lib/tools/definitions';
import { executeToolCall } from '~/lib/tools/execute-tool-call';

import { buildProductSupportInstructions } from '~/lib/workflows/product-support/product-support-prompts';
import {
  type ProductSupportFinalOutput,
  type ValidatorResult,
} from '~/lib/workflows/product-support/product-support-schemas';
import {
  runRevisionPass,
  runValidatorPass,
} from '~/lib/workflows/product-support/validator';

function collectSourcesFromTrace(toolTrace: ToolTraceEntry[]): SourceRef[] {
  const map = new Map<string, SourceRef>();

  for (const t of toolTrace) {
    if (!t.ok) {
      continue;
    }
    try {
      const j = JSON.parse(t.outputPreview) as {
        sources?: Array<{
          documentId?: string;
          chunkId?: string;
          title?: string;
          snippet?: string;
          confidence?: number;
        }>;
      };
      if (!j.sources) {
        continue;
      }
      for (const s of j.sources) {
        if (!s.documentId || !s.snippet) {
          continue;
        }
        const key = `${s.documentId}:${s.chunkId ?? ''}`;
        if (map.has(key)) {
          continue;
        }
        map.set(key, {
          documentId: s.documentId,
          chunkId: s.chunkId,
          title: s.title ?? s.documentId,
          snippet: s.snippet.slice(0, 2000),
          similarity: s.confidence,
        });
      }
    } catch {
      /* ignore */
    }
  }

  return [...map.values()].slice(0, 16);
}

function buildEvidenceSummary(sources: SourceRef[]): string {
  if (sources.length === 0) {
    return '(no retrieved snippets)';
  }
  return sources
    .map((s) => `[${s.documentId}] ${s.title}\n${s.snippet}`)
    .join('\n\n---\n\n')
    .slice(0, 14_000);
}

function extractRetrievalTiming(toolOutput: string) {
  try {
    const payload = JSON.parse(toolOutput) as {
      retrieval?: { cacheSource?: unknown; searchMs?: unknown };
    };
    const retrieval = payload.retrieval;
    if (!retrieval || typeof retrieval !== 'object' || Array.isArray(retrieval)) {
      return null;
    }

    const cacheSource = retrieval.cacheSource;
    const searchMs = retrieval.searchMs;
    if (typeof cacheSource !== 'string' || typeof searchMs !== 'number') {
      return null;
    }

    return { cacheSource, searchMs };
  } catch {
    return null;
  }
}

function dominantCacheSource(cacheSourceCounts: Map<string, number>) {
  if (cacheSourceCounts.size === 0) {
    return null;
  }

  const sorted = [...cacheSourceCounts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}

function shouldForceCrossReferenceLookup(userMessage: string) {
  const text = userMessage.toLowerCase();
  const hasCrossRefIntent =
    text.includes('comparable') ||
    text.includes('equivalent') ||
    text.includes('cross reference') ||
    text.includes('cross-reference') ||
    text.includes('alternative');
  const hasBetcoContext = text.includes('betco');
  return hasCrossRefIntent && hasBetcoContext;
}

type CrossReferenceMatch = {
  competitorBrand: string | null;
  competitorProductName: string | null;
  productKey: string | null;
  confidence: number | null;
  productUrl: string | null;
  betcoProduct:
    | {
        title?: string | null;
        sku?: string | null;
      }
    | null
    | undefined;
};

type RuntimeToolOutput = {
  toolName: string;
  ok: boolean;
  output: string;
  trace: ToolTraceEntry;
};

export type ProductSupportWorkflowEvent =
  | {
      type: 'status';
      stage:
        | 'routing_selected'
        | 'agent_started'
        | 'agent_completed'
        | 'validation_started'
        | 'validation_completed'
        | 'workflow_completed';
      detail?: string;
    }
  | {
      type: 'tool';
      phase: 'started' | 'completed';
      name: string;
      ok?: boolean;
      callId?: string;
    };

function extractTopCrossReferenceMatch(toolTrace: ToolTraceEntry[]) {
  for (let i = toolTrace.length - 1; i >= 0; i -= 1) {
    const entry = toolTrace[i];
    if (!entry || entry.toolName !== 'lookup_cross_reference' || !entry.ok) {
      continue;
    }

    try {
      const payload = JSON.parse(entry.outputPreview) as {
        fallbackRecommended?: boolean;
        matches?: CrossReferenceMatch[];
      };

      const top = Array.isArray(payload.matches) ? payload.matches[0] : null;
      if (!top) {
        continue;
      }

      return {
        fallbackRecommended: Boolean(payload.fallbackRecommended),
        match: top,
      };
    } catch {
      // Ignore malformed tool output and continue scanning.
    }
  }

  return null;
}

function extractTopCrossReferenceMatchFromToolOutputs(toolOutputs: RuntimeToolOutput[]) {
  for (let i = toolOutputs.length - 1; i >= 0; i -= 1) {
    const entry = toolOutputs[i];
    if (!entry || entry.toolName !== 'lookup_cross_reference' || !entry.ok) {
      continue;
    }

    try {
      const payload = JSON.parse(entry.output) as {
        fallbackRecommended?: boolean;
        matches?: CrossReferenceMatch[];
      };
      const top = Array.isArray(payload.matches) ? payload.matches[0] : null;
      if (!top) {
        continue;
      }
      return {
        fallbackRecommended: Boolean(payload.fallbackRecommended),
        match: top,
      };
    } catch {
      // Ignore malformed output and continue scanning.
    }
  }

  return null;
}

function collectSourcesFromToolOutputs(toolOutputs: RuntimeToolOutput[]): SourceRef[] {
  const map = new Map<string, SourceRef>();

  for (const entry of toolOutputs) {
    if (!entry.ok) {
      continue;
    }
    try {
      const payload = JSON.parse(entry.output) as {
        sources?: Array<{
          documentId?: string;
          chunkId?: string;
          title?: string;
          snippet?: string;
          confidence?: number;
        }>;
      };
      for (const s of payload.sources ?? []) {
        if (!s.documentId || !s.snippet) {
          continue;
        }
        const key = `${s.documentId}:${s.chunkId ?? ''}`;
        if (map.has(key)) {
          continue;
        }
        map.set(key, {
          documentId: s.documentId,
          chunkId: s.chunkId,
          title: s.title ?? s.documentId,
          snippet: s.snippet.slice(0, 2000),
          similarity: s.confidence,
        });
      }
    } catch {
      // Ignore malformed output and continue scanning.
    }
  }

  return [...map.values()].slice(0, 16);
}

function buildCrossReferenceAnswer(match: CrossReferenceMatch) {
  const title =
    match.betcoProduct?.title?.trim() ||
    match.productKey?.trim() ||
    'Betco comparable product';
  const link = match.productUrl?.trim();
  const productLine = link ? `[${title}](${link})` : title;
  const competitorLabel = [
    match.competitorBrand?.trim(),
    match.competitorProductName?.trim(),
  ]
    .filter(Boolean)
    .join(' ');

  return [
    `Comparable Betco product: ${productLine}`,
    '',
    competitorLabel
      ? `This is the direct cross-reference match for ${competitorLabel}.`
      : 'This is the direct cross-reference match from the legacy mapping table.',
    '',
    'Want me to also include usage and safety guidance for this product?',
  ].join('\n');
}

function hasToolCall(toolTrace: ToolTraceEntry[], toolName: string) {
  return toolTrace.some((entry) => entry.toolName === toolName);
}

function buildCrossReferenceSearchArgs(input: {
  userMessage: string;
  crossReferenceMatch: CrossReferenceMatch;
}) {
  const productName =
    input.crossReferenceMatch.betcoProduct?.title?.trim() ||
    input.crossReferenceMatch.productKey?.trim() ||
    'Betco product';

  const competitorName = [
    input.crossReferenceMatch.competitorBrand?.trim(),
    input.crossReferenceMatch.competitorProductName?.trim(),
  ]
    .filter(Boolean)
    .join(' ');

  const topic = competitorName
    ? `comparable to ${competitorName}; ${input.userMessage}`.slice(0, 512)
    : input.userMessage.slice(0, 512);

  return {
    productName: productName.slice(0, 256),
    topic,
  };
}

export async function runProductSupportWorkflow(input: {
  traceId: string;
  conversationId: string;
  userMessage: string;
  modelTag?: string;
  useValidator?: boolean;
  agentMode?: 'orchestrator' | 'product' | 'bathroom' | 'dilution' | 'floor';
  previousOpenaiResponseId?: string | null;
  onEvent?: (event: ProductSupportWorkflowEvent) => void;
  onAssistantDelta?: (delta: string) => void;
}): Promise<ProductSupportFinalOutput> {
  const useValidator = input.useValidator ?? false;
  const agentMode = input.agentMode ?? 'orchestrator';
  const route = routeUserMessageToSme(input.userMessage);
  const routingDecision =
    agentMode === 'orchestrator'
      ? (route.agent ?? 'ambiguous')
      : agentMode;
  const routingRationale =
    agentMode === 'orchestrator'
      ? route.rationale
      : `Forced direct routing to ${agentMode} specialist by admin selection.`;
  const instructions = buildProductSupportInstructions({
    mode: agentMode,
    routing: {
      decision: routingDecision,
      rationale: routingRationale,
      productScore: route.productScore,
      bathroomScore: route.bathroomScore,
      dilutionScore: route.dilutionScore,
      floorScore: route.floorScore,
    },
  });

  const model = resolveResponsesModel(input.modelTag);
  const client = getOpenAIClient();
  input.onEvent?.({
    type: 'status',
    stage: 'routing_selected',
    detail: routingDecision,
  });

  const ctx = {
    traceId: input.traceId,
    conversationId: input.conversationId,
    model,
  };

  await writeAuditLog(
    'workflow_started',
    { workflow: 'product-support', routing: routingDecision },
    { ...ctx, workflowRunId: null },
  );

  logInfo('workflow_started', {
    ...ctx,
    workflow: 'product-support',
    routing: routingDecision,
  });

  const run = await insertWorkflowRun({
    conversation_id: input.conversationId,
    workflow_name: 'product-support',
    status: 'running',
    user_input: jsonContent({
      message: input.userMessage,
      modelTag: input.modelTag ?? 'preview',
    }),
  });

  const wfCtx = { ...ctx, workflowRunId: run.id };

  const plannerStep = await insertWorkflowStep({
    workflow_run_id: run.id,
    step_name: 'orchestration_planner',
    status: 'completed',
    input: jsonContent({ message: input.userMessage }),
    output: jsonContent({
      routing: {
        decision: routingDecision,
        scores: {
          product: route.productScore,
          bathroom: route.bathroomScore,
          dilution: route.dilutionScore,
          floor: route.floorScore,
        },
        rationale: routingRationale,
      },
    }),
    completed_at: new Date().toISOString(),
  });

  await writeAuditLog(
    'step_started',
    { step: 'orchestration_planner', step_id: plannerStep.id },
    { ...wfCtx, stepId: plannerStep.id },
  );

  const agentStep = await insertWorkflowStep({
    workflow_run_id: run.id,
    step_name: 'openai_responses_agent',
    status: 'running',
    input: jsonContent({
      model,
      hasPreviousResponse: Boolean(input.previousOpenaiResponseId),
    }),
  });

  await writeAuditLog(
    'openai_response_requested',
    { step: 'agent', step_id: agentStep.id },
    { ...wfCtx, stepId: agentStep.id },
  );
  input.onEvent?.({ type: 'status', stage: 'agent_started' });

  try {
    const toolTrace: ToolTraceEntry[] = [];
    const toolOutputLog: RuntimeToolOutput[] = [];
    const cacheSourceCounts = new Map<string, number>();
    let totalSearchMs = 0;
    let retrievalSamples = 0;

    const agentResult = await runResponsesWithToolLoop({
      client,
      model,
      instructions,
      tools: productSupportTools,
      userMessage: input.userMessage,
      previousResponseId: input.previousOpenaiResponseId ?? null,
      toolChoice: shouldForceCrossReferenceLookup(input.userMessage)
        ? ({
            type: 'function',
            name: 'lookup_cross_reference',
          } as const)
        : 'auto',
      onAssistantDelta: input.onAssistantDelta,
      executeTool: async ({ name, argumentsJson, callId }) => {
        input.onEvent?.({
          type: 'tool',
          phase: 'started',
          name,
          callId,
        });
        await writeAuditLog(
          'tool_called',
          { tool_name: name, call_id: callId },
          { ...wfCtx, toolName: name },
        );
        logInfo('tool_called', { ...wfCtx, tool_name: name, call_id: callId });

        const out = await executeToolCall({ name, argumentsJson, callId });
        const retrievalTiming = extractRetrievalTiming(out.output);
        if (retrievalTiming) {
          cacheSourceCounts.set(
            retrievalTiming.cacheSource,
            (cacheSourceCounts.get(retrievalTiming.cacheSource) ?? 0) + 1,
          );
          totalSearchMs += retrievalTiming.searchMs;
          retrievalSamples += 1;
        }

        await writeAuditLog(
          out.trace.ok ? 'tool_succeeded' : 'tool_failed',
          { tool_name: name, call_id: callId },
          { ...wfCtx, toolName: name },
        );

        toolTrace.push(out.trace);
        toolOutputLog.push({
          toolName: out.trace.toolName,
          ok: out.trace.ok,
          output: out.output,
          trace: out.trace,
        });
        input.onEvent?.({
          type: 'tool',
          phase: 'completed',
          name,
          ok: out.trace.ok,
          callId,
        });
        return out;
      },
    });
    input.onEvent?.({ type: 'status', stage: 'agent_completed' });
    const timingBreakdown = {
      toolRounds: agentResult.responseIds.length,
      cacheSource: dominantCacheSource(cacheSourceCounts),
      searchMs:
        retrievalSamples > 0 ? Number((totalSearchMs / retrievalSamples).toFixed(1)) : null,
    };

    const resolvedToolTrace = [...agentResult.toolTrace];
    const crossReferenceIntent = shouldForceCrossReferenceLookup(input.userMessage);
    let crossReferenceResult =
      extractTopCrossReferenceMatchFromToolOutputs(toolOutputLog) ??
      extractTopCrossReferenceMatch(resolvedToolTrace);

    if (
      crossReferenceIntent &&
      crossReferenceResult &&
      !hasToolCall(resolvedToolTrace, 'search_product_docs')
    ) {
      const enforcedSearch = await executeToolCall({
        name: 'search_product_docs',
        argumentsJson: JSON.stringify(
          buildCrossReferenceSearchArgs({
            userMessage: input.userMessage,
            crossReferenceMatch: crossReferenceResult.match,
          }),
        ),
        callId: `forced-search-${Date.now()}`,
      });
      resolvedToolTrace.push(enforcedSearch.trace);
      toolOutputLog.push({
        toolName: enforcedSearch.trace.toolName,
        ok: enforcedSearch.trace.ok,
        output: enforcedSearch.output,
        trace: enforcedSearch.trace,
      });
      crossReferenceResult =
        extractTopCrossReferenceMatchFromToolOutputs(toolOutputLog) ??
        extractTopCrossReferenceMatch(resolvedToolTrace);
    }

    let draftAnswer = agentResult.assistantText;
    const crossReferenceFinalAnswer =
      crossReferenceResult &&
      !crossReferenceResult.fallbackRecommended &&
      Boolean(crossReferenceResult.match.productUrl)
        ? buildCrossReferenceAnswer(crossReferenceResult.match)
        : null;
    if (crossReferenceFinalAnswer) {
      draftAnswer = crossReferenceFinalAnswer;
    }

    const sources = collectSourcesFromToolOutputs(toolOutputLog);
    const evidenceSummary = buildEvidenceSummary(sources);

    await completeWorkflowStep(agentStep.id, {
      status: 'completed',
      output: jsonContent({
        responseIds: agentResult.responseIds,
        toolCalls: agentResult.toolTrace.length,
      }),
    });

    const validationStep = await insertWorkflowStep({
      workflow_run_id: run.id,
      step_name: 'validator',
      status: 'running',
      input: jsonContent({ modelTag: input.modelTag ?? 'preview' }),
    });
    input.onEvent?.({ type: 'status', stage: 'validation_started' });

    // TODO: Remove this runtime toggle when validator behavior is fully tuned.
    let validation: ValidatorResult;
    if (useValidator) {
      validation = await runValidatorPass({
        draftAnswer,
        evidenceSummary,
        modelTag: input.modelTag,
      });
    } else {
      validation = {
        approved: true,
        confidence: sources.length > 0 ? 0.9 : 0.6,
        issues: ['validator_bypassed_for_testing'],
        requires_human_review: false,
      };
    }

    await writeAuditLog('validation_completed', validation, {
      ...wfCtx,
      stepId: validationStep.id,
    });

    if (useValidator && !validation.approved && validation.issues.length > 0) {
      const revised = await runRevisionPass({
        draftAnswer,
        validatorIssues: validation.issues,
        evidenceSummary,
        modelTag: input.modelTag,
      });
      if (revised.trim()) {
        draftAnswer = revised;
        validation = await runValidatorPass({
          draftAnswer,
          evidenceSummary,
          modelTag: input.modelTag,
        });
        await writeAuditLog(
          'validation_completed',
          { pass: 'second', ...validation },
          {
            ...wfCtx,
            stepId: validationStep.id,
          },
        );
      }
    }

    await completeWorkflowStep(validationStep.id, {
      status: 'completed',
      output: jsonContent(
        useValidator
          ? validation
          : {
              ...validation,
              skipped: true,
              reason: 'temporary_test_bypass',
            },
      ),
    });
    input.onEvent?.({
      type: 'status',
      stage: 'validation_completed',
      detail: validation.approved ? 'approved' : 'not_approved',
    });

    let finalText = draftAnswer;

    // Enforce deterministic cross-reference output format when available.
    // This runs after validation/revision to prevent the model from drifting from the
    // required "Comparable Betco product: [Name](URL)" response shape.
    if (crossReferenceFinalAnswer) {
      finalText = crossReferenceFinalAnswer;
    }

    if (!validation.approved) {
      finalText = [
        'I could not fully verify this answer against the retrieved approved sources.',
        '',
        '**Next steps**',
        '- Confirm the exact Betco product name or SKU.',
        '- Specify the surface/material and environment.',
        '',
        'If this is safety-urgent, follow your facility protocol and SDS guidance.',
      ].join('\n');

      if (validation.requires_human_review) {
        await insertReviewTask({
          workflowRunId: run.id,
          reason: 'validator_rejected',
          payload: jsonContent({
            issues: validation.issues,
            draft: draftAnswer,
          }),
        });
        await writeAuditLog(
          'review_requested',
          { issues: validation.issues },
          wfCtx,
        );
      }
    }

    const finalOutput: ProductSupportFinalOutput = {
      answerText: finalText,
      sources,
      confidence: validation.confidence,
      workflowRunId: run.id,
      latestOpenaiResponseId: agentResult.finalResponseId,
      validation,
      routingDecision,
      timingBreakdown,
    };

    await updateWorkflowRun(run.id, {
      status: 'completed',
      final_output: jsonContent(finalOutput),
      confidence: validation.confidence,
    });

    await updateConversation(input.conversationId, {
      latest_openai_response_id: agentResult.finalResponseId,
      latest_model: model,
    });

    await insertMessage({
      conversation_id: input.conversationId,
      role: 'assistant',
      plain_text: finalText,
      openai_response_id: agentResult.finalResponseId,
      content: jsonContent({
        kind: 'assistant_turn',
        text: finalText,
        model,
        sources,
        confidence: validation.confidence,
        workflowRunId: run.id,
        routingHint: {
          decision: routingDecision,
          rationale: routingRationale,
        },
        validation: {
          approved: validation.approved,
          issues: validation.issues,
          requiresHumanReview: validation.requires_human_review,
        },
        timingBreakdown,
        toolSummary: resolvedToolTrace.map((t) => ({
          name: t.toolName,
          ok: t.ok,
        })),
      }),
    });

    await writeAuditLog(
      'workflow_completed',
      { workflow_run_id: run.id },
      wfCtx,
    );
    logInfo('workflow_completed', { ...wfCtx });
    input.onEvent?.({ type: 'status', stage: 'workflow_completed' });

    return finalOutput;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError('workflow_failed', { ...wfCtx, message });

    await completeWorkflowStep(agentStep.id, {
      status: 'failed',
      error: jsonContent({ message }),
    });

    await updateWorkflowRun(run.id, {
      status: 'failed',
      final_output: jsonContent({ error: message }),
    });

    await writeAuditLog('workflow_failed', { message }, wfCtx);

    throw err;
  }
}
