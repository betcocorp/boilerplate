/**
 * B0-533 — read-only repository for the admin conversation browser (epic B0-526).
 *
 * Two readers, both composed from the existing per-table repositories where one exists:
 *  - `listConversationsForAdmin` — one page of `agent_conversations` plus per-conversation turn
 *    counts and Σ `processing_ms` / Σ `user_pause_ms`, aggregated from ONE batched, `.range()`-paged
 *    select of the page's message rows (never a query per conversation).
 *  - `getConversationTurns` — every message of one conversation paired into turns (a user message
 *    plus the assistant reply that followed it), each turn matched to its `workflow_runs` row and
 *    that run's planner routing and tool calls.
 *
 * The pure parts (turn pairing, run matching, aggregation, the planner/tool-trace readers) are
 * exported for unit tests. Message↔run linkage: every assistant message persisted by the chat
 * stream carries `content.workflowRunId` (`assistantMessageContentSchema`), which is the primary
 * match; a turn whose run failed before an assistant message was written (so nothing carries the
 * id) falls back to the first unclaimed run created between that user message and the next one.
 *
 * Pause/processing semantics come from `~/lib/conversations/turn-metrics.ts` (B0-531/532) and are
 * read off the stored columns, never recomputed here.
 */

import { z } from 'zod';

import { toolTraceSchema } from '~/lib/audit/trace';
import { assistantMessageContentSchema } from '~/lib/conversations/conversation-schemas';
import { listMessagesForConversation } from '~/lib/conversations/message-repository';
import { readPauseTier, type PauseTier } from '~/lib/conversations/turn-metrics';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/* -------------------------------------------------------------------------- *
 * Row schemas (Zod first — the live tables are untyped `text`/`jsonb` in places)
 * -------------------------------------------------------------------------- */

export const adminConversationRowSchema = z.object({
  id: z.string(),
  user_id: z.string().nullable(),
  acted_by_user_id: z.string().nullable(),
  title: z.string(),
  source: z.string(),
  test_name: z.string().nullable(),
  latest_model: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AdminConversationRow = z.infer<typeof adminConversationRowSchema>;

/** The slice of `agent_messages` the list aggregation reads — deliberately no text columns. */
export const conversationMessageMetricRowSchema = z.object({
  conversation_id: z.string(),
  role: z.string(),
  created_at: z.string(),
  processing_ms: z.number().nullable(),
  user_pause_ms: z.number().nullable(),
});
export type ConversationMessageMetricRow = z.infer<typeof conversationMessageMetricRowSchema>;

/** Full message row for the detail page (what `listMessagesForConversation` returns). */
export const conversationMessageRowSchema = conversationMessageMetricRowSchema.extend({
  id: z.string(),
  content: z.unknown(),
  plain_text: z.string().nullable(),
  pause_tier: z.string().nullable(),
});
export type ConversationMessageRow = z.infer<typeof conversationMessageRowSchema>;

/**
 * `workflow_runs` projected through PostgREST JSON-path aliases so the detail page never pulls
 * the full `final_output` (answer text + retrieved chunks) for every run of a long conversation.
 */
export const conversationRunRowSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  status: z.string(),
  confidence: z.number().nullable(),
  source: z.string().nullable(),
  app_version: z.string().nullable(),
  prompt_bundle_version: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  /** `final_output->>routingDecision` */
  routing_decision: z.string().nullable(),
  /** `final_output->>promptVersion` */
  prompt_version: z.string().nullable(),
});
export type ConversationRunRow = z.infer<typeof conversationRunRowSchema>;

