/**
 * B0-536 — reusable, typed query library for conversation-observability dashboards.
 *
 * Read-only and UI-free, like `~/lib/observability/aggregates.ts` (B0-336), and built the same
 * way: bounded paged scans over PostgREST, folded in Node by pure functions that are exported for
 * unit tests. The same documented trigger for change applies — if a window's row count ever
 * exceeds the page budget or these calls become a visible latency source, replace the scans with
 * Postgres RPCs rather than growing the budgets.
 *
 * Three queries:
 *  - pass rate by agent — from `test_result_items` (the eval-harness table `aggregates.ts`
 *    already scans for TTFT), grouped by the stored `routing_decision`;
 *  - escalation vs confidence — `review_tasks` (the durable escalation row, per
 *    `countHumanReviewRuns`) against `workflow_runs.confidence`, bucketed with the exact
 *    boundaries the aggregate dashboard uses;
 *  - pause-tier distribution — `agent_messages.pause_tier` (B0-531), user turns only by
 *    construction (the tier is generated from `user_pause_ms`, which only user rows carry).
 */

import {
  CONFIDENCE_HIGH_MIN,
  CONFIDENCE_MID_MIN,
} from '~/lib/observability/aggregates';
import {
  PAUSE_TIER_ORDER,
  readPauseTier,
  type PauseTier,
} from '~/lib/conversations/turn-metrics';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/** PostgREST caps a request at 1000 rows; sweep in pages of that size (aggregates.ts precedent). */
const SCAN_PAGE_SIZE = 1000;
const MAX_SCAN_PAGES = 20;

/** Same padding rationale as aggregates.ts: `review_tasks` rows are written during a run. */
const CHILD_WINDOW_PADDING_MS = 60 * 60 * 1000;

/** Bucket label for eval items whose run recorded no routing decision (aggregates.ts precedent). */
const UNROUTED_LABEL = 'unrouted';

export type ConversationQueryWindow = {
  /** ISO timestamp, inclusive. */
  from: string;
  /** ISO timestamp, inclusive. */
  to: string;
};

export type PassRateByAgentDatum = {
  /** `test_result_items.routing_decision`, or `'unrouted'` when the item recorded none. */
  agent: string;
  /** Graded items (status `completed`) for this agent in the window. */
  total: number;
  passed: number;
  /** `passed / total`, rounded to 4 places; null when `total` is 0. */
  passRate: number | null;
};

export type ConfidenceBucket = 'high' | 'mid' | 'low' | 'none';

export type EscalationByConfidenceDatum = {
  bucket: ConfidenceBucket;
  /** Runs in the window whose confidence lands in this bucket. */
  runCount: number;
  /** Of those, runs with at least one `review_tasks` row (distinct runs, never task count). */
  escalatedCount: number;
  /** `escalatedCount / runCount`, rounded to 4 places; null when `runCount` is 0. */
  escalationRate: number | null;
};

export type PauseTierDistributionDatum = {
  tier: PauseTier;
  count: number;
  /** `count / total classified turns`, rounded to 4 places; null when nothing is classified. */
  share: number | null;
};

type TestResultItemScanRow = {
  routing_decision: string | null;
  passed: boolean;
  status: string;
};

type RunConfidenceScanRow = {
  id: string;
  confidence: number | null;
};

type PauseTierScanRow = {
  pause_tier: string | null;
};

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function shiftIso(iso: string, deltaMs: number): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed + deltaMs).toISOString() : iso;
}

/**
 * Paged `created_at`-windowed scan; every query below is this shape. `select` is a PostgREST
 * column list, kept in lockstep with the row type each caller asserts.
 */
async function scanWindow<Row>(
  table: 'test_result_items' | 'workflow_runs' | 'review_tasks' | 'agent_messages',
  select: string,
  window: ConversationQueryWindow,
  refine?: (query: PostgrestScanQuery) => PostgrestScanQuery,
): Promise<Row[]> {
  const supabase = getSupabaseServiceRoleClient();
  const rows: Row[] = [];

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    let query = supabase
      .from(table)
      .select(select)
      .gte('created_at', window.from)
      .lte('created_at', window.to)
      .order('created_at', { ascending: true }) as PostgrestScanQuery;

    if (refine) {
      query = refine(query);
    }

    const { data, error } = await query.range(start, start + SCAN_PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message);
    }

    const batch = (data ?? []) as Row[];
    rows.push(...batch);

    if (batch.length < SCAN_PAGE_SIZE) {
      break;
    }
  }

  return rows;
}

/** The slice of the PostgREST builder `scanWindow` composes; keeps the helper chainable + typed. */
type PostgrestScanQuery = {
  not: (column: string, operator: string, value: unknown) => PostgrestScanQuery;
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
};

/**
 * Pure fold for `getPassRateByAgent`, exported for unit tests. Only `completed` items count:
 * an item that errored before grading has a `passed` default, not a verdict, and counting it
 * would deflate the agent it happened to route to.
 */
export function buildPassRateByAgent(rows: TestResultItemScanRow[]): PassRateByAgentDatum[] {
  const byAgent = new Map<string, { total: number; passed: number }>();

  for (const row of rows) {
    if (row.status !== 'completed') {
      continue;
    }
    const key = row.routing_decision?.trim() || UNROUTED_LABEL;
    const entry = byAgent.get(key) ?? { total: 0, passed: 0 };
    entry.total += 1;
    if (row.passed) {
      entry.passed += 1;
    }
    byAgent.set(key, entry);
  }

  return [...byAgent.entries()]
    .map(([agent, entry]) => ({
      agent,
      total: entry.total,
      passed: entry.passed,
      passRate: entry.total > 0 ? roundTo(entry.passed / entry.total, 4) : null,
    }))
    .sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent));
}

