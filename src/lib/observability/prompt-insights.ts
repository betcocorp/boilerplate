/**
 * Prompt-level AI analysis for the Prompt Observability trace page (epic B0-330).
 *
 * The unit of analysis is ONE prompt's own trace, unlike
 * `~/lib/tests/repository`-backed run insights, which reason over a whole test
 * run's pass/fail spread. Kept here rather than in the route so the payload
 * builder is unit-testable and the route stays thin.
 *
 * B0-420 gives the analysis two things it never had:
 *  - **grading context** — when the run resolves to a harness execution
 *    (`~/lib/observability/harness-linkage`), the model also sees whether the item
 *    passed, what was expected of it, and the ideal response. Purely additive: a
 *    live Bex chat run sends nothing extra and produces exactly what it did before.
 *  - **persistence** — a completed run is immutable, so re-billing a model call on
 *    every panel open bought nothing. Insights are stored in `ai_suggestions` under
 *    `entity_type = 'workflow_run'`; this module owns the row encoding.
 */

import { z } from 'zod';

import type { getWorkflowRunTrace } from '~/lib/observability/runs-repository';
import type { TimelineEvent } from '~/types/observability';

export type WorkflowRunTrace = NonNullable<
  Awaited<ReturnType<typeof getWorkflowRunTrace>>
>;

/**
 * The harness expectations for the run being analysed, narrowed from
 * `HarnessRunContext`. Absent (`null`/`undefined`) for a live run — never
 * synthesised, because a fabricated verdict is worse than no verdict.
 */
export type PromptGradingContext = {
  passed: boolean;
  /**
   * B0-932 — `test_items.minimum_concepts`, one phrase per element, verbatim. Replaces the dropped
   * `expected_should_answer` flag: covering every one of these is what a harness PASS now means,
   * so they are the recorded expectation the analysis reasons against. Empty when the item
   * declares none — stated as such, never as "the agent was expected to answer".
   */
  mandatoryConcepts: string[];
  /** `test_items.ideal_response`, currently null for every row in the database. */
  idealResponse: string | null;
  similarity: number | null;
};

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

/**
 * Grading-aware clauses appended to `PROMPT_INSIGHT_SYSTEM_PROMPT` (B0-420).
 *
 * Three distinct situations, because collapsing them produces a dishonest prompt:
 *  - **failed with an ideal response** — there is a target, so rank fixes by the
 *    divergence from it. This is the branch the ticket is really about, and it is
 *    dormant today: `test_items.ideal_response` is null for all 3,212 rows.
 *  - **failed with mandatory concepts but no ideal response** (B0-932, the common case) —
 *    the concepts ARE the statement of what a correct answer contains, so the model is
 *    pointed at which of them the answer missed.
 *  - **failed with neither** — say so plainly and redirect the model to the signals that
 *    do exist. Never hand it "compare against: null" or ask it to explain a divergence
 *    from nothing; it would invent the missing half.
 *  - **passed** — the analysis must not manufacture a failure to have something to say.
 */
function gradingClause(grading: PromptGradingContext): string {
  if (grading.passed) {
    return `\n\nGRADING CONTEXT: this run is one item of an automated test run, and it PASSED. Do not manufacture a failure. Rank your recommendations by what would make this pass more robust and less luck-dependent on a future run — stronger grounding, fewer wasted or unsettled tool calls, a confidence score better supported by the evidence. If the trace genuinely shows nothing to improve, say so in the lowest-ranked recommendation rather than inventing a problem.`;
  }

  if (grading.idealResponse) {
    return `\n\nGRADING CONTEXT: this run is one item of an automated test run, and it FAILED. The expected answer is given to you under "## Ideal response". Your first task is to explain concretely how the answer produced diverged from it — what it got wrong, omitted, or added — and then rank all 3 recommendations by how much each would close that specific gap. Cite the divergence, not a generic quality concern. Do not treat wording differences as failures: the ideal response is prose guidance, not a string to match.`;
  }

  if (grading.mandatoryConcepts.length > 0) {
    return `\n\nGRADING CONTEXT: this run is one item of an automated test run, and it FAILED. No ideal response was recorded, but the item DOES list the mandatory concepts a correct answer had to cover — they are given under "## Mandatory concepts", and the item fails when any one of them is missing. Work out which of them the answer failed to cover, and rank all 3 recommendations by how much each would close that specific gap. Do not treat wording differences as failures: a concept counts as covered when the answer states it in any words.`;
  }

  return `\n\nGRADING CONTEXT: this run is one item of an automated test run, and it FAILED. It records NO ideal response and NO mandatory concepts, so you have no statement of what a correct answer contains — do not guess at one, and do not claim the answer diverged from something you cannot see. Diagnose the failure from the evidence you do have: the harness's own failure reason, the retrieval similarity, the validator verdict, and the trace. Note that an item with no recorded concepts cannot be graded on content at all, which may itself be the finding worth reporting.`;
}