export const conversationStepRowSchema = z.object({
  id: z.string(),
  workflow_run_id: z.string(),
  step_name: z.string(),
  status: z.string(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  output: z.unknown(),
});
export type ConversationStepRow = z.infer<typeof conversationStepRowSchema>;

const appUserProfileRowSchema = z.object({
  user_id: z.string(),
  user_name: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
});

/* -------------------------------------------------------------------------- *
 * Public types
 * -------------------------------------------------------------------------- */

export type ConversationSourceFilter = 'chat' | 'test_run' | 'all';

export type ConversationListFilters = {
  source: ConversationSourceFilter;
  /** ISO timestamp, inclusive lower bound on `agent_conversations.created_at`. */
  from: string;
  /** ISO timestamp, inclusive upper bound on `agent_conversations.created_at`. */
  to: string;
  /** An `app_user.user_id`; matches the owner OR the acting admin (`acted_by_user_id`). */
  userId?: string;
  /** Already-normalized substring; matches the title or any user message in the window. */
  search?: string;
  /** Keep only conversations with at least this many user turns. */
  minTurns?: number;
  limit?: number;
  offset?: number;
};

/** A resolved person for the owner / acted-by columns (`app_user` has no FK from conversations). */
export type ConversationPerson = {
  userId: string;
  displayName: string | null;
  email: string | null;
};

export type ConversationOwnerDisplay =
  | { kind: 'user'; person: ConversationPerson }
  | { kind: 'test'; testName: string | null }
  | { kind: 'unattributed' };

export type ConversationMetrics = {
  /** User-message count. */
  turnCount: number;
  /** Σ `processing_ms` over assistant rows; null when no row carried one. */
  agentMs: number | null;
  /** Σ `user_pause_ms` over user rows; null when no row carried one. */
  pauseMs: number | null;
  /** Assistant rows that carried `processing_ms` / user rows that carried `user_pause_ms`. */
  agentSampleSize: number;
  pauseSampleSize: number;
  lastActivityAt: string | null;
};

export type ConversationListRow = {
  id: string;
  title: string;
  source: 'chat' | 'test_run';
  startedAt: string;
  lastActivityAt: string;
  latestModel: string | null;
  owner: ConversationOwnerDisplay;
  /** B0-1084 — the real author when an admin was "Acting as" the owner. */
  actedBy: ConversationPerson | null;
  metrics: ConversationMetrics;
};

export type ConversationTurnMessage = {
  id: string;
  text: string;
  createdAt: string;
};

export type ConversationTurnUser = ConversationTurnMessage & {
  pauseMs: number | null;
  pauseTier: PauseTier | null;
};

export type ConversationTurnAssistant = ConversationTurnMessage & {
  processingMs: number | null;
  model: string | null;
  /** `content.confidence` as persisted on the message (the run's own confidence is on `run`). */
  confidence: number | null;
  /** `content.workflowRunId` — the primary message↔run link. */
  workflowRunId: string | null;
  /** `content.toolSummary` — name + ok only; durations come from the run's tool trace. */
  toolSummary: { name: string; ok: boolean }[];
};

export type PlannerRouting = {
  decision: string | null;
  rationale: string | null;
  /** The LLM intent classifier's self-reported confidence (`gates[].inputs.classifierConfidence`). */
  classifierConfidence: number | null;
  classifierSource: string | null;
};

export type TurnToolCall = {
  toolName: string;
  ok: boolean;
  durationMs: number | null;
  origin: string | null;
};

export type ConversationTurnRun = {
  id: string;
  status: string;
  confidence: number | null;
  routingDecision: string | null;
  appVersion: string | null;
  promptBundleVersion: string | null;
  promptVersion: string | null;
  createdAt: string;
  updatedAt: string;
  /** How the run was matched to its turn. */
  matchedBy: 'message_link' | 'timestamp';
  planner: PlannerRouting | null;
  toolCalls: TurnToolCall[];
  /** `workflow_steps` summary for the compact step strip. */
  steps: { name: string; status: string; durationMs: number | null }[];
};

export type ConversationTurn = {
  /** 1-based. */
  index: number;
  user: ConversationTurnUser;
  assistant: ConversationTurnAssistant | null;
  run: ConversationTurnRun | null;
};

export type ConversationTurnTotals = {
  agentMs: number | null;
  pauseMs: number | null;
  /** `agentMs / (agentMs + pauseMs)`, 0–1; null when neither sum exists or both are 0. */
  agentShare: number | null;
};

export type ConversationDetail = {
  conversation: ConversationListRow;
  turns: ConversationTurn[];
  totals: ConversationTurnTotals;
  /** Assistant rows that preceded any user message — never paired, reported rather than hidden. */
  orphanAssistantMessages: number;
  /** Runs on this conversation that no turn claimed. */
  unmatchedRunIds: string[];
};

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** PostgREST caps a request at 1000 rows; every multi-row read below pages at that size. */
const SCAN_PAGE_SIZE = 1000;
const MAX_SCAN_PAGES = 20;
/** `.in()` filters are URL-encoded; keep them bounded (workflow-repository precedent). */
const IN_CHUNK_SIZE = 150;
/** Search-by-message: how many matching user rows to read, and how many conversation ids to keep. */
const SEARCH_MESSAGE_ROWS = 500;
const SEARCH_MAX_CONVERSATION_IDS = 150;
/**
 * Timestamp-fallback tolerance: `workflow_runs.created_at` is stamped by Postgres when the run row
 * is inserted, which happens after the user message row is written, so a run should never predate
 * its user message — the skew allowance only guards against a future writer with its own clock.
 */
const RUN_MATCH_SKEW_MS = 2_000;

/* -------------------------------------------------------------------------- *
 * Small JSON readers
 * -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function clampOffset(offset: number | undefined): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) {
    return 0;
  }
  return Math.floor(offset);
}

function normalizeSource(source: string): 'chat' | 'test_run' {
  return source === 'test_run' ? 'test_run' : 'chat';
}

function durationBetween(from: string, to: string | null): number | null {
  if (!to) {
    return null;
  }
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  // Same 0-clamp as `timeline.ts`: `started_at` is Postgres `now()`, `completed_at` the Node clock.
  return Math.max(0, end - start);
}

/* -------------------------------------------------------------------------- *
 * Pure folds — exported for unit tests
 * -------------------------------------------------------------------------- */

/**
 * Per-conversation turn count and time sums from a flat list of message metric rows. A sum is
 * null (not 0) when no row of that role carried the metric, so a pre-B0-532 conversation reads
 * as "unmeasured" rather than "instant".
 */
export function aggregateConversationMetrics(
  rows: readonly ConversationMessageMetricRow[],
): Map<string, ConversationMetrics> {
  const index = new Map<string, ConversationMetrics>();

  for (const row of rows) {
    const entry = index.get(row.conversation_id) ?? {
      turnCount: 0,
      agentMs: null,
      pauseMs: null,
      agentSampleSize: 0,
      pauseSampleSize: 0,
      lastActivityAt: null,
    };

    if (row.role === 'user') {
      entry.turnCount += 1;
      if (typeof row.user_pause_ms === 'number') {
        entry.pauseMs = (entry.pauseMs ?? 0) + row.user_pause_ms;
        entry.pauseSampleSize += 1;
      }
    } else if (row.role === 'assistant' && typeof row.processing_ms === 'number') {
      entry.agentMs = (entry.agentMs ?? 0) + row.processing_ms;
      entry.agentSampleSize += 1;
    }

    if (!entry.lastActivityAt || row.created_at > entry.lastActivityAt) {
      entry.lastActivityAt = row.created_at;
    }

    index.set(row.conversation_id, entry);
  }

  return index;
}

const EMPTY_METRICS: ConversationMetrics = {
  turnCount: 0,
  agentMs: null,
  pauseMs: null,
  agentSampleSize: 0,
  pauseSampleSize: 0,
  lastActivityAt: null,
};

/**
 * Message text precedence: `plain_text` (the denormalized column every writer fills) first, then
 * `content.text`. Empty string when neither exists — a turn is still a turn.
 */
function readMessageText(row: ConversationMessageRow): string {
  if (row.plain_text && row.plain_text.trim()) {
    return row.plain_text;
  }
  return readString(asRecord(row.content), 'text') ?? '';
}

function toAssistantTurn(row: ConversationMessageRow): ConversationTurnAssistant {
  const parsed = assistantMessageContentSchema.safeParse(row.content);
  const content = parsed.success ? parsed.data : null;
  // Tolerant fallback for pre-schema rows: the run id may be present even if another field fails.
  const workflowRunId = content?.workflowRunId ?? readString(asRecord(row.content), 'workflowRunId');

  return {
    id: row.id,
    text: readMessageText(row),
    createdAt: row.created_at,
    processingMs: row.processing_ms,
    model: content?.model ?? readString(asRecord(row.content), 'model'),
    confidence: content?.confidence ?? readNumber(asRecord(row.content), 'confidence'),
    workflowRunId,
    toolSummary: content?.toolSummary ?? [],
  };
}

/**
 * Pairs an ordered message list into turns: each user message opens a turn; the first assistant
 * message before the next user message closes it. A user message followed directly by another
 * user message (the run failed before a reply was written) is a turn with `assistant: null`.
 * Assistant rows before any user message cannot belong to a turn and are counted, not dropped.
 */
export function pairConversationTurns(rows: readonly ConversationMessageRow[]): {
  turns: Omit<ConversationTurn, 'run'>[];
  orphanAssistantMessages: number;
} {
  const ordered = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const turns: Omit<ConversationTurn, 'run'>[] = [];
  let orphanAssistantMessages = 0;

  for (const row of ordered) {
    if (row.role === 'user') {
      turns.push({
        index: turns.length + 1,
        user: {
          id: row.id,
          text: readMessageText(row),
          createdAt: row.created_at,
          pauseMs: row.user_pause_ms,
          pauseTier: readPauseTier(row.pause_tier),
        },
        assistant: null,
      });
      continue;
    }

    if (row.role !== 'assistant') {
      // Tool/system rows carry no turn metric and are not part of the user-visible exchange.
      continue;
    }

    const current = turns[turns.length - 1];
    if (!current) {
      orphanAssistantMessages += 1;
      continue;
    }
    if (current.assistant === null) {
      current.assistant = toAssistantTurn(row);
    }
    // A second assistant row inside one turn would be a writer bug; keep the first, ignore the rest.
  }

  return { turns, orphanAssistantMessages };
}

/**
 * Planner routing off the `orchestration_planner` step output: `output.routing.{decision,
 * rationale}` plus the LLM classifier's confidence from the `llm_intent_classifier_live` gate
 * (falling back to the `signals_analysis` gate's `signals.confidence`). Null when the step has no
 * readable routing block.
 */
export function readPlannerRouting(output: unknown): PlannerRouting | null {
  const record = asRecord(output);
  const routing = asRecord(record?.routing);
  if (!record || !routing) {
    return null;
  }

  let classifierConfidence: number | null = null;
  let classifierSource: string | null = null;
  const gates = Array.isArray(record.gates) ? record.gates : [];
  for (const gate of gates) {
    const gateRecord = asRecord(gate);
    const inputs = asRecord(gateRecord?.inputs);
    const gateName = readString(gateRecord, 'gate');
    if (gateName === 'llm_intent_classifier_live') {
      classifierConfidence = readNumber(inputs, 'classifierConfidence');
      classifierSource = readString(inputs, 'classifierSource');
      break;
    }
    if (gateName === 'signals_analysis' && classifierConfidence === null) {
      const signals = asRecord(inputs?.signals);
      classifierConfidence = readNumber(signals, 'confidence');
      classifierSource = readString(signals, 'source');
    }
  }

  return {
    decision: readString(routing, 'decision'),
    rationale: readString(routing, 'rationale'),
    classifierConfidence,
    classifierSource,
  };
}

/** Compact tool-call list off the agent step's persisted `output.toolTrace` (B0-331). */
export function readTurnToolCalls(output: unknown): TurnToolCall[] {
  const record = asRecord(output);
  if (!record || !('toolTrace' in record)) {
    return [];
  }
  const parsed = toolTraceSchema.safeParse(record.toolTrace);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.map((entry) => ({
    toolName: entry.toolName,
    ok: entry.ok,
    durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : null,
    origin: entry.origin ?? null,
  }));
}

const PLANNER_STEP_NAME = 'orchestration_planner';
const AGENT_STEP_NAME = 'openai_responses_agent';

/**
 * Assembles a turn's run view from its run row and that run's steps. Routing decision prefers the
 * run's own `final_output.routingDecision` (what the runs list filters on), falling back to the
 * planner step's decision for a run that died before `final_output` was written.
 */
export function buildTurnRun(
  run: ConversationRunRow,
  steps: readonly ConversationStepRow[],
  matchedBy: ConversationTurnRun['matchedBy'],
): ConversationTurnRun {
  const ordered = [...steps].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const plannerStep = ordered.find((step) => step.step_name === PLANNER_STEP_NAME);
  const agentStep = ordered.find((step) => step.step_name === AGENT_STEP_NAME);
  const planner = plannerStep ? readPlannerRouting(plannerStep.output) : null;

  return {
    id: run.id,
    status: run.status,
    confidence: run.confidence,
    routingDecision: run.routing_decision ?? planner?.decision ?? null,
    appVersion: run.app_version,
    promptBundleVersion: run.prompt_bundle_version,
    promptVersion: run.prompt_version,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    matchedBy,
    planner,
    toolCalls: agentStep ? readTurnToolCalls(agentStep.output) : [],
    steps: ordered.map((step) => ({
      name: step.step_name,
      status: step.status,
      durationMs: durationBetween(step.started_at, step.completed_at),
    })),
  };
}

/**
 * Matches runs to turns. Pass 1 claims every run named by an assistant message's
 * `content.workflowRunId`. Pass 2, for turns still without a run (no assistant reply was written),
 * claims the earliest unclaimed run created at/after the user message and before the next turn's
 * user message. Each run is claimed at most once; runs nothing claims are reported.
 */
export function matchRunsToTurns(
  turns: readonly Omit<ConversationTurn, 'run'>[],
  runs: readonly ConversationRunRow[],
  stepsByRunId: ReadonlyMap<string, ConversationStepRow[]>,
): { turns: ConversationTurn[]; unmatchedRunIds: string[] } {
  const runById = new Map(runs.map((run) => [run.id, run] as const));
  const claimed = new Set<string>();
  const resolved: (ConversationTurnRun | null)[] = turns.map(() => null);

  turns.forEach((turn, i) => {
    const linkedId = turn.assistant?.workflowRunId;
    const run = linkedId ? runById.get(linkedId) : undefined;
    if (run && !claimed.has(run.id)) {
      claimed.add(run.id);
      resolved[i] = buildTurnRun(run, stepsByRunId.get(run.id) ?? [], 'message_link');
    }
  });

  const orderedRuns = [...runs].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );

  turns.forEach((turn, i) => {
    if (resolved[i]) {
      return;
    }
    const lowerBound = Date.parse(turn.user.createdAt) - RUN_MATCH_SKEW_MS;
    const next = turns[i + 1];
    const upperBound = next ? Date.parse(next.user.createdAt) : Number.POSITIVE_INFINITY;

    const candidate = orderedRuns.find((run) => {
      if (claimed.has(run.id)) {
        return false;
      }
      const at = Date.parse(run.created_at);
      return Number.isFinite(at) && at >= lowerBound && at < upperBound;
    });

    if (candidate) {
      claimed.add(candidate.id);
      resolved[i] = buildTurnRun(candidate, stepsByRunId.get(candidate.id) ?? [], 'timestamp');
    }
  });

  return {
    turns: turns.map((turn, i) => ({ ...turn, run: resolved[i] })),
    unmatchedRunIds: orderedRuns.filter((run) => !claimed.has(run.id)).map((run) => run.id),
  };
}

