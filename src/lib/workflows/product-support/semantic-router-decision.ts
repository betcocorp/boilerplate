import type { BexChatAgentMode } from '~/lib/agents/agent-registry';
import type { IntentValue } from '~/lib/orchestrator/intent-classifier';
import type { SemanticRouteDecision } from '~/lib/orchestrator/semantic-router';
import { logInfo, logWarn } from '~/lib/observability/logger';
import { getBooleanSetting } from '~/lib/settings/settings-service';
import type { GateRecord } from '~/lib/workflows/product-support/product-support-schemas';

/**
 * B0-649 / B0-651 / B0-653 — the workflow-side half of the semantic-router rollout.
 *
 * `~/lib/orchestrator/semantic-router` owns the router itself (embedding, scoring, thresholds, and
 * the `SEMANTIC_ROUTER_*` threshold settings). This module owns everything the PRODUCT-SUPPORT
 * WORKFLOW needs in order to roll it out safely:
 *
 *  - the two rollout flags (`BEX_SEMANTIC_ROUTER_ENABLED`, `BEX_SEMANTIC_ROUTER_SHADOW_MODE`),
 *    deliberately mirroring the `BEX_LLM_ROUTER_ENABLED` / `BEX_LLM_ROUTER_SHADOW_MODE` pair that
 *    `~/lib/orchestrator/intent-classifier.ts` already exposes for the B0-497/B0-511 cutover;
 *  - the three-state precedence that decides WHICH router routes a turn (`resolveSemanticRouterMode`
 *    + `resolveSemanticRoute`);
 *  - the persisted `GateRecord` and the structured log line that make a semantic routing decision
 *    explainable after the fact.
 *
 * The flags live here rather than next to the router because they are integration policy, not
 * router configuration: the router is callable (and unit-testable) with the flags off.
 */

export const SEMANTIC_ROUTER_ENABLED_SETTING_KEY = 'BEX_SEMANTIC_ROUTER_ENABLED';
export const SEMANTIC_ROUTER_SHADOW_MODE_SETTING_KEY = 'BEX_SEMANTIC_ROUTER_SHADOW_MODE';

/**
 * Master switch, default OFF. Unlike `isLlmRouterEnabled()` — which inverted to default-on AFTER
 * its cutover (B0-511) — this one stays default-off until the B0-653 rollout completes, so an
 * un-configured environment (including production) keeps today's LLM-classifier routing verbatim.
 */
export async function isSemanticRouterEnabled(): Promise<boolean> {
  return getBooleanSetting(SEMANTIC_ROUTER_ENABLED_SETTING_KEY, false);
}

/**
 * Default OFF. When ON (together with the flag above) the semantic router runs on every
 * orchestrator turn and is fully logged, but the LLM classifier / keyword router still DECIDES —
 * the same "land it as log-and-compare first" posture B0-507 used for the LLM classifier.
 */
export async function isSemanticRouterShadowMode(): Promise<boolean> {
  return getBooleanSetting(SEMANTIC_ROUTER_SHADOW_MODE_SETTING_KEY, false);
}

/**
 * B0-649 — the three rollout states, in precedence order:
 *
 *  - `'live'`   (enabled && !shadow)  the semantic router decides this turn. When it returns
 *    `path: 'fallback'` (embedding failure, thresholds not met, empty message) the turn degrades to
 *    the PRE-EXISTING behaviour — the LLM classifier if it is itself enabled, else the keyword
 *    router's agent, else `'ambiguous'` — rather than dropping straight to `'ambiguous'`. That
 *    preserves today's safety net instead of trading it for a new one.
 *  - `'shadow'` (enabled && shadow)   the semantic router runs for logging/comparison only.
 *  - `'off'`    (!enabled)            byte-identical to the pre-B0-649 code path; the router is
 *    never called, so no embedding round-trip is ever paid.
 *
 * A forced direct `agentMode` (an admin picking a specialist in the Bex UI) bypasses routing
 * entirely and therefore also bypasses the semantic router — exactly as it already bypasses both
 * the keyword router and the LLM classifier.
 */
export type SemanticRouterMode = 'off' | 'shadow' | 'live';

export function resolveSemanticRouterMode(input: {
  enabled: boolean;
  shadowMode: boolean;
  agentMode: BexChatAgentMode;
}): SemanticRouterMode {
  if (input.agentMode !== 'orchestrator' || !input.enabled) {
    return 'off';
  }
  return input.shadowMode ? 'shadow' : 'live';
}

