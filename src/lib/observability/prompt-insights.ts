/**
 * Prompt-level AI analysis for the Prompt Observability trace page (epic B0-330).
 *
 * The unit of analysis is ONE prompt's own trace, unlike
 * `~/lib/tests/repository`-backed run insights, which reason over a whole test
 * run's pass/fail spread. Kept here rather than in the route so the payload
 * builder is unit-testable and the route stays thin.
 *
 * Read-only by design: the observability repository never writes and
 * `workflow_runs` has no insights column, so nothing here persists.
 */

import { z } from 'zod';

import type { getWorkflowRunTrace } from '~/lib/observability/runs-repository';
import type { TimelineEvent } from '~/types/observability';

export type WorkflowRunTrace = NonNullable<
  Awaited<ReturnType<typeof getWorkflowRunTrace>>
>;

export const PROMPT_INSIGHT_SYSTEM_PROMPT = `You are a prompt engineer reviewing the execution trace of a SINGLE prompt through Betco's product-support agent workflow.

You receive one run: the user's message, how the router classified it, which tools the agent called (with arguments, outcomes and durations), which confidence gates fired, the validator's verdict, and the answer that was produced.

Your task: give exactly 3 specific, actionable recommendations for making THIS prompt perform better on a future run — higher confidence, better grounding, fewer wasted tool calls, or a more appropriate route. Rank them 1-3, most impactful first.

Ground every recommendation in the trace you were given. Quote the concrete signal (the routing decision, the tool that failed, the gate that capped confidence, the validator issue). Do NOT speculate about data you cannot see, and do NOT invent tool names, product names, or numbers.

Betco context: this workflow answers questions about commercial cleaning chemicals, many of them EPA-registered. Never recommend loosening a safety, regulated-claim, or human-review guardrail to raise a confidence score — those gates are deliberate. If a gate capped confidence, the useful recommendation is how to satisfy it (better evidence, clearer scope), not how to bypass it.

Categories:
- prompt: the user message itself is ambiguous, under-specified, or missing the brand/product/context the agent needed
- routing: the router picked a specialist that does not match the actual intent
- tools: wrong tool, missing tool call, redundant duplicate calls, or a tool that errored
- grounding: retrieval returned weak, missing, or off-scope evidence for the answer given
- confidence: a gate or validator verdict held the score down and the trace shows why

Respond ONLY with valid JSON matching this exact schema:
{
  "insights": [
    {
      "rank": 1,
      "title": "short title (max 60 chars)",
      "description": "2-3 sentences citing specific evidence from this trace",
      "category": "prompt",
      "impact": "high"
    }
  ]
}

category must be one of: prompt, routing, tools, grounding, confidence
impact must be one of: high, medium, low`;

export const promptInsightSchema = z.object({
  rank: z.number().int(),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(['prompt', 'routing', 'tools', 'grounding', 'confidence']),
  impact: z.enum(['high', 'medium', 'low']),
});

export const promptInsightsResponseSchema = z.object({
  insights: z.array(promptInsightSchema).min(1),
});

export type PromptInsight = z.infer<typeof promptInsightSchema>;

/** How many recommendations the UI renders. */
export const PROMPT_INSIGHT_COUNT = 3;

/** Tool arg/output previews are already truncated at write time; trim again for the prompt budget. */
const PREVIEW_MAX_CHARS = 400;
const ANSWER_MAX_CHARS = 1200;

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function readField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function readString(value: unknown, key: string): string | null {
  const field = readField(value, key);
  return typeof field === 'string' && field.trim() ? field.trim() : null;
}

function countArray(value: unknown, key: string): number | null {
  const field = readField(value, key);
  return Array.isArray(field) ? field.length : null;
}

/**
 * `diffMs` in `~/lib/observability/timeline` drops negative spans rather than
 * clamping them (`workflow_steps.started_at` is Postgres `now()` while
 * `completed_at` comes from the Node clock, so a fast step can read negative).
 * Render those as unknown rather than as 0, so the model is never told a slow
 * step took no time.
 */
function fmtDuration(durationMs: number | undefined): string {
  return typeof durationMs === 'number' ? `${durationMs}ms` : 'unknown';
}