/** Σ agent time vs Σ user pause over a turn list, plus the agent share for the proportion bar. */
export function summarizeTurnTotals(turns: readonly ConversationTurn[]): ConversationTurnTotals {
  let agentMs: number | null = null;
  let pauseMs: number | null = null;

  for (const turn of turns) {
    if (typeof turn.user.pauseMs === 'number') {
      pauseMs = (pauseMs ?? 0) + turn.user.pauseMs;
    }
    if (typeof turn.assistant?.processingMs === 'number') {
      agentMs = (agentMs ?? 0) + turn.assistant.processingMs;
    }
  }

  const denominator = (agentMs ?? 0) + (pauseMs ?? 0);
  return {
    agentMs,
    pauseMs,
    agentShare: denominator > 0 ? (agentMs ?? 0) / denominator : null,
  };
}

/* -------------------------------------------------------------------------- *
 * Owner resolution
 * -------------------------------------------------------------------------- */

async function indexUserProfiles(
  userIds: readonly string[],
): Promise<Map<string, ConversationPerson>> {
  const index = new Map<string, ConversationPerson>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) {
    return index;
  }

  const supabase = getSupabaseServiceRoleClient();
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
    const { data, error } = await supabase
      .from('app_user')
      .select('user_id, user_name, name, email')
      .in('user_id', ids.slice(i, i + IN_CHUNK_SIZE));
    if (error) {
      throw new Error(error.message);
    }
    for (const raw of data ?? []) {
      const parsed = appUserProfileRowSchema.safeParse(raw);
      if (!parsed.success) {
        continue;
      }
      index.set(parsed.data.user_id, {
        userId: parsed.data.user_id,
        displayName: parsed.data.user_name ?? parsed.data.name ?? null,
        email: parsed.data.email ?? null,
      });
    }
  }
  return index;
}