/**
 * The route the semantic router ACTUALLY imposed on this turn, or `null` when it did not decide
 * (mode `off`/`shadow`, the router was never called, or it degraded to `path: 'fallback'`).
 *
 * `null` is the signal the workflow uses to decide whether to spend an LLM classifier call at all:
 * a non-null result here means `classifyUserIntent` is never invoked (the B0-653 AC), while a
 * `null` on a `'live'` fallback deliberately lets the old classifier chain run as the safety net.
 */
export function resolveSemanticRoute(
  mode: SemanticRouterMode,
  decision: SemanticRouteDecision | null,
): IntentValue | null {
  if (mode !== 'live' || !decision || decision.path !== 'semantic') {
    return null;
  }
  return decision.route;
}

/** One sentence for `orchestration_planner.routing.rationale`, so a trace reader sees WHY. */
export function semanticRouterRationale(decision: SemanticRouteDecision): string {
  return (
    `Semantic router (${decision.embeddingModel}, examples ${decision.examplesVersion}) routed to ` +
    `"${decision.route}" — confidence ${decision.confidence}, similarity ${decision.similarity}, ` +
    `margin ${decision.margin}, path ${decision.path}, ${decision.latencyMs}ms ` +
    `(embedding ${decision.embeddingMs}ms + scoring ${decision.scoringMs}ms).`
  );
}

/**
 * B0-649 — the resolved semantic-router switches this run observed, folded into the run's
 * `runtimeConfig` snapshot. Every field is optional on `runtimeConfigSchema` (see the schema
 * comment): a run persisted before this ticket has none of them, and must keep parsing.
 */
export function semanticRouterRuntimeConfigFields(input: {
  mode: SemanticRouterMode;
  enabled: boolean;
  shadowMode: boolean;
  decision: SemanticRouteDecision | null;
  decidedRoute: IntentValue | null;
}): {
  semanticRouterEnabled: boolean;
  semanticRouterShadowMode: boolean;
  semanticRouterPath: string | null;
  semanticRouterDecided: boolean;
} {
  return {
    semanticRouterEnabled: input.enabled,
    semanticRouterShadowMode: input.shadowMode,
    // Null (not `'fallback'`) when the router never ran — "was not called" and "was called and
    // degraded" are different facts and the rollout dashboard must not conflate them.
    semanticRouterPath: input.mode === 'off' ? null : (input.decision?.path ?? null),
    semanticRouterDecided: input.decidedRoute !== null,
  };
}

/**
 * B0-651 — the persisted, queryable record of one semantic routing decision, written onto the
 * `orchestration_planner` step. Carries every field the ticket asks to be observable: the chosen
 * route, per-route similarity scores, confidence, margin, which threshold passed, the path taken,
 * and the latency split.
 *
 * Two gate ids, not one, so an operator can separate rollout stages with a `gate =` filter rather
 * than by re-deriving the flag state from `runtimeConfig`:
 *  - `semantic_router_live`   — the router decided this turn (or degraded while live).
 *  - `semantic_router_shadow` — comparison only; another router decided.
 */