/**
 * Eval pass rate per answering agent over a window, from `test_result_items` — the harness
 * table the aggregate dashboard already reads (see `indexHarnessWorkflowRuns`). Grouped by the
 * stored `routing_decision` (B0-500), i.e. the agent that actually handled the item.
 */
export async function getPassRateByAgent(
  window: ConversationQueryWindow,
): Promise<PassRateByAgentDatum[]> {
  const rows = await scanWindow<TestResultItemScanRow>(
    'test_result_items',
    'routing_decision,passed,status',
    window,
  );
  return buildPassRateByAgent(rows);
}

/**
 * Pure fold for `getEscalationConfidenceCorrelation`, exported for unit tests. Buckets use the
 * exported `aggregates.ts` boundaries so this correlation can never disagree with the dashboard's
 * confidence-bucket chart. `none` (confidence IS NULL) is kept — an escalated run that failed
 * before the validator scored it is signal, not noise.
 */
export function buildEscalationConfidenceCorrelation(
  runs: RunConfidenceScanRow[],
  escalatedRunIds: ReadonlySet<string>,
): EscalationByConfidenceDatum[] {
  const counts: Record<ConfidenceBucket, { runCount: number; escalatedCount: number }> = {
    high: { runCount: 0, escalatedCount: 0 },
    mid: { runCount: 0, escalatedCount: 0 },
    low: { runCount: 0, escalatedCount: 0 },
    none: { runCount: 0, escalatedCount: 0 },
  };

  for (const run of runs) {
    let bucket: ConfidenceBucket;
    if (typeof run.confidence !== 'number' || !Number.isFinite(run.confidence)) {
      bucket = 'none';
    } else if (run.confidence >= CONFIDENCE_HIGH_MIN) {
      bucket = 'high';
    } else if (run.confidence >= CONFIDENCE_MID_MIN) {
      bucket = 'mid';
    } else {
      bucket = 'low';
    }
    counts[bucket].runCount += 1;
    if (escalatedRunIds.has(run.id)) {
      counts[bucket].escalatedCount += 1;
    }
  }

  return (['high', 'mid', 'low', 'none'] as const).map((bucket) => ({
    bucket,
    runCount: counts[bucket].runCount,
    escalatedCount: counts[bucket].escalatedCount,
    escalationRate:
      counts[bucket].runCount > 0
        ? roundTo(counts[bucket].escalatedCount / counts[bucket].runCount, 4)
        : null,
  }));
}

/**
 * Escalation-vs-confidence correlation over a window: per confidence bucket, how often a run
 * grew a `review_tasks` row. Escalations are counted as *distinct runs* (a run with several
 * tasks counts once), matching `countHumanReviewRuns` in `aggregates.ts`. The `review_tasks`
 * scan is padded and intersected on the run-id set, for the same written-during-the-run reason.
 */
export async function getEscalationConfidenceCorrelation(
  window: ConversationQueryWindow,
): Promise<EscalationByConfidenceDatum[]> {
  const runs = await scanWindow<RunConfidenceScanRow>(
    'workflow_runs',
    'id,confidence',
    window,
  );
  const runIds = new Set(runs.map((run) => run.id));

  const escalatedRunIds = new Set<string>();
  if (runIds.size > 0) {
    const taskRows = await scanWindow<{ workflow_run_id: string }>(
      'review_tasks',
      'workflow_run_id',
      {
        from: shiftIso(window.from, -CHILD_WINDOW_PADDING_MS),
        to: shiftIso(window.to, CHILD_WINDOW_PADDING_MS),
      },
    );
    for (const task of taskRows) {
      if (runIds.has(task.workflow_run_id)) {
        escalatedRunIds.add(task.workflow_run_id);
      }
    }
  }

  return buildEscalationConfidenceCorrelation(runs, escalatedRunIds);
}

/**
 * Pure fold for `getPauseTierDistribution`, exported for unit tests. Every tier is seeded so
 * the chart has no gaps; unrecognized stored text (the column is untyped) is dropped via
 * `readPauseTier` rather than invented into a tier.
 */
export function buildPauseTierDistribution(
  rows: PauseTierScanRow[],
): PauseTierDistributionDatum[] {
  const counts = new Map<PauseTier, number>(PAUSE_TIER_ORDER.map((tier) => [tier, 0]));
  let total = 0;

  for (const row of rows) {
    const tier = readPauseTier(row.pause_tier);
    if (!tier) {
      continue;
    }
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
    total += 1;
  }

  return PAUSE_TIER_ORDER.map((tier) => {
    const count = counts.get(tier) ?? 0;
    return {
      tier,
      count,
      share: total > 0 ? roundTo(count / total, 4) : null,
    };
  });
}

/**
 * Distribution of user-pause tiers (B0-531) over a window. Reads only rows the instrumentation
 * has classified (`pause_tier IS NOT NULL` — served by the partial index from the B0-531
 * migration); rows predating B0-532 are unknown, not `instant`, so they are excluded rather than
 * defaulted. Attribution is inherently act-as-aware: the tier was computed within a single
 * conversation at write time.
 */
export async function getPauseTierDistribution(
  window: ConversationQueryWindow,
): Promise<PauseTierDistributionDatum[]> {
  const rows = await scanWindow<PauseTierScanRow>(
    'agent_messages',
    'pause_tier',
    window,
    (query) => query.not('pause_tier', 'is', null),
  );
  return buildPauseTierDistribution(rows);
}