/**
 * Owner display for a conversation row. Mirrors `resolveConversationOwnerAttribution`
 * (`conversation-owner-view.ts`): test-runner rows show the test name, a `chat` row with no
 * `user_id` is unattributed, otherwise the resolved person (falling back to the bare id).
 */
export function resolveOwnerDisplay(
  row: Pick<AdminConversationRow, 'source' | 'user_id' | 'test_name'>,
  profiles: ReadonlyMap<string, ConversationPerson>,
): ConversationOwnerDisplay {
  if (normalizeSource(row.source) === 'test_run') {
    return { kind: 'test', testName: row.test_name };
  }
  if (!row.user_id) {
    return { kind: 'unattributed' };
  }
  return {
    kind: 'user',
    person: profiles.get(row.user_id) ?? { userId: row.user_id, displayName: null, email: null },
  };
}

function toListRow(
  row: AdminConversationRow,
  metrics: ConversationMetrics,
  profiles: ReadonlyMap<string, ConversationPerson>,
): ConversationListRow {
  return {
    id: row.id,
    title: row.title,
    source: normalizeSource(row.source),
    startedAt: row.created_at,
    lastActivityAt: metrics.lastActivityAt ?? row.updated_at,
    latestModel: row.latest_model,
    owner: resolveOwnerDisplay(row, profiles),
    actedBy: row.acted_by_user_id
      ? (profiles.get(row.acted_by_user_id) ?? {
          userId: row.acted_by_user_id,
          displayName: null,
          email: null,
        })
      : null,
    metrics,
  };
}