/** System prompt for one analysis, with the grading clause when the run was graded. */
export function buildPromptInsightSystemPrompt(
  grading?: PromptGradingContext | null,
): string {
  return grading
    ? `${PROMPT_INSIGHT_SYSTEM_PROMPT}${gradingClause(grading)}`
    : PROMPT_INSIGHT_SYSTEM_PROMPT;
}

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

/**
 * B0-906 — JSON Schema mirror of `promptInsightsResponseSchema` for the provider seam's strict
 * structured output (`~/lib/llm/structured-completion`), which replaces the looser
 * `response_format: { type: 'json_object' }` this call used on the OpenAI Chat Completions API.
 * Strict on both providers: `additionalProperties: false`, every property required.
 */
export const PROMPT_INSIGHTS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['insights'],
  properties: {
    insights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rank', 'title', 'description', 'category', 'impact'],
        properties: {
          rank: { type: 'integer' },
          title: { type: 'string' },
          description: { type: 'string' },
          category: {
            type: 'string',
            enum: ['prompt', 'routing', 'tools', 'grounding', 'confidence'],
          },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;

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
    // B0-417 — `ok === null` is a reconstructed call that never settled: unknown,
    // not failed. Null previews were never captured for the run; say so rather than
    // reporting "(none)", which the model would read as an empty argument set.
    case 'tool_call': {
      const outcome = event.ok === null ? 'OUTCOME UNKNOWN' : event.ok ? 'ok' : 'FAILED';
      const preview = (value: string | null) =>
        value === null
          ? '(not captured for this run)'
          : clip(value, PREVIEW_MAX_CHARS) || '(none)';
      return [
        `- TOOL ${event.toolName} — ${outcome} in ${fmtDuration(event.durationMs)}${
          event.reconstructed ? ' (reconstructed from audit rows)' : ''
        }`,
        `    args: ${preview(event.argumentsPreview)}`,
        `    output: ${preview(event.outputPreview)}`,
      ].join('\n');
    }

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

const IDEAL_RESPONSE_MAX_CHARS = 1500;

/**
 * The graded half of the payload. Rendered only when the run resolved to a harness
 * execution, so a live run's payload is byte-for-byte what it was before B0-420.
 *
 * A null `idealResponse` is stated as absent rather than printed as `null`, and the
 * section is not emitted at all without grading context.
 */
function describeGradingContext(grading: PromptGradingContext): string {
  const header = `\n\n## Harness grading
Verdict: ${grading.passed ? 'PASSED' : 'FAILED'}
Pass rule: the item passes when it answered without erroring AND every mandatory concept below was covered; an item with no mandatory concepts is not graded on content.
Retrieval similarity: ${grading.similarity !== null ? grading.similarity.toFixed(3) : 'none recorded (retrieval may not have run)'}`;

  // Concept phrases are regulated free text: printed verbatim, one per line, never re-cased,
  // re-joined or truncated.
  const concepts =
    grading.mandatoryConcepts.length > 0
      ? `

## Mandatory concepts
${grading.mandatoryConcepts.map((concept) => `- ${concept}`).join('\n')}`
      : `
Mandatory concepts: none recorded for this prompt — nothing was declared as required, so the harness could only check that an answer was produced.`;

  if (!grading.idealResponse) {
    return `${header}${concepts}
Ideal response: none recorded for this prompt — there is no reference answer to compare against.`;
  }

  return `${header}${concepts}

## Ideal response
${clip(grading.idealResponse, IDEAL_RESPONSE_MAX_CHARS)}`;
}

/**
 * The user-role content sent alongside `buildPromptInsightSystemPrompt(grading)`.
 *
 * `grading` is optional and additive (B0-420): omit it and the payload is identical to
 * the pre-B0-420 one, which is what live Bex chat and direct orchestrator runs get.
 */
export function buildPromptAnalysisPayload(
  trace: WorkflowRunTrace,
  grading?: PromptGradingContext | null,
): string {
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
  // B0-417 — strictly `false`: an unsettled reconstructed call has `ok === null`
  // and must not be counted as a failure.
  const failedToolCalls = toolCalls.filter((event) => event.ok === false);

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
${eventLines.length > 0 ? eventLines.join('\n') : 'No trace events recorded.'}${
    grading ? describeGradingContext(grading) : ''
  }`;
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

/* -------------------------------------------------------------------------- */
/* Persistence (B0-420)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `ai_suggestions.entity_type` for trace insights, alongside the existing `'item'`
 * scope written by `/admin/tests/[testId]/items/[itemId]`. `entity_id` is the
 * `workflow_runs.id`.
 */
export const PROMPT_INSIGHT_ENTITY_TYPE = 'workflow_run';

/**
 * B0-906 — the model these insights are generated with is no longer a constant here: it comes from
 * the `HARNESS_INSIGHTS_MODEL` settings row via `resolveHarnessInsightsModel`
 * (`~/lib/tests/harness-insights-model`), and the resolved id is passed into
 * `toStoredPromptInsights` so the stored provenance matches what answered. The row is seeded
 * `gpt-4.1-mini`, which is what this call hardcoded before.
 */

/**
 * `ai_suggestions` has columns for the title, the body and the ordering, but not for
 * an insight's category or impact — that table is generic and serves the item scope
 * too. Those two, plus the grading-context flag, ride in `metadata`.
 */
const storedInsightMetadataSchema = z.object({
  gradingContext: z.boolean().optional(),
  category: promptInsightSchema.shape.category,
  impact: promptInsightSchema.shape.impact,
});

/** Structural shape of an `ai_suggestions` row; `AiSuggestionRecord` satisfies it. */
export type StoredPromptInsightRow = {
  title: string;
  content: string;
  sort_order: number;
  created_at: string;
  metadata: unknown;
};

export type StoredPromptInsights = {
  insights: PromptInsight[] | null;
  /** Newest row's `created_at`; the set is inserted in one statement. */
  generatedAt: string | null;
  /**
   * Whether the stored set was generated WITH harness grading context. `false` for a
   * trace-only set and for any legacy row that predates the flag — which is what makes
   * "regenerate once grading context becomes available" decidable.
   */
  gradingContext: boolean;
};

/**
 * Encodes a generated set into `replaceAiSuggestions` input.
 *
 * B0-906 — `model` is passed in rather than read from a constant: the call site resolves the
 * HARNESS_INSIGHTS_MODEL row, so the provenance stored on the row is the id that actually answered
 * (a Claude id when the row names one), not a hardcoded guess.
 */
export function toStoredPromptInsights(
  insights: PromptInsight[],
  options: { gradingContext: boolean; model: string },
): Array<{
  title: string;
  content: string;
  model: string;
  metadata: { gradingContext: boolean; category: string; impact: string };
}> {
  return insights.map((insight) => ({
    title: insight.title,
    content: insight.description,
    model: options.model,
    metadata: {
      gradingContext: options.gradingContext,
      category: insight.category,
      impact: insight.impact,
    },
  }));
}

/**
 * Decodes stored rows back into insights.
 *
 * Rows whose metadata does not carry a valid category/impact are dropped rather than
 * defaulted — labelling an insight with a category the model never chose would be a
 * fabrication, and the caller degrades to "not analysed yet", which is honest and
 * costs one button press. `rank` is re-derived from position so the UI always renders
 * 1-2-3 even if `sort_order` was written oddly.
 */
export function parseStoredPromptInsights(
  rows: StoredPromptInsightRow[],
): StoredPromptInsights {
  if (rows.length === 0) {
    return { insights: null, generatedAt: null, gradingContext: false };
  }

  const ordered = [...rows].sort((a, b) => a.sort_order - b.sort_order);

  const decoded: PromptInsight[] = [];
  let gradingContext = false;

  for (const row of ordered) {
    const meta = storedInsightMetadataSchema.safeParse(row.metadata);
    if (!meta.success) {
      continue;
    }
    if (meta.data.gradingContext === true) {
      gradingContext = true;
    }
    decoded.push({
      rank: decoded.length + 1,
      title: row.title,
      description: row.content,
      category: meta.data.category,
      impact: meta.data.impact,
    });
  }

  if (decoded.length === 0) {
    return { insights: null, generatedAt: null, gradingContext: false };
  }

  const generatedAt = ordered.reduce<string | null>(
    (newest, row) =>
      typeof row.created_at === 'string' && (newest === null || row.created_at > newest)
        ? row.created_at
        : newest,
    null,
  );

  return { insights: decoded, generatedAt, gradingContext };
}
