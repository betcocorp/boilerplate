import rawLabels from './orchestrator-intent-labels.json';

import { SME_AGENT_IDS, type SmeAgentId } from '~/lib/agents/agent-registry';

/**
 * B0-499 — labeled intent-classification eval set for the B0-497 LLM intent classifier
 * initiative. Complements `~/lib/orchestrator/sme-routing.ts`'s keyword router and the narrower
 * `~/lib/recommendations/eval/routing-golden-set.ts` (cross-reference routing only): this set
 * covers all five SME agents plus a deliberate "ambiguous" bucket, for scoring an LLM-based
 * classifier (B0-503/B0-504) and the dual-router path in `run-executor.ts` (B0-501).
 *
 * Data shape: every row is a single realistic Bex chat message with a human-assigned ground-truth
 * `intended_agent` (`SmeAgentId | 'ambiguous'`, matching `routingDecisionSchema` in
 * `~/lib/orchestrator/orchestrator-schemas.ts`). `plausible_agents` lists every agent a reasonable
 * classifier could pick without being "wrong" — for clean-cut cases this is just
 * `[intended_agent]`; for near-miss and ambiguous cases it lists 2+ ids, so scoring code can choose
 * strict (`actual === intended_agent`) or lenient (`plausible_agents.includes(actual)`) grading.
 * All examples are synthetic (`source_style: "synthetic_realistic_b0499"`) — none are transcribed
 * from a real customer message, so there is no PII and nothing here needs the regulated-data
 * transcription rule beyond "don't assert a fabricated regulated value" (a few rows ask about a
 * dilution ratio/dwell time/EPA number without stating one, which is fine).
 */

export type OrchestratorIntentLabel = SmeAgentId | 'ambiguous';

export type OrchestratorIntentConfidence = 'high' | 'medium' | 'low';

export type OrchestratorIntentLabelRow = {
  /** Stable slug, unique within the dataset (e.g. "product-001", "ambiguous-004"). */
  id: string;
  /** The user-facing Bex chat message being classified. */
  message: string;
  /** Ground-truth label a human classifier assigned. */
  intended_agent: OrchestratorIntentLabel;
  /**
   * Every agent id a reasonable classifier could pick without being wrong. Always includes
   * `intended_agent`. Length 1 for clean-cut cases; 2+ for near-miss or ambiguous cases.
   */
  plausible_agents: OrchestratorIntentLabel[];
  /** How confidently a human would assign this label; 'low' clusters in the ambiguous bucket. */
  confidence: OrchestratorIntentConfidence;
  /** One-line rationale for the label, especially load-bearing for near-miss/ambiguous rows. */
  reason: string;
  /** Provenance tag; all rows are currently 'synthetic_realistic_b0499'. */
  source_style: string;
  /** Free-text extra context (empty string when N/A, never omitted, mirrors other training JSON). */
  notes: string;
};

const VALID_LABELS: ReadonlySet<string> = new Set<OrchestratorIntentLabel>([
  ...SME_AGENT_IDS,
  'ambiguous',
]);

function isValidLabel(value: unknown): value is OrchestratorIntentLabel {
  return typeof value === 'string' && VALID_LABELS.has(value);
}