/* -------------------------------------------------------------------------- *
 * Queries
 * -------------------------------------------------------------------------- */

const CONVERSATION_COLUMNS =
  'id, user_id, acted_by_user_id, title, source, test_name, latest_model, status, created_at, updated_at';

/** One batched, paged read of the metric columns for a set of conversation ids. */
async function fetchMessageMetrics(
  conversationIds: readonly string[],
): Promise<ConversationMessageMetricRow[]> {
  const rows: ConversationMessageMetricRow[] = [];
  if (conversationIds.length === 0) {
    return rows;
  }
  const supabase = getSupabaseServiceRoleClient();

  for (let i = 0; i < conversationIds.length; i += IN_CHUNK_SIZE) {
    const chunk = conversationIds.slice(i, i + IN_CHUNK_SIZE);
    for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
      const start = page * SCAN_PAGE_SIZE;
      const { data, error } = await supabase
        .from('agent_messages')
        .select('conversation_id, role, created_at, processing_ms, user_pause_ms')
        .in('conversation_id', chunk)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(start, start + SCAN_PAGE_SIZE - 1);
      if (error) {
        throw new Error(error.message);
      }
      const batch = z.array(conversationMessageMetricRowSchema).parse(data ?? []);
      rows.push(...batch);
      if (batch.length < SCAN_PAGE_SIZE) {
        break;
      }
    }
  }
  return rows;
}