export function describeTimelineEvent(event: TimelineEvent): string | null {
  switch (event.kind) {
    case 'tool_call':
      return [
        `- TOOL ${event.toolName} — ${event.ok ? 'ok' : 'FAILED'} in ${fmtDuration(event.durationMs)}`,
        `    args: ${clip(event.argumentsPreview, PREVIEW_MAX_CHARS) || '(none)'}`,
        `    output: ${clip(event.outputPreview, PREVIEW_MAX_CHARS) || '(none)'}`,
      ].join('\n');

    case 'confidence_gate':
      return [
        `- GATE ${event.gate}:`,
        `confidence ${event.confidenceBefore ?? 'n/a'} -> ${event.confidenceAfter ?? 'n/a'}`,
        event.cap !== null ? `cap ${event.cap}` : null,
        event.approved !== null ? `approved=${event.approved}` : null,
        event.requiresHumanReview ? 'requiresHumanReview=true' : null,
        event.issues.length > 0 ? `issues: ${event.issues.join('; ')}` : null,
        event.inferred ? '(inferred — no direct log entry)' : null,
      ]
        .filter(Boolean)
        .join(' | ');

    case 'review':
      return `- REVIEW REQUESTED: reason=${event.reason ?? 'n/a'}${
        event.issues.length > 0 ? ` | issues: ${event.issues.join('; ')}` : ''
      }`;

    case 'step':
      return `- STEP ${event.stepName} — ${event.status} (${event.rawStatus ?? 'n/a'}) in ${fmtDuration(event.durationMs)}${
        event.error ? ` | error: ${clip(JSON.stringify(event.error), PREVIEW_MAX_CHARS)}` : ''
      }`;

    case 'audit':
      return `- EVENT ${event.eventType}`;

    // Lifecycle markers are already covered by the run header.
    case 'lifecycle':
      return null;

    default:
      return null;
  }
}

/** The user-role content sent alongside `PROMPT_INSIGHT_SYSTEM_PROMPT`. */
export function buildPromptAnalysisPayload(trace: WorkflowRunTrace): string {
  const { run, timeline } = trace;

  const userMessage = readString(run.user_input, 'message');
  const routingDecision = readString(run.final_output, 'routingDecision');
  const answerText = readString(run.final_output, 'answerText');
  const validation = readField(run.final_output, 'validation');
  const sourceCount = countArray(run.final_output, 'sources');
  const chunkCount = countArray(run.final_output, 'retrieved_document_chunks');
  const runError = readString(run.final_output, 'error');

  const toolCalls = timeline.filter(
    (event): event is Extract<TimelineEvent, { kind: 'tool_call' }> =>
      event.kind === 'tool_call',
  );
  const failedToolCalls = toolCalls.filter((event) => !event.ok);

  const toolNameCounts = new Map<string, number>();
  for (const call of toolCalls) {
    toolNameCounts.set(call.toolName, (toolNameCounts.get(call.toolName) ?? 0) + 1);
  }
  const repeatedTools = [...toolNameCounts.entries()].filter(([, count]) => count > 1);

  const eventLines = timeline
    .map(describeTimelineEvent)
    .filter((line): line is string => line !== null);

  return `## Run
Status: ${run.status}
Workflow: ${run.workflow_name}
Routing decision: ${routingDecision ?? 'unknown'}
Final confidence: ${run.confidence ?? 'n/a'}
Validator verdict: ${validation ? JSON.stringify(validation) : 'none recorded'}
Sources cited: ${sourceCount ?? 'n/a'}
Retrieved chunks: ${chunkCount ?? 'n/a'}
Tool calls: ${toolCalls.length} (${failedToolCalls.length} failed)
Repeated tools: ${
    repeatedTools.length > 0
      ? repeatedTools.map(([name, count]) => `${name} x${count}`).join(', ')
      : 'none'
  }
${runError ? `Run error: ${clip(runError, PREVIEW_MAX_CHARS)}` : ''}

## User message
${userMessage ?? '(none recorded)'}

## Answer produced
${answerText ? clip(answerText, ANSWER_MAX_CHARS) : '(no answer text recorded)'}

## Trace (${eventLines.length} events, chronological)
${eventLines.length > 0 ? eventLines.join('\n') : 'No trace events recorded.'}`;
}

/**
 * Keep the top N and renumber, so a model that over-returns or mis-ranks still
 * renders as a clean 1-2-3 list.
 */
export function normalizePromptInsights(insights: PromptInsight[]): PromptInsight[] {
  return insights
    .slice(0, PROMPT_INSIGHT_COUNT)
    .map((insight, index) => ({ ...insight, rank: index + 1 }));
}