/** Normalizes and validates the raw imported JSON; throws on a malformed row rather than guessing. */
function normalizeOrchestratorIntentLabels(rows: unknown[]): OrchestratorIntentLabelRow[] {
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new Error(`orchestrator-intent-labels.json row ${index} is not an object`);
    }
    const r = row as Record<string, unknown>;

    if (typeof r.id !== 'string' || !r.id.trim()) {
      throw new Error(`orchestrator-intent-labels.json row ${index} is missing a string "id"`);
    }
    if (typeof r.message !== 'string' || !r.message.trim()) {
      throw new Error(`orchestrator-intent-labels.json row "${r.id}" is missing a string "message"`);
    }
    if (!isValidLabel(r.intended_agent)) {
      throw new Error(
        `orchestrator-intent-labels.json row "${r.id}" has an invalid intended_agent: ${String(r.intended_agent)}`,
      );
    }
    const plausible = Array.isArray(r.plausible_agents) ? r.plausible_agents : [];
    const plausibleAgents = plausible.filter(isValidLabel);
    if (!plausibleAgents.includes(r.intended_agent)) {
      plausibleAgents.push(r.intended_agent);
    }

    return {
      id: r.id,
      message: r.message,
      intended_agent: r.intended_agent,
      plausible_agents: plausibleAgents,
      confidence:
        r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low'
          ? r.confidence
          : 'medium',
      reason: typeof r.reason === 'string' ? r.reason : '',
      source_style: typeof r.source_style === 'string' ? r.source_style : '',
      notes: typeof r.notes === 'string' ? r.notes : '',
    };
  });
}

export const ORCHESTRATOR_INTENT_LABELS: OrchestratorIntentLabelRow[] =
  normalizeOrchestratorIntentLabels(rawLabels as unknown[]);

/** Labeled rows grouped by ground-truth `intended_agent` (stable for per-category metrics). */
export function orchestratorIntentLabelsByAgent(): Map<
  OrchestratorIntentLabel,
  OrchestratorIntentLabelRow[]
> {
  const map = new Map<OrchestratorIntentLabel, OrchestratorIntentLabelRow[]>();
  for (const row of ORCHESTRATOR_INTENT_LABELS) {
    const list = map.get(row.intended_agent) ?? [];
    list.push(row);
    map.set(row.intended_agent, list);
  }
  return map;
}

/**
 * B0-652 — join key for matching an eval result row back to its golden-set label. The harness
 * persists a test item's PROMPT, not this dataset's `id`, so the prompt text is the only link
 * available; normalizing case and internal whitespace keeps a round-trip through CSV import/export
 * (which can re-wrap or pad a cell) from silently losing the label.
 */
function normalizeMessageKey(message: string): string {
  return message.trim().replace(/\s+/g, ' ').toLowerCase();
}

const labelsByMessage: Map<string, OrchestratorIntentLabelRow> = new Map(
  ORCHESTRATOR_INTENT_LABELS.map((row) => [normalizeMessageKey(row.message), row]),
);

/** The golden-set row whose message matches `message`, or null when it isn't from this dataset. */
export function findOrchestratorIntentLabelByMessage(
  message: string,
): OrchestratorIntentLabelRow | null {
  return labelsByMessage.get(normalizeMessageKey(message)) ?? null;
}

/**
 * Every agent a reasonable classifier could pick for `message` without being wrong — the input to
 * lenient grading. Returns null (not `[]`) for a prompt that isn't in the golden set, so a caller
 * can tell "no lenient grading available" apart from "nothing is plausible".
 */
export function plausibleAgentsForMessage(message: string): OrchestratorIntentLabel[] | null {
  return findOrchestratorIntentLabelByMessage(message)?.plausible_agents ?? null;
}

export type OrchestratorIntentLabelSummary = {
  total: number;
  byAgent: Record<string, number>;
  byConfidence: Record<OrchestratorIntentConfidence, number>;
  ambiguousCount: number;
};

export function summarizeOrchestratorIntentLabels(): OrchestratorIntentLabelSummary {
  const byAgent: Record<string, number> = {};
  const byConfidence: Record<OrchestratorIntentConfidence, number> = {
    high: 0,
    medium: 0,
    low: 0,
  };
  let ambiguousCount = 0;

  for (const row of ORCHESTRATOR_INTENT_LABELS) {
    byAgent[row.intended_agent] = (byAgent[row.intended_agent] ?? 0) + 1;
    byConfidence[row.confidence] += 1;
    if (row.intended_agent === 'ambiguous') {
      ambiguousCount += 1;
    }
  }

  return {
    total: ORCHESTRATOR_INTENT_LABELS.length,
    byAgent,
    byConfidence,
    ambiguousCount,
  };
}