/**
 * Conversation ids whose user messages contain `term` within the window — the "first prompt"
 * half of the search. Bounded: newest `SEARCH_MESSAGE_ROWS` matching rows, at most
 * `SEARCH_MAX_CONVERSATION_IDS` distinct conversations, so the `.or()` filter stays URL-safe.
 */
async function searchConversationIdsByMessage(
  term: string,
  window: { from: string; to: string },
): Promise<string[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_messages')
    .select('conversation_id')
    .eq('role', 'user')
    .ilike('plain_text', `%${term}%`)
    .gte('created_at', window.from)
    .lte('created_at', window.to)
    .order('created_at', { ascending: false })
    .limit(SEARCH_MESSAGE_ROWS);
  if (error) {
    throw new Error(error.message);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of data ?? []) {
    if (!seen.has(row.conversation_id)) {
      seen.add(row.conversation_id);
      ids.push(row.conversation_id);
      if (ids.length >= SEARCH_MAX_CONVERSATION_IDS) {
        break;
      }
    }
  }
  return ids;
}

/** `title ilike %term% OR id in (message matches)` as a PostgREST `.or()` expression. */
function buildSearchOrFilter(term: string, messageMatchIds: readonly string[]): string {
  const clauses = [`title.ilike.%${term}%`];
  if (messageMatchIds.length > 0) {
    clauses.push(`id.in.(${messageMatchIds.join(',')})`);
  }
  return clauses.join(',');
}

function buildUserOrFilter(userId: string): string {
  return `user_id.eq.${userId},acted_by_user_id.eq.${userId}`;
}

/**
 * `minTurns` cannot be expressed as a PostgREST filter without an RPC, so when it is set the
 * listing is driven from a bounded, paged scan of user messages (embedding the conversation to
 * apply the same filters), counted per conversation in Node, then paginated in memory. The 7-day
 * default window holds a few thousand user messages — a handful of pages.
 */
