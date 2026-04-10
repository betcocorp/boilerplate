import { writeAuditLog } from '~/lib/audit/audit-log';
import type { ToolTraceEntry } from '~/lib/audit/trace';
import { insertMessage, jsonContent } from '~/lib/conversations/message-repository';
import { updateConversation } from '~/lib/conversations/conversation-repository';
import {
  completeWorkflowStep,
  insertReviewTask,
  insertWorkflowRun,
  insertWorkflowStep,
  updateWorkflowRun,
} from '~/lib/conversations/workflow-repository';
import type { SourceRef } from '~/lib/conversations/conversation-schemas';
import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { runResponsesWithToolLoop } from '~/lib/openai/responses-runtime';
import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';
import { logError, logInfo } from '~/lib/observability/logger';
import { executeToolCall } from '~/lib/tools/execute-tool-call';
import { productSupportTools } from '~/lib/tools/definitions';

import { buildProductSupportInstructions } from '~/lib/workflows/product-support/product-support-prompts';
import { type ProductSupportFinalOutput } from '~/lib/workflows/product-support/product-support-schemas';
import { runRevisionPass, runValidatorPass } from '~/lib/workflows/product-support/validator';

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

export async function runProductSupportWorkflow(input: {
  traceId: string;
  conversationId: string;
  userMessage: string;
  modelTag?: string;
  previousOpenaiResponseId?: string | null;
}): Promise<ProductSupportFinalOutput> {
  const route = routeUserMessageToSme(input.userMessage);
  const routingDecision = route.agent ?? 'ambiguous';
  const instructions = buildProductSupportInstructions({
    routing: {
      decision: routingDecision,
      rationale: route.rationale,
      productScore: route.productScore,
      bathroomScore: route.bathroomScore,
      dilutionScore: route.dilutionScore,
      floorScore: route.floorScore,
    },
  });

  const model = resolveResponsesModel(input.modelTag);
  const client = getOpenAIClient();

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
    user_input: jsonContent({ message: input.userMessage, modelTag: input.modelTag ?? 'preview' }),
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
        rationale: route.rationale,
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
    input: jsonContent({ model, hasPreviousResponse: Boolean(input.previousOpenaiResponseId) }),
  });

  await writeAuditLog(
    'openai_response_requested',
    { step: 'agent', step_id: agentStep.id },
    { ...wfCtx, stepId: agentStep.id },
  );

  try {
    const toolTrace: ToolTraceEntry[] = [];

    const agentResult = await runResponsesWithToolLoop({
      client,
      model,
      instructions,
      tools: productSupportTools,
      userMessage: input.userMessage,
      previousResponseId: input.previousOpenaiResponseId ?? null,
      executeTool: async ({ name, argumentsJson, callId }) => {
        await writeAuditLog(
          'tool_called',
          { tool_name: name, call_id: callId },
          { ...wfCtx, toolName: name },
        );
        logInfo('tool_called', { ...wfCtx, tool_name: name, call_id: callId });

        const out = await executeToolCall({ name, argumentsJson, callId });

        await writeAuditLog(
          out.trace.ok ? 'tool_succeeded' : 'tool_failed',
          { tool_name: name, call_id: callId },
          { ...wfCtx, toolName: name },
        );

        toolTrace.push(out.trace);
        return out;
      },
    });

    let draftAnswer = agentResult.assistantText;
    const sources = collectSourcesFromTrace(agentResult.toolTrace);
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

    let validation = await runValidatorPass({
      draftAnswer,
      evidenceSummary,
      modelTag: input.modelTag,
    });

    await writeAuditLog('validation_completed', validation, {
      ...wfCtx,
      stepId: validationStep.id,
    });

    if (!validation.approved && validation.issues.length > 0) {
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
        await writeAuditLog('validation_completed', { pass: 'second', ...validation }, {
          ...wfCtx,
          stepId: validationStep.id,
        });
      }
    }

    await completeWorkflowStep(validationStep.id, {
      status: 'completed',
      output: jsonContent(validation),
    });

    let finalText = draftAnswer;

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
          payload: jsonContent({ issues: validation.issues, draft: draftAnswer }),
        });
        await writeAuditLog('review_requested', { issues: validation.issues }, wfCtx);
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
          rationale: route.rationale,
        },
        validation: {
          approved: validation.approved,
          issues: validation.issues,
          requiresHumanReview: validation.requires_human_review,
        },
        toolSummary: agentResult.toolTrace.map((t) => ({ name: t.toolName, ok: t.ok })),
      }),
    });

    await writeAuditLog('workflow_completed', { workflow_run_id: run.id }, wfCtx);
    logInfo('workflow_completed', { ...wfCtx });

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