export function buildSemanticRouterGate(input: {
  mode: Exclude<SemanticRouterMode, 'off'>;
  decision: SemanticRouteDecision;
  /** The route this turn actually ran, whoever chose it. */
  routingDecision: string;
  /** Where the turn's route came from once precedence resolved — for the `effect` sentence. */
  decidedBy: 'semantic_router' | 'llm_classifier' | 'keyword_router' | 'ambiguous_fallback';
}): GateRecord {
  const { decision } = input;
  const agrees = decision.route === input.routingDecision;

  return {
    gate: input.mode === 'live' ? 'semantic_router_live' : 'semantic_router_shadow',
    inputs: {
      semanticRoute: decision.route,
      semanticConfidence: decision.confidence,
      semanticSimilarity: decision.similarity,
      semanticMargin: decision.margin,
      semanticPath: decision.path,
      /** Similarity for EVERY candidate route, not just the winner (B0-651 AC). */
      semanticScores: decision.scores.map((score) => ({
        route: score.route,
        similarity: score.similarity,
      })),
      semanticLatencyMs: decision.latencyMs,
      semanticEmbeddingMs: decision.embeddingMs,
      semanticScoringMs: decision.scoringMs,
      semanticEmbeddingModel: decision.embeddingModel,
      semanticExamplesVersion: decision.examplesVersion,
      semanticError: decision.error,
      /** What the turn actually ran, so agreement is computable without a second scan. */
      routingDecision: input.routingDecision,
      decidedBy: input.decidedBy,
    },
    thresholds: {
      confidenceThreshold: decision.thresholds.confidence,
      marginThreshold: decision.thresholds.margin,
      confidenceThresholdPassed: decision.thresholdsPassed.confidence,
      marginThresholdPassed: decision.thresholdsPassed.margin,
      mode: input.mode,
    },
    verdict:
      decision.path === 'fallback'
        ? 'fell_back'
        : agrees
          ? 'agrees_with_routing_decision'
          : 'disagrees_with_routing_decision',
    effect:
      input.mode === 'live'
        ? decision.path === 'semantic'
          ? `Semantic router decided this turn: routed to "${decision.route}" (confidence ${decision.confidence}, margin ${decision.margin}, ${decision.latencyMs}ms = ${decision.embeddingMs}ms embedding + ${decision.scoringMs}ms scoring). The LLM intent classifier was not called.`
          : `Semantic router DEGRADED (${decision.error ?? 'thresholds not met'}); routing fell back to the ${input.decidedBy.replace(/_/g, ' ')}, which chose "${input.routingDecision}".`
        : `Shadow mode only: the semantic router proposed "${decision.route}" (confidence ${decision.confidence}, path ${decision.path}, ${decision.latencyMs}ms) while the ${input.decidedBy.replace(/_/g, ' ')} actually routed this turn to "${input.routingDecision}". Not used to route this turn.`,
  };
}

/** The one structured-log event name every semantic routing decision is emitted under (B0-651). */
export const SEMANTIC_ROUTER_DECISION_LOG_EVENT = 'semantic_router_decision';

/**
 * B0-651 — emit one structured log line per semantic routing decision.
 *
 * There is no Prometheus/StatsD/OTel exporter in this app (see `~/lib/observability/logger.ts`):
 * observability here is structured logs plus persisted Supabase rows. The five "metrics" the ticket
 * names are therefore implemented as query-time reducers over the persisted gate records in
 * `~/lib/observability/routing-health.ts`; this log line is the real-time counterpart, carrying the
 * identical field set so a log search and the dashboard cannot disagree.
 *
 * `logWarn` (not `logInfo`) on the fallback path: a fallback is the single number the B0-653
 * rollout aborts on, so it must be greppable at warn level without a payload filter.
 */
export function logSemanticRouterDecision(input: {
  mode: Exclude<SemanticRouterMode, 'off'>;
  decision: SemanticRouteDecision;
  routingDecision: string;
  decidedBy: 'semantic_router' | 'llm_classifier' | 'keyword_router' | 'ambiguous_fallback';
  traceId: string;
  conversationId: string;
}): void {
  const { decision } = input;
  const fields = {
    traceId: input.traceId,
    conversationId: input.conversationId,
    mode: input.mode,
    route: decision.route,
    path: decision.path,
    confidence: decision.confidence,
    similarity: decision.similarity,
    margin: decision.margin,
    confidenceThreshold: decision.thresholds.confidence,
    marginThreshold: decision.thresholds.margin,
    confidenceThresholdPassed: decision.thresholdsPassed.confidence,
    marginThresholdPassed: decision.thresholdsPassed.margin,
    // Every candidate's similarity, as `{ route: similarity }` — one flat object so a log query
    // can read a single route's score without indexing into an array.
    scores: Object.fromEntries(decision.scores.map((score) => [score.route, score.similarity])),
    latencyMs: decision.latencyMs,
    embeddingMs: decision.embeddingMs,
    scoringMs: decision.scoringMs,
    embeddingModel: decision.embeddingModel,
    examplesVersion: decision.examplesVersion,
    error: decision.error,
    routingDecision: input.routingDecision,
    decidedBy: input.decidedBy,
  };

  if (decision.path === 'fallback') {
    logWarn(SEMANTIC_ROUTER_DECISION_LOG_EVENT, fields);
    return;
  }
  logInfo(SEMANTIC_ROUTER_DECISION_LOG_EVENT, fields);
}