async function listConversationIdsWithMinTurns(
  filters: ConversationListFilters,
  minTurns: number,
  searchOr: string | null,
): Promise<{ orderedIds: string[]; total: number }> {
  const supabase = getSupabaseServiceRoleClient();
  const userTurns = new Map<string, { count: number; createdAt: string }>();

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    let query = supabase
      .from('agent_messages')
      .select('conversation_id, agent_conversations!inner(id, created_at)')
      .eq('role', 'user')
      .gte('agent_conversations.created_at', filters.from)
      .lte('agent_conversations.created_at', filters.to);
    if (filters.source !== 'all') {
      query = query.eq('agent_conversations.source', filters.source);
    }
    if (filters.userId) {
      query = query.or(buildUserOrFilter(filters.userId), {
        referencedTable: 'agent_conversations',
      });
    }
    if (searchOr) {
      query = query.or(searchOr, { referencedTable: 'agent_conversations' });
    }

    const { data, error } = await query
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(start, start + SCAN_PAGE_SIZE - 1);
    if (error) {
      throw new Error(error.message);
    }

    const batch = (data ?? []) as unknown[];
    for (const raw of batch) {
      const record = asRecord(raw);
      const conversationId = readString(record, 'conversation_id');
      const embedded = Array.isArray(record?.agent_conversations)
        ? asRecord(record?.agent_conversations[0])
        : asRecord(record?.agent_conversations);
      const createdAt = readString(embedded, 'created_at');
      if (!conversationId || !createdAt) {
        continue;
      }
      const entry = userTurns.get(conversationId) ?? { count: 0, createdAt };
      entry.count += 1;
      userTurns.set(conversationId, entry);
    }

    if (batch.length < SCAN_PAGE_SIZE) {
      break;
    }
  }

  const orderedIds = [...userTurns.entries()]
    .filter(([, entry]) => entry.count >= minTurns)
    .sort((a, b) => Date.parse(b[1].createdAt) - Date.parse(a[1].createdAt))
    .map(([id]) => id);

  return { orderedIds, total: orderedIds.length };
}

/**
 * One page of conversations for `/admin/bex/conversations`, newest first, with per-row metrics.
 * Queries: (optional) message search, the page itself (`count: 'exact'` for the total), one
 * batched metrics read for the page's ids, one `app_user` lookup for owner + acted-by ids.
 */
export async function listConversationsForAdmin(
  filters: ConversationListFilters,
): Promise<{ rows: ConversationListRow[]; total: number }> {
  const supabase = getSupabaseServiceRoleClient();
  const limit = clampLimit(filters.limit);
  const offset = clampOffset(filters.offset);

  let searchOr: string | null = null;
  if (filters.search) {
    const messageMatchIds = await searchConversationIdsByMessage(filters.search, {
      from: filters.from,
      to: filters.to,
    });
    searchOr = buildSearchOrFilter(filters.search, messageMatchIds);
  }

  let pageRows: AdminConversationRow[] = [];
  let total = 0;

  const minTurns =
    typeof filters.minTurns === 'number' && Number.isFinite(filters.minTurns) && filters.minTurns > 1
      ? Math.floor(filters.minTurns)
      : null;

  if (minTurns !== null) {
    const matched = await listConversationIdsWithMinTurns(filters, minTurns, searchOr);
    total = matched.total;
    const pageIds = matched.orderedIds.slice(offset, offset + limit);
    if (pageIds.length > 0) {
      const { data, error } = await supabase
        .from('agent_conversations')
        .select(CONVERSATION_COLUMNS)
        .in('id', pageIds);
      if (error) {
        throw new Error(error.message);
      }
      const byId = new Map(
        z.array(adminConversationRowSchema).parse(data ?? []).map((row) => [row.id, row] as const),
      );
      pageRows = pageIds.map((id) => byId.get(id)).filter((row): row is AdminConversationRow => Boolean(row));
    }
  } else {
    let query = supabase
      .from('agent_conversations')
      .select(CONVERSATION_COLUMNS, { count: 'exact' })
      .gte('created_at', filters.from)
      .lte('created_at', filters.to)
      .order('created_at', { ascending: false });
    if (filters.source !== 'all') {
      query = query.eq('source', filters.source);
    }
    if (filters.userId) {
      query = query.or(buildUserOrFilter(filters.userId));
    }
    if (searchOr) {
      query = query.or(searchOr);
    }

    const { data, error, count } = await query.range(offset, offset + limit - 1);
    if (error) {
      throw new Error(error.message);
    }
    pageRows = z.array(adminConversationRowSchema).parse(data ?? []);
    total = count ?? pageRows.length;
  }

  if (pageRows.length === 0) {
    return { rows: [], total };
  }

  const [metricRows, profiles] = await Promise.all([
    fetchMessageMetrics(pageRows.map((row) => row.id)),
    indexUserProfiles(
      pageRows.flatMap((row) => [row.user_id, row.acted_by_user_id]).filter((id): id is string => Boolean(id)),
    ),
  ]);
  const metricsById = aggregateConversationMetrics(metricRows);

  return {
    rows: pageRows.map((row) => toListRow(row, metricsById.get(row.id) ?? EMPTY_METRICS, profiles)),
    total,
  };
}

async function listRunsForConversation(conversationId: string): Promise<ConversationRunRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const rows: ConversationRunRow[] = [];
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    const { data, error } = await supabase
      .from('workflow_runs')
      .select(
        'id, conversation_id, status, confidence, source, app_version, prompt_bundle_version, created_at, updated_at, routing_decision:final_output->>routingDecision, prompt_version:final_output->>promptVersion',
      )
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .range(start, start + SCAN_PAGE_SIZE - 1);
    if (error) {
      throw new Error(error.message);
    }
    const batch = z.array(conversationRunRowSchema).parse(data ?? []);
    rows.push(...batch);
    if (batch.length < SCAN_PAGE_SIZE) {
      break;
    }
  }
  return rows;
}

async function indexStepsByRunId(
  runIds: readonly string[],
): Promise<Map<string, ConversationStepRow[]>> {
  const index = new Map<string, ConversationStepRow[]>();
  if (runIds.length === 0) {
    return index;
  }
  const supabase = getSupabaseServiceRoleClient();

  for (let i = 0; i < runIds.length; i += IN_CHUNK_SIZE) {
    const chunk = runIds.slice(i, i + IN_CHUNK_SIZE);
    for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
      const start = page * SCAN_PAGE_SIZE;
      const { data, error } = await supabase
        .from('workflow_steps')
        .select('id, workflow_run_id, step_name, status, started_at, completed_at, output')
        .in('workflow_run_id', chunk)
        .order('started_at', { ascending: true })
        .order('id', { ascending: true })
        .range(start, start + SCAN_PAGE_SIZE - 1);
      if (error) {
        throw new Error(error.message);
      }
      const batch = z.array(conversationStepRowSchema).parse(data ?? []);
      for (const step of batch) {
        const list = index.get(step.workflow_run_id) ?? [];
        list.push(step);
        index.set(step.workflow_run_id, list);
      }
      if (batch.length < SCAN_PAGE_SIZE) {
        break;
      }
    }
  }
  return index;
}

/**
 * Everything the detail page needs for one conversation, or null when the id resolves to no row.
 * Four reads: the conversation, its messages (`listMessagesForConversation`), its runs, and the
 * runs' steps in one batched read.
 */
export async function getConversationTurns(
  conversationId: string,
): Promise<ConversationDetail | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: conversationData, error: conversationError } = await supabase
    .from('agent_conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('id', conversationId)
    .maybeSingle();
  if (conversationError) {
    throw new Error(conversationError.message);
  }
  if (!conversationData) {
    return null;
  }
  const conversation = adminConversationRowSchema.parse(conversationData);

  const [messages, runs, profiles] = await Promise.all([
    listMessagesForConversation(conversationId),
    listRunsForConversation(conversationId),
    indexUserProfiles(
      [conversation.user_id, conversation.acted_by_user_id].filter((id): id is string => Boolean(id)),
    ),
  ]);
  const stepsByRunId = await indexStepsByRunId(runs.map((run) => run.id));

  const messageRows = z.array(conversationMessageRowSchema).parse(messages);
  const paired = pairConversationTurns(messageRows);
  const matched = matchRunsToTurns(paired.turns, runs, stepsByRunId);
  const metrics = aggregateConversationMetrics(messageRows);

  return {
    conversation: toListRow(conversation, metrics.get(conversation.id) ?? EMPTY_METRICS, profiles),
    turns: matched.turns,
    totals: summarizeTurnTotals(matched.turns),
    orphanAssistantMessages: paired.orphanAssistantMessages,
    unmatchedRunIds: matched.unmatchedRunIds,
  };
}
