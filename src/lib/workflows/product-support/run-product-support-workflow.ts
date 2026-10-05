import { getErrorMessage } from '~/lib/utils';
import { APP_VERSION } from '~/lib/app-version';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  resolveMaxOutputTokens,
} from '~/lib/workflows/product-support/max-output-tokens';
import { createAuditLogQueue } from '~/lib/audit/audit-log-queue';
import type { ProductLineLock, ToolCallOrigin, ToolTraceEntry } from '~/lib/audit/trace';
import type {
  RegulatedClaimCategory,
  RegulatedClaimGroundingResult,
} from '~/lib/workflows/product-support/validator';
// B0-928 — the guardrail's redaction/decline copy lives in one module the grader can import
// without the workflow stack; re-exported below so existing importers are unaffected.
import {
  buildRegulatedClaimDeclineCopy,
  buildRegulatedClaimSentenceRedactionFooter,
  buildRegulatedClaimTokenRedactionFooter,
  countSubstantiveContentChars,
  mergeRepeatedRegulatedClaimWithheldMarkers,
  REGULATED_CLAIM_CATEGORY_LABELS,
  REGULATED_CLAIM_GOVERNING_RULES,
  REGULATED_CLAIM_REDACTION_MIN_REMAINING_CHARS,
  regulatedClaimWithheldMarker,
  stripRegulatedClaimWithheldMarkers,
} from '~/lib/workflows/product-support/regulated-claim-redaction-copy';
import {
  DEFAULT_BEX_CHAT_AGENT_MODE,
  type BexChatAgentMode,
} from '~/lib/agents/agent-registry';
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
import { resolveModel } from '~/lib/llm/resolve-model';
import type { FactToolEnforcementOutcome, LlmTokenUsage } from '~/lib/llm/generation-shared';
import {
  isFactToolEnforcementEnabled,
  requireFactToolForDraft,
} from '~/lib/workflows/product-support/fact-tool-enforcement';
import { requireFloorProcedureTool } from '~/lib/workflows/product-support/floor-procedure-backstop';
import { applyFloorRecoatRationaleBackstop } from '~/lib/workflows/product-support/floor-recoat-rationale-backstop';
import { applyDilutionDwellBackstop } from '~/lib/workflows/product-support/dilution-dwell-backstop';
import { applyProductPageUrlCitationBackstop } from '~/lib/workflows/product-support/product-page-url-citation-backstop';
import { runAiSdkWithToolLoop } from '~/lib/bex/ai-sdk-runtime';
import {
  hasDecisiveCrossReferenceSignal,
  routeUserMessageToSme,
  SME_ROUTE_MIN_HITS_TO_ROUTE,
  SME_ROUTE_TIE_BREAK_ORDER,
} from '~/lib/orchestrator/sme-routing';
import {
  classifyUserIntent,
  isLlmRouterEnabled,
  isLlmRouterShadowMode,
  resolveRouterModel,
  resolveRouterTimeoutMs,
  type IntentClassification,
  type IntentValue,
  type PriorTurnMessage,
} from '~/lib/orchestrator/intent-classifier';
import {
  classifyUserIntentSemantic,
  type SemanticRouteDecision,
} from '~/lib/orchestrator/semantic-router';
import {
  analyzeTurnSignals,
  competitorIdentityFromSignals,
  isSignalsAnalysisEnabled,
  toIntentClassification,
} from '~/lib/orchestrator/signals/analyze-turn-signals';
import { buildSignalQueryRewrite } from '~/lib/orchestrator/signals/signal-query-rewrite';
import type { DeclineClass, TurnSignals } from '~/lib/orchestrator/signals/signals-schemas';
import { hasNamedSurfaceContext } from '~/lib/orchestrator/surface-vocabulary';
import {
  CATEGORY_MISMATCH_CONFIDENCE_CAP,
  evaluateRecommendationGate,
  LOW_SIMILARITY_CONFIDENCE_CAP,
  LOW_SIMILARITY_THRESHOLD,
  MISSING_BRAND_CONFIDENCE_CAP,
} from '~/lib/recommendations/recommendation-gate';
import {
  isConfidenceGatingDisabled,
  isRecommendationConfidenceGatingDisabled,
  XREF_DECLINE_COPY,
} from '~/lib/recommendations/confidence-scoring';
import {
  extractCompetitorProduct,
  isCompetitorIdentityUnresolved,
  type ExtractedCompetitor,
} from '~/lib/recommendations/extract-competitor-product';
import {
  classifyCompetitorSelfReference,
  isConversionListAsk,
  type CompetitorSelfReferenceVerdict,
} from '~/lib/recommendations/competitor-self-reference';
import {
  buildCompetitorIdentityClarification,
  buildGenericChemistryClarification,
  buildRecommendationEngineDeclineCopy,
} from '~/lib/recommendations/cross-reference-decline';
import { matchBetcoProductName } from '~/lib/rag/betco-product-name';
import { resolveProductEntityByName } from '~/lib/rag/entity-context';
import type { ProductEntityResolutionSource } from '~/lib/rag/entity-context';
import { runCrossReferenceRecommendation } from '~/lib/recommendations/persist-recommendation';
import { loadXrefLatencyPolicy } from '~/lib/recommendations/recommend-cross-reference';
import {
  evaluateRecommendationEngineGate,
  parseRecommendationEngineOutput,
  type RecommendationEngineOutcome,
} from '~/lib/recommendations/recommendation-engine-gate';
import {
  decideXrefBackstop,
  RECOMMEND_CROSS_REFERENCE_TOOL,
  resolveXrefBackstopPolicy,
  XREF_BACKSTOP_MIN_BUDGET_MS,
} from '~/lib/recommendations/xref-backstop';
import { buildWebFallbackAnswer } from '~/lib/recommendations/web-fallback-answer';
import {
  lookupCrossReference,
  fetchRecommendationContext,
} from '~/lib/tools/cross-reference-lookup';
import { buildCompetitiveRecommendationAnswer } from '~/lib/recommendations/recommendation-answer';
import { productSupportToolsForRoute } from '~/lib/tools/definitions';
import { buildToolTraceEntry, executeToolCall } from '~/lib/tools/execute-tool-call';
import type { ProductToolTurnOptions } from '~/lib/tools/product-tools';
import { asRagDocumentKind } from '~/lib/rag/document-kind';
import { assembleDocumentBodies } from '~/lib/retrieval/document-assembly';
import { getBooleanSetting } from '~/lib/settings/settings-service';

import type { Json } from '~/types/supabase.public';

import {
  buildProductSupportInstructions,
  buildProductSupportPromptCacheKey,
  effectivePromptIdForDecision,
  VALIDATOR_SYSTEM_PROMPT,
} from '~/lib/workflows/product-support/product-support-prompts';
import {
  appendCategoryListEvidence,
  buildCategoryListArgumentsJson,
  buildCategoryListCallId,
  buildPreloadedEvidence,
  buildSpeculativeCallId,
  CATEGORY_LIST_TOOL_NAME,
  classifySpeculativeRetrievalSkip,
  createSpeculativeReuseExecutor,
  looksLikeCategoryListOrSuperlativeAsk,
  looksLikeExactEfficacyQuestion,
  runSpeculativeRetrieval,
} from '~/lib/workflows/product-support/speculative-retrieval';
import { detectCategorySearchTerms } from '~/lib/tools/category-search-terms';
import {
  compareIdentityNameToTitle,
  extractIdentityAskName,
} from '~/lib/workflows/product-support/identity-title-match';
import {
  buildComparisonPreloadedEvidence,
  resolveComparisonEntities,
  runComparisonRetrieval,
} from '~/lib/workflows/product-support/comparison-retrieval';
import {
  createAgentConfidenceStreamFilter,
  extractAgentSelfConfidence,
  NO_MODEL_CALL_AGENT_CONFIDENCE,
} from '~/lib/workflows/product-support/agent-self-confidence';
import {
  applyConfidenceCap,
  confidenceProvenanceFields,
  type ConfidenceProvenanceState,
} from '~/lib/workflows/product-support/confidence-provenance';
import { PRODUCT_SUPPORT_RERANK_ENABLED } from '~/lib/retrieval/product-knowledge';
import { isRerankerConfigured } from '~/lib/rag/rerank';
import type {
  GateActivationRecord,
  RuntimeConfig,
} from '~/lib/workflows/product-support/product-support-schemas';
import {
  gateRecordSchema,
  promptRecordSchema,
  type AnswerProvenance,
  type GateRecord,
  type PromptRecord,
  type ProductSupportFinalOutput,
  type RetrievalCallRecord,
  type RetrievalConfigSummary,
  type RetrievedDocumentChunkRef,
  type ValidatorMode,
  type ValidatorResult,
} from '~/lib/workflows/product-support/product-support-schemas';
import {
  computePromptVersion,
  PROMPT_BUNDLE_VERSION,
} from '~/lib/workflows/product-support/prompt-version';
import {
  buildSemanticRouterGate,
  isSemanticRouterEnabled,
  isSemanticRouterShadowMode,
  logSemanticRouterDecision,
  resolveSemanticRoute,
  resolveSemanticRouterMode,
  semanticRouterRationale,
  semanticRouterRuntimeConfigFields,
} from '~/lib/workflows/product-support/semantic-router-decision';
import {
  evaluateRegulatedClaimGrounding,
  evaluateVerifiedFactsDilutionCitation,
  extractVerifiedFactsCitationKeys,
  isOnlyRegulatedClaimIssues,
  isRevisionSkipForRegulatedClaimOnlyEnabled,
  REGULATED_CLAIM_SENTENCE_BOUNDARY_SOURCE,
  resolveRevisionModel,
  resolveValidatorModel,
  REVISION_SYSTEM_PROMPT,
  runRevisionPass,
  runValidatorPass,
} from '~/lib/workflows/product-support/validator';
import {
  fetchFactsForCitationKeys,
  fetchFactsForProductLineKeys,
} from '~/lib/retrieval/product-facts';

import type { RunSource } from '~/types/observability';

/**
 * B0-681 — per-run routing override for the "Run dataset" workbench (`/admin/tests/[testId]`),
 * mirroring the router types the `/admin/routing-test` tool already exercises. When set, the turn
 * is forced onto exactly that router — no silent cross-router fallback: a forced `semantic`/`llm`
 * that degrades falls straight to the keyword router's `route.agent ?? 'ambiguous'`, the same
 * floor every route already has, rather than chaining into the OTHER router's live settings. This
 * keeps a chosen-router test run interpretable (the grade reflects the router picked, not whatever
 * the `settings` table happens to say today). `undefined` is the pre-existing behavior: the
 * `settings`-driven semantic/LLM rollout levers decide, unchanged.
 */
export type RouterTypeOverride = 'keyword' | 'semantic' | 'llm';

const VALIDATOR_EVIDENCE_CHAR_BUDGET = 60_000;
const VALIDATOR_PER_DOCUMENT_CHAR_BUDGET = 24_000;

/**
 * B0-363 — bounds for the diagnostic fields added to `tool_failed` audit rows.
 * `audit_logs.payload` is scanned in bulk by the observability dashboards, so the
 * failure cause is stored bounded rather than whole; the full (already truncated)
 * previews still live on the agent step's persisted `toolTrace` (B0-331).
 */
const TOOL_FAILURE_ERROR_MESSAGE_MAX_CHARS = 1_024;
const TOOL_FAILURE_ARGUMENTS_PREVIEW_MAX_CHARS = 512;

function truncateForAudit(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…[truncated]`;
}

/**
 * B0-363 — `executeToolCall` serializes every failure as `{"ok":false,"error":"…"}`
 * into `trace.outputPreview`. A Zod `.parse` rejection on the tool arguments and a
 * downstream retrieval/embedding throw both land there — exactly the pair that was
 * previously indistinguishable from the audit row alone. Pull the message back out;
 * fall back to the raw preview when it is not that shape.
 */
export function extractToolFailureMessage(outputPreview: string): string | null {
  const trimmed = outputPreview.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const error = (parsed as Record<string, unknown>).error;
      if (typeof error === 'string' && error.trim()) {
        return truncateForAudit(error.trim(), TOOL_FAILURE_ERROR_MESSAGE_MAX_CHARS);
      }
    }
  } catch {
    // Not JSON (or truncated mid-object) — fall through to the raw preview.
  }

  return truncateForAudit(trimmed, TOOL_FAILURE_ERROR_MESSAGE_MAX_CHARS);
}

/**
 * B0-363 — payload for the `tool_succeeded` / `tool_failed` audit row.
 *
 * Success rows are deliberately UNCHANGED: the arguments are already persisted on
 * the agent step's `toolTrace`, so duplicating them per successful call would bloat
 * `audit_logs` for no diagnostic gain. Failure rows carry the error message plus a
 * bounded arguments preview, which is what makes a failure root-causable without
 * the toolTrace (absent on every run predating its 2026-08-03 rollout).
 */
export function buildToolCallAuditPayload(
  trace: Pick<ToolTraceEntry, 'toolName' | 'callId' | 'ok' | 'outputPreview' | 'argumentsPreview'>,
): Record<string, unknown> {
  const base = { tool_name: trace.toolName, call_id: trace.callId };
  if (trace.ok) {
    return base;
  }
  return {
    ...base,
    error_message: extractToolFailureMessage(trace.outputPreview),
    arguments_preview: truncateForAudit(
      trace.argumentsPreview,
      TOOL_FAILURE_ARGUMENTS_PREVIEW_MAX_CHARS,
    ),
  };
}

/**
 * B0-885 — the validator's LLM pass (and the revision pass that shares this summary) must see the
 * SAME evidence window the generator actually read, not the ~900-char retrieval-preview `snippet`
 * (`~/lib/tools/product-tools.ts`). A grounded draft was being rejected as "not supported by the
 * evidence" and rewritten thinner purely because the validator's evidence was thinner than the
 * generator's. `documentBody` (the matched-chunk-plus-neighbours window from B0-547) is preferred
 * for every source; `snippet` is now only a last-resort fallback when `documentBody` is empty.
 *
 * `fullDocumentBodies`, when passed, is the SAME map the B0-257 regulated-claim guardrail builds
 * via `assembleDocumentBodies` (re-fetched whole documents, keyed by document id) — reusing it here
 * means the validator grounds against exactly what the guardrail grounds against, still bounded by
 * the existing 60k/24k budgets below (this can legitimately reach those budgets now, unlike the
 * pre-B0-885 snippet-only input which almost never did). Sources are read in as-retrieved
 * (top-ranked-first) order so budget truncation drops the WEAKEST source, not the strongest.
 */
export function buildEvidenceSummary(
  sources: RetrievedSourceMeta[],
  fullDocumentBodies?: Map<string, { body: string }>,
): string {
  if (sources.length === 0) {
    return '(no retrieved documents)';
  }

  const segments: string[] = [];
  let total = 0;

  for (const source of sources) {
    const preferredBody = fullDocumentBodies?.get(source.documentId)?.body ?? source.documentBody;
    const body =
      (preferredBody && preferredBody.length > 0 ? preferredBody : source.snippet) ?? '';
    const trimmed = body.slice(0, VALIDATOR_PER_DOCUMENT_CHAR_BUDGET);
    const truncatedSuffix =
      body.length > trimmed.length ? '\n…(truncated for evidence summary)' : '';
    // B0-257: surface the raw source location alongside the doc id/title so the validator
    // (and any human reviewing a raised review task) can trace a regulated claim back to
    // the exact label/SDS file it was quoted from.
    const sourceLine = source.s3Key || source.sourceUri
      ? ` (source: ${source.sourceUri ?? source.s3Key})`
      : '';
    const block = `[${source.documentId}] ${source.title}${sourceLine}\n${trimmed}${truncatedSuffix}`;

    if (total + block.length > VALIDATOR_EVIDENCE_CHAR_BUDGET) {
      const remaining = Math.max(0, VALIDATOR_EVIDENCE_CHAR_BUDGET - total);
      if (remaining > 0) {
        segments.push(`${block.slice(0, remaining - 1)}…`);
      }
      break;
    }

    segments.push(block);
    total += block.length + 5; // separator allowance
  }

  return segments.join('\n\n---\n\n');
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

/**
 * B0-490 — raw vs. post-selection top retrieval similarity, rolled up across every successful
 * search-backed tool call this turn made. `rawTopSimilarity` is the max over each call's winning
 * search pass BEFORE `selectCuratedMatches` filtered/deduped/truncated it — the score
 * `evaluateRecommendationGate`'s `LOW_SIMILARITY_THRESHOLD` was actually calibrated against.
 * `selectedTopSimilarity` is the max over what actually survived into `sources[]`. Both are null
 * when no tool call this turn carried a `retrieval` block (e.g. a pure cross-reference lookup with
 * no RAG search). Pure function of the tool output log — no I/O — so it is unit-testable in
 * isolation from the workflow's DB/OpenAI dependencies.
 */
export function extractSimilarityRollupFromToolOutputs(toolOutputs: RuntimeToolOutput[]): {
  rawTopSimilarity: number | null;
  selectedTopSimilarity: number | null;
  droppedByFilterCount: number | null;
} {
  let rawTopSimilarity: number | null = null;
  let selectedTopSimilarity: number | null = null;
  let droppedByFilterCount: number | null = null;

  for (const entry of toolOutputs) {
    if (!entry.ok) {
      continue;
    }
    try {
      const payload = JSON.parse(entry.output) as {
        retrieval?: {
          rawTopSimilarity?: unknown;
          selectedTopSimilarity?: unknown;
          droppedByFilterCount?: unknown;
        };
      };
      const retrieval = payload.retrieval;
      if (!retrieval || typeof retrieval !== 'object' || Array.isArray(retrieval)) {
        continue;
      }

      if (typeof retrieval.rawTopSimilarity === 'number') {
        rawTopSimilarity =
          rawTopSimilarity === null
            ? retrieval.rawTopSimilarity
            : Math.max(rawTopSimilarity, retrieval.rawTopSimilarity);
      }
      if (typeof retrieval.selectedTopSimilarity === 'number') {
        selectedTopSimilarity =
          selectedTopSimilarity === null
            ? retrieval.selectedTopSimilarity
            : Math.max(selectedTopSimilarity, retrieval.selectedTopSimilarity);
      }
      if (typeof retrieval.droppedByFilterCount === 'number') {
        droppedByFilterCount = (droppedByFilterCount ?? 0) + retrieval.droppedByFilterCount;
      }
    } catch {
      // Ignore malformed output and continue scanning.
    }
  }

  return { rawTopSimilarity, selectedTopSimilarity, droppedByFilterCount };
}

/**
 * B0-493 — rolls every search-backed tool call's persisted `ToolTraceEntry.retrieval` up to one
 * run-level record: a field carries the agreed value when every search call this turn agreed, or
 * is null AND listed in `mixed` when calls disagreed. Reads the STRUCTURED `trace.retrieval` field
 * (built from the full untruncated payload at `executeToolCall` time), not the tool output string,
 * so truncation of a large `sources[]` array never loses this data. Pure function of the resolved
 * tool trace — no I/O — so it is unit-testable in isolation.
 */
export function extractRetrievalConfigFromToolTrace(
  toolTrace: readonly ToolTraceEntry[],
): RetrievalConfigSummary {
  const embeddingModel = new Set<string>();
  const retrievalStrategy = new Set<string>();
  const embeddingSource = new Set<string>();
  const scope = new Set<string>();
  const minSimilarity = new Set<number>();

  for (const entry of toolTrace) {
    const retrieval = entry.retrieval;
    if (!retrieval) {
      continue;
    }
    embeddingModel.add(retrieval.model);
    retrievalStrategy.add(retrieval.retrievalStrategy);
    embeddingSource.add(retrieval.embeddingSource);
    scope.add(retrieval.scope);
    minSimilarity.add(retrieval.selection.minSimilarity);
  }

  const mixed: RetrievalConfigSummary['mixed'] = [];

  /** Single value when every search call agreed; null (and flagged in `mixed`) when they disagreed. */
  function resolve<T>(field: RetrievalConfigSummary['mixed'][number], values: Set<T>): T | null {
    if (values.size === 0) {
      return null;
    }
    if (values.size > 1) {
      mixed.push(field);
      return null;
    }
    return [...values][0]!;
  }

  return {
    embeddingModel: resolve('embeddingModel', embeddingModel),
    retrievalStrategy: resolve('retrievalStrategy', retrievalStrategy),
    embeddingSource: resolve('embeddingSource', embeddingSource),
    scope: resolve('scope', scope),
    minSimilarity: resolve('minSimilarity', minSimilarity),
    mixed,
  };
}

/**
 * B0-619 — sum of `retrieval.timings.rerankMs` across every search-backed tool call this turn
 * (mirrors the `searchMsTotal` summation `ragQueryForProductKnowledgeWithMeta` already does
 * per-call, just rolled up to run level). Null when no search tool ran this turn; zero is a real,
 * distinct value (every search ran with reranking inactive) and must not be conflated with "no
 * search ran" the way it would be if this defaulted to 0.
 */
export function extractRerankMsFromToolTrace(toolTrace: readonly ToolTraceEntry[]): number | null {
  let total: number | null = null;
  for (const entry of toolTrace) {
    const rerankMs = entry.retrieval?.timings.rerankMs;
    if (typeof rerankMs === 'number') {
      total = (total ?? 0) + rerankMs;
    }
  }
  return total;
}

/**
 * B0-619 — the product-line lock decision behind this turn's retrieval, taken from the first
 * search-backed tool call this turn that carried one. Every `ragQueryForProductKnowledgeWithMeta`
 * branch computes a `productLineResolution`, so in the common case of one dominant search call
 * this is unambiguous; when a turn made multiple independent search-backed calls (each resolving
 * its own query against the corpus), this reports the earliest one rather than trying to reconcile
 * decisions that were never required to agree. Null when no search tool ran this turn.
 */
export function extractProductLineLockFromToolTrace(
  toolTrace: readonly ToolTraceEntry[],
): ProductLineLock | null {
  for (const entry of toolTrace) {
    if (entry.retrieval?.productLineResolution) {
      return entry.retrieval.productLineResolution;
    }
  }
  return null;
}

/**
 * B0-514 — RETIRED from the default path (2026-08-18). The B0-511 cutover made the classifier
 * authoritative, so cross-reference intent for the turn is now derived from the classifier's own
 * output (`crossReferenceIntentForTurn` in `runProductSupportWorkflow`: intent `cross_reference`,
 * or a cross-reference `suggestedTool` — the latter preserves B0-339's point that a
 * `product`-routed message can still carry cross-reference intent). This substring check survives
 * ONLY as the degraded/kill-switch fallback: when the classifier did not run for the turn
 * (`BEX_LLM_ROUTER_ENABLED=false`, shadow mode, or an LLM failure that fell back), the old
 * behavior is preserved verbatim. Delete it entirely when the rollback lever is removed.
 *
 * B0-354 — used to carry its own 5-phrase list (`comparable`, `equivalent`, `cross reference`,
 * `cross-reference`, `alternative`) gated on a co-occurring literal `betco`, independent of
 * `hasDecisiveCrossReferenceSignal` (`sme-routing.ts`), the ~20-phrase list B0-339 added for SME
 * routing with no such gate. The two disagreed on inputs like "Which product replaces Spartan
 * BNC-15?" — decisive enough to route to `cross_reference`, but not decisive enough to force
 * `lookup_cross_reference` — so routing and tool-forcing silently diverged on the same turn. Now
 * delegates entirely to `hasDecisiveCrossReferenceSignal` (no `betco` gate) so the two predicates
 * share one phrase list and can never disagree again.
 */
export function shouldForceCrossReferenceLookup(userMessage: string) {
  return hasDecisiveCrossReferenceSignal(userMessage);
}

/**
 * B0-734 — the early-decline gate is a `settings` row now (per the B0-638 rule: flags live in the
 * table, env is for secrets), and it defaults OFF. The four canned replies it short-circuits with
 * contradict the golden datasets on every class they cover (mixing, compliance, shelf life, broad
 * recommendation) and, because the gate runs before any model call, they also prevented the
 * B0-727 shelf-life policy and the B0-559/B0-660 "don't ask for a surface already named" rules
 * from ever applying to the messages they were written for. The gate code stays so it can be
 * re-enabled from /admin/settings.
 */
async function isEarlyDeclineGateEnabled(): Promise<boolean> {
  return getBooleanSetting('BEX_EARLY_DECLINE_GATE_ENABLED', false);
}

/**
 * B0-559 — Betco's sport/gym floor finish & coating line is formulated for wood (hardwood) sports
 * floors only, so a message about a gym/sports floor has already answered the "which surface"
 * question the broad-recommendation decline below would otherwise ask. Without this carve-out,
 * "I need a durable gym floor finish, what do you recommend?" was declined for missing surface
 * context it doesn't need, identically to a genuinely context-free "what should I use?".
 */
function hasWoodSportsFloorContext(text: string) {
  return /(gym(nasium)?\s*floor|sports?\s*floor|sport\s*court|basketball\s*(court|floor))/.test(
    text,
  );
}

export { DEFAULT_MAX_OUTPUT_TOKENS, resolveMaxOutputTokens };

/**
 * B0-519 — hard cap on how many prior conversation messages (user + assistant, oldest-first) are
 * ever replayed for one turn. Without a ceiling, prompt tokens climb turn-over-turn with no bound —
 * an 11-turn thread was observed growing 18k → 271k tokens — which is the single largest driver of
 * the B0-434 latency tail.
 *
 * Below the cap, the generation loop replays `priorMessages` as-is. Once a conversation's
 * prior-message count exceeds the cap, the capped *tail* (most recent messages, so referenced
 * products / entities from the last few turns are preserved) is replayed instead of the full
 * history. This turns an unbounded per-turn cost into a flat one for the remainder of the
 * conversation. (Before B0-914 the Responses loop chained via `previous_response_id` below the cap
 * and was deliberately broken above it; there is no chain any more.)
 *
 * Configurable via `BEX_HISTORY_MAX_MESSAGES` without a redeploy; falls back to the default on
 * anything that is not a positive finite integer.
 */
export const DEFAULT_HISTORY_MAX_MESSAGES = 12;

export function resolveHistoryMaxMessages(): number {
  const raw = process.env.BEX_HISTORY_MAX_MESSAGES;
  if (!raw) {
    return DEFAULT_HISTORY_MAX_MESSAGES;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_HISTORY_MAX_MESSAGES;
}

/**
 * B0-519 — applies `resolveHistoryMaxMessages()` to one conversation's prior messages (already
 * oldest-first). Returns the capped tail plus whether capping actually changed anything, since a
 * short conversation should behave identically to before this ticket.
 */
export function capConversationHistory(
  priorMessages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): {
  cappedHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  historyCapApplied: boolean;
} {
  const maxMessages = resolveHistoryMaxMessages();
  const historyCapApplied = priorMessages.length > maxMessages;
  return {
    cappedHistory: historyCapApplied ? priorMessages.slice(-maxMessages) : [...priorMessages],
    historyCapApplied,
  };
}

/** Closed set of early-decline reasons, in the order `classifyEarlyDecline` tests them. */
export const EARLY_DECLINE_REASONS = [
  'chemical_mixing_or_safety',
  'legal_or_compliance',
  'storage_or_expiration',
  'broad_recommendation_without_context',
] as const;

/**
 * Confidence reported for a policy decline. Fixed text, no retrieval, no model call — high by
 * construction, and recorded as the applied threshold on the `early_decline_gate` gate record.
 */
export const EARLY_DECLINE_CONFIDENCE = 0.92;

export type EarlyDeclineDecision = {
  reason: (typeof EARLY_DECLINE_REASONS)[number];
  text: string;
};

/**
 * B0-518 — the four canned `classifyEarlyDecline` texts, named and exported so the eval harness
 * (`src/lib/tests/runner.ts`) can recognize them verbatim as canonical decline copy — the same
 * pattern already used there for `RECOMMENDATIONS_DECLINE_COPY` / `XREF_DECLINE_COPY`. Before this,
 * the harness's decline-detection regex/phrase list didn't cover this exact wording (missing
 * "advise", and the `broad_recommendation_without_context` copy has no decline vocabulary at all),
 * so a correctly-triggered early decline was graded as a failed "unrecognized" answer on every
 * Golden Test Set run.
 */
export const EARLY_DECLINE_CHEMICAL_MIXING_COPY =
  "I'm not able to advise on chemical mixing. Follow the product label and SDS, and involve your EHS lead.";
export const EARLY_DECLINE_LEGAL_COMPLIANCE_COPY =
  "I'm not able to provide legal or compliance guidance. Please use your official compliance process.";
export const EARLY_DECLINE_STORAGE_EXPIRATION_COPY =
  "I'm not able to verify safety for expired or stored products. Follow the product label and SDS before use.";
export const EARLY_DECLINE_BROAD_RECOMMENDATION_COPY =
  'I need more details to make a specific recommendation. Please share your surface, soil type, and application method.';

/** The canned copy for each decline class, so the B0-786 signal path maps a class without re-testing regexes. */
const EARLY_DECLINE_COPY: Record<(typeof EARLY_DECLINE_REASONS)[number], string> = {
  chemical_mixing_or_safety: EARLY_DECLINE_CHEMICAL_MIXING_COPY,
  legal_or_compliance: EARLY_DECLINE_LEGAL_COMPLIANCE_COPY,
  storage_or_expiration: EARLY_DECLINE_STORAGE_EXPIRATION_COPY,
  broad_recommendation_without_context: EARLY_DECLINE_BROAD_RECOMMENDATION_COPY,
};

export function classifyEarlyDecline(
  userMessage: string,
  options?: {
    /**
     * B0-514 — the turn's authoritative cross-reference intent (classifier-derived when the LLM
     * router ran). Omitted (standalone callers/tests), the pre-cutover substring check decides,
     * preserving B0-300's behavior verbatim.
     */
    crossReferenceIntent?: boolean;
    /**
     * B0-786 — the consolidated signals call's decline class. Supplied (INCLUDING as `null`, which
     * means "no decline") it replaces the four detection regexes below; omitted entirely — the
     * signals flag off, or a degraded signals call — and those regexes decide exactly as before.
     *
     * The two SUPPRESSION checks are deliberately NOT replaced: `hasWoodSportsFloorContext` and
     * `hasNamedSurfaceContext` still veto a `broad_recommendation_without_context` signal. They are
     * a deterministic floor in the safe direction (they can only turn a decline into a real answer,
     * never the reverse), and the same asymmetry the regulated-grounding rule turns on applies
     * here: an LLM miss must not be able to hand a user canned copy in place of an answer.
     */
    declineClass?: DeclineClass | null;
  },
): EarlyDeclineDecision | null {
  // B0-734 — pure classifier: the enabled/disabled decision is made by the caller from the
  // `settings` row, so this function's verdict never depends on ambient configuration.
  const text = userMessage.toLowerCase();

  if (options?.declineClass !== undefined) {
    if (options.declineClass === null) {
      return null;
    }
    if (
      options.declineClass === 'broad_recommendation_without_context' &&
      ((options.crossReferenceIntent ?? shouldForceCrossReferenceLookup(userMessage)) ||
        hasWoodSportsFloorContext(text) ||
        hasNamedSurfaceContext(text))
    ) {
      return null;
    }
    return { reason: options.declineClass, text: EARLY_DECLINE_COPY[options.declineClass] };
  }

  const asksChemicalMixing =
    /(mix|mixing|combine|adding|add)\b/.test(text) &&
    /(bleach|ammonia|acid|chlorine|cleaner|concentrate|chemical)/.test(text);
  if (asksChemicalMixing) {
    return {
      reason: 'chemical_mixing_or_safety',
      text: EARLY_DECLINE_CHEMICAL_MIXING_COPY,
    };
  }

  if (/(legal|osha|compliant|compliance|regulation|regulatory)/.test(text)) {
    return {
      reason: 'legal_or_compliance',
      text: EARLY_DECLINE_LEGAL_COMPLIANCE_COPY,
    };
  }

  if (
    /(expired|expiration|expire|shelf life|still good after|past expiration|past expiry)/.test(
      text,
    )
  ) {
    return {
      reason: 'storage_or_expiration',
      text: EARLY_DECLINE_STORAGE_EXPIRATION_COPY,
    };
  }

  if (
    /(what should i use|what do you recommend|what'?s the best|which .* should we use)/.test(
      text,
    ) &&
    // B0-300: a message that already names a competitor product and asks for a
    // Betco cross-reference (e.g. "...alternative to X. What do you recommend?")
    // isn't a broad, context-free request — let it reach the cross_reference
    // flow that knows how to answer (or correctly decline) it.
    !(options?.crossReferenceIntent ?? shouldForceCrossReferenceLookup(userMessage)) &&
    // B0-559: same idea for gym/sports floor mentions — the surface isn't actually ambiguous.
    !hasWoodSportsFloorContext(text) &&
    // B0-660: the general case B0-559 is one instance of — the user already named a
    // surface/material (concrete, VCT, terrazzo, grout, carpet, stainless steel, etc.) outright,
    // so there is nothing to disambiguate regardless of how many surfaces the line serves. Before
    // this, only surfaces with their own filed bug were suppressed; see `surface-vocabulary.ts`
    // for the shared vocabulary (also used by the intent classifier's prompt examples).
    !hasNamedSurfaceContext(text)
  ) {
    return {
      reason: 'broad_recommendation_without_context',
      text: EARLY_DECLINE_BROAD_RECOMMENDATION_COPY,
    };
  }

  return null;
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
        shortLabel?: string | null;
        shortDescription?: string | null;
        inventoryId?: string | null;
      }
    | null
    | undefined;
  // Curated-override analysis facts (present only on override matches).
  competitorEpaReg?: string | null;
  chemistryClass?: string | null;
  rationale?: string | null;
  betcoProductLineId?: string | null;
};

function isProbablyUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

/** First segment after `/products/` in a Betco URL, turned into title case words (e.g. symplicity-break → Symplicity Break). */
function humanizeBetcoProductSlugFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    const idx = segments.indexOf('products');
    const slug = idx >= 0 ? segments[idx + 1] : null;
    if (!slug || !/^[a-z0-9-]+$/i.test(slug)) {
      return null;
    }
    const words = slug.split('-').filter(Boolean);
    if (words.length === 0) {
      return null;
    }
    return words
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  } catch {
    return null;
  }
}

function trimOrEmpty(value: string | null | undefined) {
  const t = value?.trim();
  return t ? t : '';
}

function shortPlainText(value: string | null | undefined, maxLen: number) {
  const t = trimOrEmpty(value);
  if (!t) {
    return '';
  }
  const line = t.split(/\n/)[0]?.trim() ?? '';
  if (line.length <= maxLen) {
    return line;
  }
  return `${line.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** Prefer real product names over legacy keys; never show a UUID as the link label. */
function resolveCrossReferenceComparableTitle(match: CrossReferenceMatch): string {
  const bp = match.betcoProduct;
  const fromDb =
    trimOrEmpty(bp?.title) ||
    trimOrEmpty(bp?.shortLabel) ||
    shortPlainText(bp?.shortDescription, 120) ||
    trimOrEmpty(bp?.sku) ||
    trimOrEmpty(bp?.inventoryId);

  if (fromDb) {
    return fromDb;
  }

  const fromUrl = match.productUrl ? humanizeBetcoProductSlugFromUrl(match.productUrl) : null;
  if (fromUrl) {
    return fromUrl;
  }

  const pk = trimOrEmpty(match.productKey);
  if (pk && !isProbablyUuid(pk)) {
    return pk;
  }

  return 'Betco comparable product';
}

type RuntimeToolOutput = {
  toolName: string;
  ok: boolean;
  output: string;
  trace: ToolTraceEntry;
};

export type RetrievedSourceMeta = {
  documentId: string;
  chunkId: string | null;
  title: string;
  snippet: string;
  documentBody: string;
  documentKind: string | null;
  /** B0-257: source PDF/markdown S3 location, carried through for regulated-claim citation. */
  s3Key: string | null;
  sourceUri: string | null;
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
    }
  | {
      /**
       * B0-350 — emitted whenever this turn escalates for human review (validator rejection kept
       * visible per B0-262, a refused revision, or a hard-replaced safety rejection). Deliberately
       * separate from `status`/`tool`: the UI renders it as a banner alongside the already-streamed
       * answer text rather than as a stage transition.
       */
      type: 'answer_flagged_for_review';
      reason: ReviewRequestReason;
      issues: string[];
      /** True when the streamed draft was kept visible (B0-350); false on a hard-replaced answer. */
      answerRetained: boolean;
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

/**
 * B0-356 — the `recommend_cross_reference` engine's own verdict for this turn, if it ran.
 *
 * Deliberately a THIRD extractor alongside the two above: both of those filter on
 * `toolName === 'lookup_cross_reference'` and skipped the engine's output entirely, which is why
 * `answered` / `status` / `overallConfidence` / `thresholdUsed` / `declineReason` — the fields the
 * prompt calls authoritative — reached no code at all. Scans backwards so the LAST engine call in
 * the turn wins, and reports whether the model asked for it or the B0-355 backstop forced it
 * (`origin: 'workflow_injected'` is set only by the backstop).
 */
export function extractRecommendationEngineOutcomeFromToolOutputs(
  toolOutputs: RuntimeToolOutput[],
): RecommendationEngineOutcome | null {
  for (let i = toolOutputs.length - 1; i >= 0; i -= 1) {
    const entry = toolOutputs[i];
    if (!entry || entry.toolName !== RECOMMEND_CROSS_REFERENCE_TOOL || !entry.ok) {
      continue;
    }
    const parsed = parseRecommendationEngineOutput(entry.output);
    if (!parsed) {
      continue;
    }
    return {
      ...parsed,
      invocation:
        entry.trace.origin === 'workflow_injected' ? 'backstop' : 'model_called',
    };
  }
  return null;
}

/**
 * B0-635 — whether a tool output's hits are an unendorsed guess that must not be cited.
 *
 * The B0-436 speculative pre-fetch searches the RAW user message before the model has reasoned
 * about it, so it can match on an incidental word rather than on the product actually being asked
 * about: "how many quarts of end use product can I get from one cartridge of push?" matched
 * "Quarterpack Chemical Management Program" (0.417) and a label literally titled "quart" (a toilet
 * bowl cleaner) purely on "quarts". The retriever itself said so — its
 * `retrieval.productLineResolution` came back `skipped_low_confidence` with no
 * `lockedProductLineKey`, i.e. it judged every candidate too weak to lock onto a product line —
 * and those documents were cited to the user anyway.
 *
 * So: a speculative call whose own product-line resolution declined to lock is treated as
 * contributing no citable sources.
 *
 * Deliberately narrow. This is ONLY about the speculative call, which is a guess the model never
 * endorsed. A `model_chosen` search that comes back ambiguous is a deliberate request from the
 * model and keeps citing exactly as before, as does a speculative call whose resolution DID lock
 * (`explicit_filter` / `high_confidence`), and one whose resolution is absent (no product-line
 * resolution ran, so there is no low-confidence judgement to act on).
 */
export function isUnendorsedSpeculativeToolOutput(trace: ToolTraceEntry): boolean {
  // `speculative` is only ever set on the pre-fetch itself. A model call served FROM the
  // speculative result is marked `reusedSpeculativeResult` instead (and is not re-logged into
  // `toolOutputLog`), so it is not reachable here.
  if (trace.speculative !== true) {
    return false;
  }

  const resolution = trace.retrieval?.productLineResolution;
  if (!resolution || resolution.lockedProductLineKey) {
    return false;
  }

  return (
    resolution.lockReason === 'skipped_low_confidence' ||
    resolution.lockReason === 'skipped_ambiguous'
  );
}

/**
 * B0-700 follow-up — a fuzzy-alias resolution the turn's answer actually relies on, ready to be
 * deterministically disclosed.
 *
 * `askedForName` is the RAW string the model/user named (a product tool's own `productId`/
 * `query`/`productName` field — never the resolved product), and `resolvedTitle` is the real
 * resolved entity's own `rag.entity.title` (`aliasResolution.matchedTitle`, added alongside this
 * ticket in `~/lib/rag/entity-context.ts` / `~/lib/tools/product-tools.ts`) — never invented,
 * reformatted, or guessed.
 */
export type AliasFuzzyDisclosureMatch = {
  askedForName: string;
  resolvedTitle: string;
  /**
   * B0-979 — how the match was established. `alias_fuzzy` (the default when absent) is the B0-700
   * verified-alias fuzzy hit; `title_near_match` is the identity-question backstop: no alias fired
   * (`no_alias_match`) but the top retrieved title is within two edits of the typed name.
   */
  kind?: 'alias_fuzzy' | 'title_near_match';
};

/**
 * B0-979 — the identity-question backstop. For "do you have a product called X?" turns where the
 * alias resolver found nothing (`aliasResolution.outcome === 'no_alias_match'`), compare the typed
 * name against the top `search_product_docs` source title (LAST such call first, same scan order as
 * the alias scan). Fires only on `near` — an `exact` title (case / ®™ / transliterated "r"/"T"
 * aside, or the same name with a pack-size suffix) leaves the turn untouched, and a `different`
 * title (e.g. the line profile "Hard Film Floor Finish" ranking top) discloses nothing, because
 * that is not a spelling correction. The title is returned verbatim.
 */
function findIdentityTitleNearMatch(
  toolOutputs: RuntimeToolOutput[],
  userMessage: string | undefined,
): AliasFuzzyDisclosureMatch | null {
  if (!userMessage) return null;
  const typedName = extractIdentityAskName(userMessage);
  if (!typedName) return null;

  for (let i = toolOutputs.length - 1; i >= 0; i -= 1) {
    const entry = toolOutputs[i];
    if (!entry || !entry.ok || entry.toolName !== 'search_product_docs') continue;
    if (entry.trace?.origin === 'workflow_injected' && entry.trace.speculative !== true) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.output);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const payload = parsed as { aliasResolution?: { outcome?: unknown }; sources?: Array<{ title?: unknown }> };
    if (payload.aliasResolution?.outcome !== 'no_alias_match') continue;
    const topTitle = typeof payload.sources?.[0]?.title === 'string' ? payload.sources[0].title.trim() : '';
    if (!topTitle) continue;
    const comparison = compareIdentityNameToTitle(typedName, topTitle);
    if (comparison === 'near') {
      return { askedForName: typedName, resolvedTitle: topTitle, kind: 'title_near_match' };
    }
    // `exact` or `different`: the top retrieval for this identity question is not a spelling
    // correction, and an older call in the trace must not overrule the one that fed the answer.
    return null;
  }
  return null;
}

/**
 * Scans this turn's tool outputs, LAST call first, for the fuzzy-alias hit that grounded the final
 * answer — mirrors the scan order of `extractRecommendationEngineOutcomeFromToolOutputs` /
 * `extractTopCrossReferenceMatchFromToolOutputs` above (the last relevant call in a turn is the one
 * that actually fed the drafted answer when more than one ran).
 *
 * Deliberately narrow to keep a noisy trace from over-disclosing:
 *  - `!entry.ok` calls and `isUnendorsedSpeculativeToolOutput` calls are skipped — same "did this
 *    actually reach the user" filter `collectSourcesFromToolOutputs` uses (B0-635), so an unused
 *    speculative pre-fetch's fuzzy hit never triggers a disclosure for a product the answer never
 *    discusses.
 *  - only `aliasResolution.outcome === 'alias_fuzzy'` fires — `alias_exact` needs no disclosure,
 *    and `no_alias_match`/`ambiguous_alias` are the existing B0-700 decline path, untouched here.
 *  - a call with no `matchedTitle` (e.g. an older payload shape, or the alias pointed at a
 *    title-less entity) is skipped rather than disclosing with a blank/guessed name.
 *  - skipped when the asked-for string and the resolved title are already the same text — nothing
 *    to disclose.
 */
export function extractAliasFuzzyDisclosureFromToolOutputs(
  toolOutputs: RuntimeToolOutput[],
  // B0-979 — `userMessage` enables the identity-question title backstop; omitted → alias-only.
  options: { userMessage?: string } = {},
): AliasFuzzyDisclosureMatch | null {
  for (let i = toolOutputs.length - 1; i >= 0; i -= 1) {
    const entry = toolOutputs[i];
    if (!entry || !entry.ok || isUnendorsedSpeculativeToolOutput(entry.trace)) {
      continue;
    }
    /**
     * B0-875 — a `workflow_injected` call was seeded by the workflow, not by the user: the enforced
     * `search_product_docs` after a cross-reference hit takes its `productName` from the legacy
     * match's Betco title (`buildCrossReferenceSearchArgs`), and a FUZZY legacy row
     * (`fallbackRecommended: true`, 0.675 on P#8) fed "AF79 …" into the alias resolver, whose
     * fuzzy hit was then disclosed as if the user had typed it. The disclosure may only echo a
     * name the user actually asked for, never a cross-reference candidate.
     */
    if (entry.trace?.origin === 'workflow_injected') {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.output);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }
    const payload = parsed as Record<string, unknown>;

    const aliasResolutionRaw = payload.aliasResolution;
    if (
      !aliasResolutionRaw ||
      typeof aliasResolutionRaw !== 'object' ||
      Array.isArray(aliasResolutionRaw)
    ) {
      continue;
    }
    const aliasResolution = aliasResolutionRaw as Record<string, unknown>;
    if (aliasResolution.outcome !== 'alias_fuzzy') {
      continue;
    }

    const resolvedTitle =
      typeof aliasResolution.matchedTitle === 'string' ? aliasResolution.matchedTitle.trim() : '';
    if (!resolvedTitle) {
      continue;
    }

    // Regulated product-tool calls echo the raw input as `productId`; `search_product_docs`
    // echoes it as `query` instead (see `~/lib/tools/product-tools.ts`). Neither is invented here
    // — both are the literal string the tool was called with.
    const askedForRaw =
      typeof payload.productId === 'string' && payload.productId.trim()
        ? payload.productId
        : typeof payload.query === 'string' && payload.query.trim()
          ? payload.query
          : typeof payload.productName === 'string' && payload.productName.trim()
            ? payload.productName
            : '';
    const askedForName = askedForRaw.trim();
    if (!askedForName || askedForName.toLowerCase() === resolvedTitle.toLowerCase()) {
      continue;
    }

    return { askedForName, resolvedTitle, kind: 'alias_fuzzy' };
  }
  // B0-979 — no fuzzy alias grounded the turn; try the identity-question title backstop.
  return findIdentityTitleNearMatch(toolOutputs, options.userMessage);
}

/**
 * Cheap heuristic for "the model already disclosed this itself" — the B0-700 prompt rule DOES
 * sometimes get followed, and this guardrail's whole job is to backstop the cases where it isn't,
 * not to double up on the cases where it is. Deliberately loose (a handful of phrasings a
 * disclosure sentence would plausibly use), because a false "already disclosed" (skips the
 * deterministic prepend) is a silent regression to the exact bug this exists to fix, while a false
 * "not yet disclosed" (prepends anyway) only ever produces a redundant sentence, never a wrong one.
 */
const ALIAS_FUZZY_DISCLOSURE_ALREADY_PRESENT_PATTERN =
  /couldn.?t find an exact match|could not find an exact match|did you mean|closest match|no exact match|typo|misspell/i;

export function draftAlreadyDisclosesAliasCorrection(draftAnswer: string): boolean {
  return ALIAS_FUZZY_DISCLOSURE_ALREADY_PRESENT_PATTERN.test(draftAnswer);
}

/**
 * The disclosure sentence itself — plain prose, no dilution/EPA/DIN/CAS/contact-time/hazard/
 * compatibility/efficacy-shaped tokens, so it can pass through `evaluateRegulatedClaimGrounding`
 * unaffected (verified by `alias-fuzzy-disclosure.test.ts`). Both names are transcribed verbatim
 * from `AliasFuzzyDisclosureMatch` — never reformatted.
 */
export function buildAliasFuzzyDisclosureSentence(match: AliasFuzzyDisclosureMatch): string {
  if (match.kind === 'title_near_match') {
    // B0-979 — the identity-question wording the golden expects: closest match + spelling differs.
    return `The closest catalog match to "${match.askedForName}" is ${match.resolvedTitle} — the spelling differs. Here is its information:\n\n`;
  }
  return `I couldn't find an exact match for "${match.askedForName}", but found ${match.resolvedTitle} — here is its information:\n\n`;
}

/**
 * B0-979 — closing line for the identity-question backstop: invites the exact label name or item
 * number (the two things that resolve a product unambiguously), plain prose, no regulated token.
 */
export const IDENTITY_TITLE_CORRECTION_INVITE =
  "\n\nIf that isn't the product you meant, reply with the exact name printed on the label or the item number and I'll look again.";

/**
 * B0-700 follow-up — the deterministic backstop itself. `gpt-4.1-mini` was confirmed (live, twice)
 * to ignore the prompt-only disclosure instruction, the same failure class already fixed for a
 * false-claim rejection in B0-756; this is the equivalent fix for a missing disclosure SENTENCE,
 * which has no "source" to verify against (it's Bex's own meta-commentary on its resolution
 * process, not a regulated claim), so it is composed here in code instead of gated by the
 * regulated-claim guardrail.
 *
 * Called once `draftAnswer` is fully settled (after the revision pass, before the regulated-claim
 * guardrail so the prepended sentence is itself swept through that check) — see the call site in
 * `runProductSupportWorkflow`. Skipped entirely on an already-declined draft (nothing was actually
 * answered to disclose a correction for).
 */
/**
 * B0-830 — the closing line of the agreed disclosure UX (clarify → answer for the suspected product
 * → invite correction). Plain prose, no regulated-shaped token, appended only when this code also
 * prepended the disclosure sentence.
 */
export const ALIAS_FUZZY_CORRECTION_INVITE =
  "\n\nIf that isn't the product you meant, reply with the corrected product name and I'll look it up again.";

/** A product-code-shaped token: 1–4 letters, 1–4 digits, optional trailing letter (AF79, pH7Q, GE1). */
const PRODUCT_CODE_TOKEN_PATTERN = /^[A-Za-z]{1,4}\d{1,4}[A-Za-z]?$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * B0-830 — rewrite the model's uses of the MISSPELLED asked-for name to the resolved product name.
 * `gpt-4.1`/`4.1-mini` were confirmed live to keep writing "AG79 Concentrate Disinfectant" — and
 * even "Source: AG79 Concentrate Disinfectant product label", a label for a product that does not
 * exist — after the resolver had found AF79. Same failure class as B0-700/B0-756: a prompt rule
 * alone is not a reliable guardrail on these models, so the correction is applied in code.
 *
 * Two deterministic passes, both transcribing `resolvedTitle` verbatim (never reformatted):
 *  1. every case-insensitive occurrence of the full asked-for name → the resolved name;
 *  2. when the resolved name contains exactly ONE product-code-shaped token (e.g. `AF79`) and the
 *     asked-for name contains a code-shaped token that is NOT in the resolved name (e.g. `AG79`),
 *     that bare token is rewritten too (word-bounded), so "AG79 is diluted…" becomes "AF79 is
 *     diluted…". Skipped when the resolved name has zero or several code tokens — there is no
 *     unambiguous substitute, and guessing one would be exactly the inference this code exists to
 *     prevent.
 *
 * The asked-for name is protected wherever it appears QUOTED (`"AG79 …"`, `“AG79 …”`, `'AG79 …'`):
 * that is the disclosure sentence itself (ours or the model's own), which must keep naming what
 * the user actually typed.
 */
export function rewriteAskedForNameToResolved(
  draftAnswer: string,
  match: AliasFuzzyDisclosureMatch,
): string {
  const asked = match.askedForName.trim();
  const resolved = match.resolvedTitle.trim();
  if (!asked || !resolved || asked.toLowerCase() === resolved.toLowerCase()) {
    return draftAnswer;
  }

  // Protect quoted occurrences of the asked-for name with a sentinel, rewrite, then restore.
  const QUOTED_SENTINEL = '__ALIAS_ASKED_FOR_QUOTED__';
  const quotedPattern = new RegExp(`(["“'])${escapeRegExp(asked)}(["”'])`, 'gi');
  const protectedQuotes: string[] = [];
  let text = draftAnswer.replace(quotedPattern, (whole) => {
    protectedQuotes.push(whole);
    return QUOTED_SENTINEL;
  });

  text = text.replace(new RegExp(escapeRegExp(asked), 'gi'), resolved);

  const tokenize = (value: string) => value.split(/[\s,;:()/]+/).filter(Boolean);
  const resolvedTokens = tokenize(resolved);
  const resolvedLower = new Set(resolvedTokens.map((t) => t.toLowerCase()));
  const resolvedCodes = resolvedTokens.filter((t) => PRODUCT_CODE_TOKEN_PATTERN.test(t));
  if (resolvedCodes.length === 1) {
    const askedCodes = tokenize(asked).filter(
      (t) => PRODUCT_CODE_TOKEN_PATTERN.test(t) && !resolvedLower.has(t.toLowerCase()),
    );
    for (const code of new Set(askedCodes.map((t) => t.toLowerCase()))) {
      text = text.replace(new RegExp(`\\b${escapeRegExp(code)}\\b`, 'gi'), resolvedCodes[0]);
    }
  }

  // The rewrite can turn the model's "AG79 … (also known as AF79 …)" into a tautology; drop a
  // parenthetical that now just repeats the name it follows. Purely cosmetic, name-only text.
  text = text.replace(
    new RegExp(
      `(${escapeRegExp(resolved)})\\s*\\((?:also known as|aka|a\\.k\\.a\\.)\\s+${escapeRegExp(resolved)}\\)`,
      'gi',
    ),
    '$1',
  );

  let restoreIndex = 0;
  return text.replace(new RegExp(QUOTED_SENTINEL, 'g'), () => protectedQuotes[restoreIndex++] ?? '');
}

export function maybeDiscloseAliasFuzzyMatch(
  draftAnswer: string,
  toolOutputs: RuntimeToolOutput[],
  // B0-979 — see `extractAliasFuzzyDisclosureFromToolOutputs`.
  options: { userMessage?: string } = {},
): string {
  if (isDeclineAnswer(draftAnswer)) {
    return draftAnswer;
  }
  const match = extractAliasFuzzyDisclosureFromToolOutputs(toolOutputs, options);
  if (!match) {
    return draftAnswer;
  }
  // B0-830 — the body rewrite applies whether or not the model disclosed the correction itself:
  // a self-disclosed answer that then keeps saying "AG79" is still wrong.
  const rewritten = rewriteAskedForNameToResolved(draftAnswer, match);
  if (draftAlreadyDisclosesAliasCorrection(draftAnswer)) {
    return rewritten;
  }
  const invite =
    match.kind === 'title_near_match' ? IDENTITY_TITLE_CORRECTION_INVITE : ALIAS_FUZZY_CORRECTION_INVITE;
  return buildAliasFuzzyDisclosureSentence(match) + rewritten + invite;
}

export function collectSourcesFromToolOutputs(toolOutputs: RuntimeToolOutput[]): SourceRef[] {
  const map = new Map<string, SourceRef>();

  for (const entry of toolOutputs) {
    if (!entry.ok) {
      continue;
    }
    // B0-635 — user-visible citations only. See `isUnendorsedSpeculativeToolOutput`.
    if (isUnendorsedSpeculativeToolOutput(entry.trace)) {
      continue;
    }
    try {
      const payload = JSON.parse(entry.output) as {
        sources?: Array<{
          documentId?: string;
          chunkId?: string;
          title?: string;
          snippet?: string;
          similarity?: number;
          confidence?: number;
          documentKind?: string;
          s3Key?: string | null;
          sourceUri?: string | null;
          url?: string | null;
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
        // B0-293 — narrowed to the known corpus values; an unrecognised kind is dropped rather
        // than shown, so the Sources panel never labels a source with a corpus we can't vouch for.
        const documentKind = asRagDocumentKind(s.documentKind);
        map.set(key, {
          documentId: s.documentId,
          chunkId: s.chunkId,
          title: s.title ?? s.documentId,
          snippet: s.snippet.slice(0, 2000),
          // B0-490 — `similarity` is the retrieval similarity under an unambiguous key; `confidence`
          // is read only as a fallback for a payload that never carried the new key.
          similarity: typeof s.similarity === 'number' ? s.similarity : s.confidence,
          // B0-257: thread the source PDF/markdown's S3 location through to the persisted
          // citation object so label/SDS-derived directions/hazards/first-aid answers carry it.
          s3Key: s.s3Key ?? undefined,
          sourceUri: s.sourceUri ?? undefined,
          // B0-1075: derived betco.com product-page URL. `kind` is deliberately left unset (not
          // 'external') -- this source is still internal/corpus-backed, just with an extra public
          // link; the Sources panel (B0-1076) renders it as a secondary affordance, not a web result.
          url: typeof s.url === 'string' && s.url.trim() ? s.url : undefined,
          // B0-293: which corpus the source came from, so the Bex Sources panel can label it.
          ...(documentKind ? { documentKind } : {}),
        });
      }
    } catch {
      // Ignore malformed output and continue scanning.
    }
  }

  return [...map.values()].slice(0, 16);
}

/**
 * Every semantic-search hit from tool outputs (deduped), using `rag.document` / `rag.document_chunk` ids.
 *
 * B0-635 — deliberately NOT narrowed by `isUnendorsedSpeculativeToolOutput`. This is the run's
 * forensic record of what retrieval actually returned (`final_output.retrieved_document_chunks`,
 * read by `/admin/observability`'s retrieved-chunks panel and by the test-harness retrieval
 * metrics). Hiding the speculative call's weak hits here would make the trace lie about the very
 * behaviour B0-635 exists to diagnose. Citations are filtered; the audit record is not.
 */
export function collectRetrievedDocumentChunksFromToolOutputs(
  toolOutputs: RuntimeToolOutput[],
): RetrievedDocumentChunkRef[] {
  const map = new Map<string, RetrievedDocumentChunkRef>();

  for (const entry of toolOutputs) {
    if (!entry.ok) {
      continue;
    }
    try {
      const payload = JSON.parse(entry.output) as {
        sources?: Array<{
          documentId?: string;
          chunkId?: string;
          documentKind?: string;
          title?: string;
          productLineKey?: string;
        }>;
      };
      for (const s of payload.sources ?? []) {
        if (!s.documentId) {
          continue;
        }
        const chunkId =
          typeof s.chunkId === 'string' && s.chunkId.trim() ? s.chunkId.trim() : null;
        const key = `${s.documentId}:${chunkId ?? ''}`;
        if (map.has(key)) {
          continue;
        }
        map.set(key, {
          document_id: s.documentId,
          chunk_id: chunkId,
          document_kind: typeof s.documentKind === 'string' ? s.documentKind : null,
          document_title: typeof s.title === 'string' ? s.title : null,
          product_line_key:
            typeof s.productLineKey === 'string' && s.productLineKey.trim()
              ? s.productLineKey.trim()
              : null,
        });
      }
    } catch {
      // Ignore malformed output and continue scanning.
    }
  }

  return [...map.values()];
}

/**
 * The same tool outputs as `collectRetrievedDocumentChunksFromToolOutputs`, kept per call and in
 * order instead of unioned into a deduped Map.
 *
 * Deliberately NOT a replacement for that function — both are written. The union answers "what did
 * this turn retrieve" (and is what `/admin/observability`, `prompt-insights`, and
 * `extractRetrievedDocumentChunks` read); this answers "what did each call return, in what order,
 * and what did the cross-encoder think" — which the union cannot, and which cannot be reconstructed
 * later from anything that gets persisted.
 *
 * Like the union, this is the forensic record: failed calls are skipped (they have no sources), but
 * speculative and otherwise-unendorsed hits are kept (B0-635). A retrieval-quality metric that
 * silently dropped the speculative call would be measuring a pipeline nobody runs.
 */
export function collectRetrievalCallsFromToolOutputs(
  toolOutputs: RuntimeToolOutput[],
): RetrievalCallRecord[] {
  const calls: RetrievalCallRecord[] = [];

  for (const entry of toolOutputs) {
    if (!entry.ok) {
      continue;
    }
    try {
      const payload = JSON.parse(entry.output) as {
        sources?: Array<{
          documentId?: string;
          chunkId?: string;
          similarity?: number;
          rerankScore?: number | null;
          rerankRank?: number | null;
        }>;
      };

      const chunks = (payload.sources ?? [])
        .filter((s) => Boolean(s.documentId))
        .map((s) => ({
          document_id: s.documentId as string,
          chunk_id: typeof s.chunkId === 'string' && s.chunkId.trim() ? s.chunkId.trim() : null,
          similarity: typeof s.similarity === 'number' ? s.similarity : null,
          rerank_score: typeof s.rerankScore === 'number' ? s.rerankScore : null,
          rerank_rank: typeof s.rerankRank === 'number' ? s.rerankRank : null,
        }));

      // A call that returned no sources is not a retrieval call — recording it would pad the
      // denominator of every per-call metric with rows that never had anything to rank.
      if (chunks.length === 0) {
        continue;
      }

      calls.push({
        tool_name: entry.toolName,
        call_id: entry.trace?.callId ?? null,
        retrieval_strategy: entry.trace?.retrieval?.retrievalStrategy ?? null,
        chunks,
      });
    } catch {
      // Ignore malformed output and continue scanning.
    }
  }

  return calls;
}

/**
 * The evidence pool: every retrieved source with its body, feeding `buildEvidenceSummary` (validator
 * evidence), `evaluateUsageSafetyCoverage`, and the B0-257 regulated-claim guardrail's grounding set.
 *
 * B0-635 — deliberately NOT narrowed by `isUnendorsedSpeculativeToolOutput`. The regulated-claim
 * guardrail must always receive the COMPLETE evidence set: it verifies that every dilution ratio,
 * contact time, EPA registration number and hazard statement in the draft answer is quoted verbatim
 * from a retrieved document, so removing candidate documents from its pool can only make it reject a
 * correct regulated claim, or fail to catch a wrong one. Filtering citations is a presentation
 * decision; filtering this would be a regulated-data decision, and always the unsafe one.
 */
export function collectSourceMetaFromToolOutputs(
  toolOutputs: RuntimeToolOutput[],
): RetrievedSourceMeta[] {
  const map = new Map<string, RetrievedSourceMeta>();

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
          documentBody?: string;
          documentKind?: string;
          s3Key?: string | null;
          sourceUri?: string | null;
        }>;
      };
      for (const source of payload.sources ?? []) {
        if (!source.documentId || !source.snippet) {
          continue;
        }
        const chunkId =
          typeof source.chunkId === 'string' && source.chunkId.trim()
            ? source.chunkId.trim()
            : null;
        // Sources are now per-document (chunks deduped at retrieval time), so dedupe by documentId only
        // to avoid duplicating the same large body across tool calls.
        const key = source.documentId;
        const existing = map.get(key);
        const documentBody =
          typeof source.documentBody === 'string' && source.documentBody.length > 0
            ? source.documentBody
            : source.snippet;
        const s3Key = typeof source.s3Key === 'string' && source.s3Key.trim() ? source.s3Key : null;
        const sourceUri =
          typeof source.sourceUri === 'string' && source.sourceUri.trim() ? source.sourceUri : null;

        if (existing) {
          // Prefer the entry that carries the larger document body (full text vs snippet).
          if (documentBody.length > existing.documentBody.length) {
            map.set(key, {
              ...existing,
              chunkId: existing.chunkId ?? chunkId,
              snippet: source.snippet,
              documentBody,
              documentKind:
                existing.documentKind ??
                (typeof source.documentKind === 'string' ? source.documentKind : null),
              s3Key: existing.s3Key ?? s3Key,
              sourceUri: existing.sourceUri ?? sourceUri,
            });
          }
          continue;
        }

        map.set(key, {
          documentId: source.documentId,
          chunkId,
          title: source.title ?? source.documentId,
          snippet: source.snippet,
          documentBody,
          documentKind:
            typeof source.documentKind === 'string' ? source.documentKind : null,
          s3Key,
          sourceUri,
        });
      }
    } catch {
      // Ignore malformed output and continue scanning.
    }
  }

  return [...map.values()];
}

/**
 * B0-872 — the ORIGINAL usage/safety lexical predicate, kept byte-for-byte for
 * `isSafetySensitiveRoute` (B0-546) only. That consumer wants the broad, conservative reading —
 * a message that so much as mentions `dilution` must never skip the validator's LLM pass on
 * similarity grounds — so the bare `dilution` / `application` terms are deliberately still here.
 * The usage/safety coverage GATE no longer uses this; see `hasUsageSafetyQuestionShape` and
 * `queryNeedsUsageAndSafetyCoverage` below.
 */
function hasUsageSafetyLexicalSignal(userMessage: string) {
  const text = userMessage.toLowerCase();
  return (
    /\b(how do i use|how to use|how should i use|directions|procedure|application|dilution|safe|safety|hazard|ppe|precaution|first aid)\b/.test(
      text,
    ) || /\b(can i use|is it safe)\b/.test(text)
  );
}

/**
 * B0-872 — does the message READ like a product-usage / safety question? Narrower than
 * `hasUsageSafetyLexicalSignal`: bare `dilution` and `application` are gone. Those two words made
 * every dilution-control knowledge question ("Do dilution control systems require plumbing or
 * electrical work?") a usage/safety question, which then demanded SDS-kind safety evidence that a
 * question naming no product can never retrieve, and replaced a 1,200–2,400 char knowledge-base
 * draft with the "Exact Betco product name or SKU" template.
 *
 * This is only HALF of the gate's trigger — see `queryNeedsUsageAndSafetyCoverage`. Exported for
 * `usage-safety-coverage.test.ts`.
 */
export function hasUsageSafetyQuestionShape(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return (
    /\b(how do i use|how to use|how should i use|directions|procedure|safe|safety|hazard|ppe|precaution|first aid)\b/.test(
      text,
    ) || /\b(can i use|is it safe)\b/.test(text)
  );
}

/**
 * B0-872 — where the gate found the product the question is about, when it found one at all.
 * - `product_line_lock` — the turn's retrieval resolved and LOCKED a product line (B0-619
 *   `productLineResolution.lockedProductLineKey`), i.e. an alias / SKU / product-line name in the
 *   message resolved deterministically. `skipped_no_product_line` and `skipped_ambiguous` (SZ#21's
 *   "a disinfectant or bleach") do NOT count — only a non-null lock does.
 * - `turn_signals` — the B0-786 signals pass resolved a Betco product entity for this turn.
 * - `tool_arguments` — a search-backed tool call this turn named a product (`productName`), the
 *   same argument `search_product_docs` itself treats as "this is a product-specific search"
 *   (a `freeformQuery` call is, by that tool's own contract, NOT one).
 */
export type UsageSafetyProductSubjectSource =
  | 'product_line_lock'
  | 'turn_signals'
  | 'tool_arguments';

export type UsageSafetyProductSubject = {
  hasProductSubject: boolean;
  source: UsageSafetyProductSubjectSource | null;
};

/**
 * B0-872 — resolve whether the turn concerns an identifiable Betco product at all. A usage/safety
 * question with NO product subject cannot have SDS-backed safety evidence by construction (there
 * is no SDS to retrieve), so requiring it would only ever fail; the gate therefore does not apply.
 */
export function resolveUsageSafetyProductSubject(input: {
  productLineLock: ProductLineLock | null;
  signalsProductLineKey: string | null | undefined;
  toolTrace: readonly ToolTraceEntry[];
}): UsageSafetyProductSubject {
  if (input.productLineLock?.lockedProductLineKey) {
    return { hasProductSubject: true, source: 'product_line_lock' };
  }
  if (input.signalsProductLineKey) {
    return { hasProductSubject: true, source: 'turn_signals' };
  }
  for (const entry of input.toolTrace) {
    if (!/^(search_product_docs|get_product_spec|get_approved_usage_guidance|get_safety_constraints|get_compatibility_rules|list_allowed_surfaces|list_disallowed_uses|get_efficacy_data)$/.test(entry.toolName)) {
      continue;
    }
    // `argumentsPreview` is a (possibly truncated) JSON preview; an unparseable one is simply not
    // evidence of a product subject — never a reason to guess one.
    try {
      const args = JSON.parse(entry.argumentsPreview) as unknown;
      if (
        args &&
        typeof args === 'object' &&
        typeof (args as { productName?: unknown }).productName === 'string' &&
        (args as { productName: string }).productName.trim().length > 0
      ) {
        return { hasProductSubject: true, source: 'tool_arguments' };
      }
    } catch {
      // Not JSON (truncated preview) — fall through.
    }
  }
  return { hasProductSubject: false, source: null };
}

/**
 * B0-872 — the usage/safety coverage gate's trigger: the message must READ like a usage/safety
 * question (`hasUsageSafetyQuestionShape`) AND concern an identifiable product
 * (`resolveUsageSafetyProductSubject`). Either alone is not enough:
 * - "Can I use a disinfectant or bleach to sanitize our wood gym floor?" has the shape but names no
 *   product → a knowledge answer, kept as drafted.
 * - "What is the EPA reg number for Fight Bac RTU?" names a product but is not a usage question.
 * - "How do I use pH7Q on a hospital floor?" has both → the gate runs, and with no label/SDS
 *   retrieved it still caps and replaces the draft with the usage/safety template.
 *
 * Exported for `usage-safety-coverage.test.ts`.
 */
export function queryNeedsUsageAndSafetyCoverage(
  userMessage: string,
  productSubject: Pick<UsageSafetyProductSubject, 'hasProductSubject'>,
): boolean {
  return hasUsageSafetyQuestionShape(userMessage) && productSubject.hasProductSubject;
}

function hasUsageSignal(text: string) {
  return /\b(use|usage|direction|procedure|application|dilution|mix ratio|instructions?)\b/.test(
    text,
  );
}

function hasSafetySignal(text: string) {
  return /\b(sds|safety|hazard|ppe|first aid|precaution|warning|flammable|corrosive)\b/.test(
    text,
  );
}

/**
 * B0-365 — per-source cap on how much `documentBody` the coverage scan reads.
 * `hasUsageSignal` / `hasSafetySignal` are simple alternation patterns, but a full
 * approved document body can be tens of KB; usage directions and safety statements
 * appear early in Betco labels/SDS, so the first few KB is where the signal is.
 */
const USAGE_SAFETY_COVERAGE_BODY_SCAN_MAX_CHARS = 4_000;

/**
 * Confidence ceiling applied when a usage/safety question lacks usage or safety
 * evidence. Mirrored (deliberately, to keep the pure timeline module free of this
 * module's OpenAI/Supabase imports) by `USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP` in
 * `~/lib/observability/timeline.ts` — change both together.
 */
const USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP = 0.55;

/**
 * B0-365 — the coverage gate used to scan only `title` + `snippet`, while the tool
 * contract ("read documentBody, not just snippet") and the agent both answer from
 * `documentBody`. Safety/usage text sitting in the retrieved body was therefore
 * invisible here and clamped well-grounded answers to 0.55. The body is now scanned
 * too, truncated per source to bound regex cost.
 *
 * Exported for unit testing (see `usage-safety-coverage.test.ts`).
 */
export function evaluateUsageSafetyCoverage(
  sources: Pick<
    RetrievedSourceMeta,
    'title' | 'snippet' | 'documentBody' | 'documentKind'
  >[],
) {
  let hasUsageEvidence = false;
  let hasSafetyEvidence = false;

  for (const source of sources) {
    const docKind = source.documentKind?.toLowerCase() ?? '';
    const sourceText = [
      source.title,
      source.snippet,
      (source.documentBody ?? '').slice(0, USAGE_SAFETY_COVERAGE_BODY_SCAN_MAX_CHARS),
    ]
      .join(' ')
      .toLowerCase();

    if (docKind === 'sds' || hasSafetySignal(sourceText)) {
      hasSafetyEvidence = true;
    }
    if (docKind === 'product_line_profile' || hasUsageSignal(sourceText)) {
      hasUsageEvidence = true;
    }

    if (hasUsageEvidence && hasSafetyEvidence) {
      break;
    }
  }

  return { hasUsageEvidence, hasSafetyEvidence };
}

/* -------------------------------------------------------------------------- *
 * B0-829 / B0-871 — regulated-claim guardrail: redact vs. decline
 * -------------------------------------------------------------------------- */

/**
 * B0-928 — `REGULATED_CLAIM_CATEGORY_LABELS`, `regulatedClaimWithheldMarker` and
 * `REGULATED_CLAIM_REDACTION_MIN_REMAINING_CHARS` moved to
 * `~/lib/workflows/product-support/regulated-claim-redaction-copy` (one spelling of the copy, and
 * importable from the grader without this module). Re-exported so existing importers keep working.
 */
export {
  REGULATED_CLAIM_CATEGORY_LABELS,
  REGULATED_CLAIM_REDACTION_MIN_REMAINING_CHARS,
  regulatedClaimWithheldMarker,
};

/**
 * B0-829 — categories whose ungrounded snippet is an exact literal token (an EPA/DIN/CAS number,
 * a dilution ratio, a contact time), safe to blank out in place with `(unable to verify)`.
 */
const TOKEN_SHAPED_REGULATED_CATEGORIES: ReadonlySet<RegulatedClaimCategory> = new Set<
  RegulatedClaimCategory
>(['epa_registration', 'din_registration', 'dilution_ratio', 'contact_time', 'cas_number']);

/**
 * B0-871 — sentence-shaped categories that MAY be withheld sentence-by-sentence on a KNOWLEDGE
 * answer (see `planRegulatedClaimRedaction`). `hazard` and `first_aid` are absent here: they are
 * redactable only on a non-safety question (B0-1131, `SAFETY_SENTENCE_REGULATED_CATEGORIES`).
 *
 * PROPOSED RULE IMPLEMENTED, PENDING TOM'S CONFIRMATION (B0-871). B0-829 excluded every
 * sentence-shaped category from partial redaction by design, decided against a contact-time
 * example and never tested on knowledge answers; 34 of the 57 F-graded golden items were the
 * same 255-char decline replacing a draft that held the golden's mandatory concepts because of
 * one unverifiable compatibility/efficacy sentence.
 */
const REDACTABLE_SENTENCE_REGULATED_CATEGORIES: ReadonlySet<RegulatedClaimCategory> = new Set<
  RegulatedClaimCategory
>(['compatibility', 'efficacy_claim']);

/**
 * B0-1131 — `hazard` / `first_aid`: withheld sentence-by-sentence ONLY when the question is not
 * itself a safety / exposure question (`isSafetyOrExposureQuestion`); otherwise the full decline.
 */
const SAFETY_SENTENCE_REGULATED_CATEGORIES: ReadonlySet<RegulatedClaimCategory> = new Set<
  RegulatedClaimCategory
>(['hazard', 'first_aid']);

/**
 * B0-1131 — the message asks about safety, PPE, hazards, first aid or an exposure incident. Wider
 * than `hasUsageSafetyQuestionShape` on purpose: an exposure report ("got floor stripper splashed in
 * their eyes", "swallowed", "breathed in") names no safety keyword but is the most safety-critical
 * question there is. Errs toward declining.
 */
export function isSafetyOrExposureQuestion(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return (
    hasUsageSafetyQuestionShape(text) ||
    /\b(?:hazards?|hazardous|dangerous|danger|toxic|poison\w*|flammab\w*|combustib\w*|corrosiv\w*|burns?|burned|irritat\w*|exposure|exposed|splash\w*|spill\w*|swallow\w*|ingest\w*|inhal\w*|breath\w*|fumes?|vapou?rs?|eyes?|skin|gloves?|goggles|respirator|protective|mix(?:ed|ing)?|emergency)\b/.test(
      text,
    )
  );
}

/**
 * B0-871 — `evaluateRegulatedClaimGrounding` (`validator.ts`) reports a sentence-shaped claim as
 * `snippet: sentence.slice(0, 240)`. Mirrored here (NOT imported — that file is owned elsewhere and
 * the cap is a local literal there) so `expandRegulatedClaimSnippetToSentence` can tell "this
 * snippet may have been cut" from "this is the whole sentence".
 */
export const REGULATED_CLAIM_SENTENCE_SNIPPET_CAP = 240;

/**
 * B0-871 — "knowledge-kind sources dominate": strictly more than half of the retrieved sources
 * with a known `documentKind` are `knowledge` documents (dilution-control guides, program
 * literature), as opposed to a product's label / SDS / efficacy / facts. Sources with no kind are
 * not counted either way; no known kinds at all ⇒ false (never assume a knowledge answer).
 */
export function knowledgeKindSourcesDominate(
  sources: readonly Pick<RetrievedSourceMeta, 'documentKind'>[],
): boolean {
  let known = 0;
  let knowledge = 0;
  for (const source of sources) {
    const kind = source.documentKind?.toLowerCase();
    if (!kind) continue;
    known += 1;
    if (kind === 'knowledge') knowledge += 1;
  }
  return known > 0 && knowledge * 2 > known;
}

/**
 * B0-871 — re-derive the WHOLE sentence a snippet came from, so the redaction removes the full
 * sentence and never leaves its tail (or, for a TOKEN-shaped snippet, its head) behind. Uses the
 * same sentence boundary `validator.ts`'s `splitIntoSentences` uses — B0-971: built from the shared
 * `REGULATED_CLAIM_SENTENCE_BOUNDARY_SOURCE` (end punctuation + whitespace + capital/digit, with
 * the `Reg.`/`No.`/`oz.`/… abbreviation guard) plus a newline, so the two can never disagree about
 * where a sentence ends.
 *
 * B0-1000 — scans BACKWARD for the sentence start too, not just forward for its end. A
 * sentence-shaped snippet (`s.slice(0, 240)`) already begins at its sentence's own start, so this
 * is a no-op for it; a TOKEN-shaped snippet (an EPA number, dilution ratio, contact time, CAS
 * number) sits somewhere INSIDE a sentence, and without the backward scan its containing sentence
 * could never be located — the caller could only splice the number itself, leaving it printed right
 * next to whatever replaced it.
 *
 * The snippet is located as a LITERAL substring of `text`, searched from `fromIndex` (so a caller
 * can walk every occurrence when the same snippet text appears more than once); `null` when no
 * further occurrence exists (a sentence that cannot be found verbatim cannot be removed verbatim,
 * and rephrasing is not an option — see `planRegulatedClaimRedaction` for what the caller does then).
 */
export function expandRegulatedClaimSnippetToSentence(
  text: string,
  snippet: string,
  fromIndex = 0,
): string | null {
  const start = text.indexOf(snippet, fromIndex);
  if (start < 0 || snippet.length === 0) return null;
  const boundarySource = `${REGULATED_CLAIM_SENTENCE_BOUNDARY_SOURCE}|\\n`;
  const backward = new RegExp(boundarySource, 'g');
  let sentenceStart = 0;
  let boundaryMatch: RegExpExecArray | null;
  while ((boundaryMatch = backward.exec(text)) !== null) {
    const boundaryEnd = boundaryMatch.index + boundaryMatch[0].length;
    if (boundaryEnd > start) break;
    sentenceStart = boundaryEnd;
  }
  const forward = new RegExp(boundarySource, 'g');
  forward.lastIndex = start + snippet.length;
  const endMatch = forward.exec(text);
  const end = endMatch ? endMatch.index : text.length;
  return text.slice(sentenceStart, end).trim();
}

export type RegulatedClaimRedactionPlan =
  | {
      mode: 'decline';
      /** Why redaction was not applied; recorded on the gate's `effect`. */
      reason:
        | 'safety_critical_sentence_category'
        | 'nothing_grounded_to_keep'
        | 'product_usage_specific_question'
        | 'snippet_not_found_in_draft'
        | 'nothing_substantive_remains';
    }
  | {
      /** `token_redaction` is B0-829's path; `sentence_redaction` is B0-871's. */
      mode: 'token_redaction' | 'sentence_redaction';
      redactedText: string;
      withheldCategories: RegulatedClaimCategory[];
      /**
       * B0-985 — sentence-shaped snippets that could not be located verbatim in the draft and were
       * therefore NOT withheld (token redaction still applied). Empty on every expected path; a
       * non-empty list is a defect to investigate, surfaced on the gate record, never a decline.
       */
      unlocatedSnippets?: string[];
      /**
       * B0-1131 — every span actually removed: the verbatim sentence, its claim category, and the
       * evidence check that failed (`ungroundedDetails[].evidenceCheck`). The eval artifact for
       * "which span was removed, of what type, and why".
       */
      withheldSpans: Array<{ category: RegulatedClaimCategory; span: string; evidenceCheck: string }>;
    };

/**
 * B0-829 / B0-871 — decide whether the guardrail's rejection can be honoured by REDACTING the
 * ungrounded claim(s) out of the draft (keeping the rest) or must replace the whole draft with the
 * decline copy. Pure; the caller applies `validation` (approved=false, confidence ≤ 0.4,
 * requires_human_review=true) identically for both outcomes.
 *
 * Policy, in evaluation order:
 * 1. Any ungrounded `hazard` or `first_aid` ⇒ decline when the question is a safety / exposure
 *    question (`isSafetyOrExposureQuestion`); otherwise withheld sentence-by-sentence as in 3 (B0-1131).
 * 2. Every ungrounded category token-shaped (B0-829) and nothing else on the draft grounded ⇒
 *    decline (`nothing_grounded_to_keep`); otherwise withhold each token-shaped claim (mode
 *    `token_redaction`) — see B0-1000 below for HOW.
 * 3. Otherwise (some ungrounded `compatibility` / `efficacy_claim`, B0-871) ⇒ withhold each such
 *    sentence too (mode `sentence_redaction`), ONLY when the question is not product-usage-specific.
 *    A snippet that is not a verbatim substring of the draft ⇒ decline (never rephrase); if NOTHING
 *    could be redacted at all ⇒ decline (`snippet_not_found_in_draft`); if what remains after
 *    redaction is too thin (< `REGULATED_CLAIM_REDACTION_MIN_REMAINING_CHARS` letters/digits) ⇒
 *    decline (`nothing_substantive_remains`).
 *
 *    B0-947 — "product-usage-specific" needs ALL THREE of: a locked product line, retrieval that is
 *    NOT knowledge-kind dominated, and a message that actually READS like a usage/safety question
 *    (`hasUsageSafetyQuestionShape`). The first two alone were a broken proxy: a catalog-identity
 *    question ("Do you have a product called Hard as Nailz?") resolves a product line by
 *    construction and retrieves that product's label, so it scored as product-usage-specific and
 *    took the harshest outcome — one unverifiable compatibility sentence wiped an otherwise correct
 *    identity answer (golden run 61e80e45, row 2, scored 0.00). The question-shape term is what the
 *    B0-871 doc text always described and the implementation never checked.
 *
 * B0-1000 — EVERY ungrounded detail, token-shaped or sentence-shaped, is withheld at SENTENCE
 * granularity: the unverifiable figure is never printed, whether alone or "(marked …)" next to it —
 * the whole sentence it appears in is replaced by a bracketed `[… withheld — not verifiable against
 * a retrieved label]` marker (`regulatedClaimWithheldMarker`). Previously a token-shaped category
 * (EPA/DIN number, dilution ratio, contact time, CAS number) spliced `(unable to verify)` in place
 * of just the numeric snippet — leaving it printed next to a marker whenever a DIFFERENT, grounded
 * occurrence of the same claim category survived elsewhere in the draft (confirmed live on golden
 * items 220636ba/4291663f/866bcea6/6d2a7997: a verified "10 minutes" contact time stood right next
 * to another sentence's "(unable to verify)" for the same category). Sentence-shaped and
 * token-shaped details are processed in the SAME TWO PASSES as before — every
 * `REDACTABLE_SENTENCE_REGULATED_CATEGORIES` detail first, then every `TOKEN_SHAPED_REGULATED_CATEGORIES`
 * detail — so a sentence carrying both an ungrounded compatibility/efficacy claim AND an ungrounded
 * token is withheld once, under the sentence-shaped category's marker (order-independent regardless
 * of `grounding.ungroundedDetails`'s own order). A snippet whose containing sentence cannot be
 * re-located verbatim (or that was already consumed by a wider removal) is simply left as an
 * `unlocatedSnippets` entry — never invented, never left printed.
 *
 * Every replacement is a literal substring swap; nothing in the removed text is paraphrased,
 * rounded or re-stated in the output.
 *
 * B0-888 — the "consult the label or SDS" disclaimer appended below at this function's call site
 * is safe to append UNCONDITIONALLY whenever this planner returns `token_redaction` or
 * `sentence_redaction`: `evaluateRegulatedClaimGrounding`'s key-term/adjacent-quote fallback
 * (`validator.ts`) filters a sentence OUT of `ungroundedDetails` entirely before it ever reaches
 * `grounding.ungroundedCategories`/`ungroundedDetails`, so by construction this function is only
 * ever called with at least one detail that WILL be replaced below -- there is no path where a
 * redaction mode is chosen but zero markers end up in `redactedText`.
 */
export function planRegulatedClaimRedaction(input: {
  draftAnswer: string;
  /** B0-947 — the turn's user message; the third term of the product-usage-specific test. */
  userMessage: string;
  grounding: RegulatedClaimGroundingResult;
  productLineLock: ProductLineLock | null;
  sources: readonly Pick<RetrievedSourceMeta, 'documentKind'>[];
}): RegulatedClaimRedactionPlan {
  const { grounding } = input;
  const ungrounded = grounding.ungroundedCategories;
  const orderedWithheldCategories = [...new Set(ungrounded)].sort();

  // B0-1131 — an unverifiable hazard / first-aid sentence still declines the whole answer when the
  // QUESTION is about safety or exposure (there, that sentence is the answer, and a partial reply
  // could read as "no precaution needed"). On any other question it is withheld sentence-by-sentence
  // like `compatibility` / `efficacy_claim`, so it no longer erases unrelated, supported content
  // (live ROW-01: "Where do I find the SDS for Push?" lost its SDS-location answer).
  const safetySentencesRedactable = !isSafetyOrExposureQuestion(input.userMessage);
  const isSentenceRedactable = (c: RegulatedClaimCategory) =>
    REDACTABLE_SENTENCE_REGULATED_CATEGORIES.has(c) ||
    (safetySentencesRedactable && SAFETY_SENTENCE_REGULATED_CATEGORIES.has(c));

  if (ungrounded.some((c) => !TOKEN_SHAPED_REGULATED_CATEGORIES.has(c) && !isSentenceRedactable(c))) {
    return { mode: 'decline', reason: 'safety_critical_sentence_category' };
  }

  const allUngroundedAreTokenShaped = ungrounded.every((c) => TOKEN_SHAPED_REGULATED_CATEGORIES.has(c));
  // B0-829 — was some OTHER regulated-claim category (EPA reg, contact time, hazard, etc.) grounded
  // elsewhere in the draft? When true, a pure token-shaped rejection keeps its historical exemption
  // from the substantive-remaining-content bar below (a short-but-complete answer, e.g. a
  // two-sentence dilution + contact-time answer where only the contact time was unverifiable, should
  // not have to clear a character count).
  const hasGroundedCategoryWorthKeeping = grounding.categoriesDetected.some(
    (c) => !ungrounded.includes(c),
  );

  if (!allUngroundedAreTokenShaped) {
    // B0-871 — sentence redaction is for KNOWLEDGE answers only. A USAGE question about an
    // identified product whose retrieval is label/SDS-led keeps the full decline: there, a
    // compatibility or efficacy sentence is a claim about that product's own label.
    // B0-947 — the question-shape term; without it an identity/catalog question qualified too.
    // `hasUsageSafetyQuestionShape` alone is too narrow here: it is B0-872's predicate, tuned for
    // "how do I use / is it safe", and it does NOT match "is X compatible with bleach", "can I mix
    // X with bleach", or "what surfaces is X approved for" — all of which ask about this product's
    // own label claims and must keep the full decline, not lose one sentence to a redaction.
    const asksAboutThisProductsLabelClaims = (userMessage: string) =>
      /\b(compatible|compatibility|mix|mixed|mixing|approved for|approved surfaces|what surfaces|rated for|listed for)\b/.test(
        userMessage.toLowerCase(),
      );
    const productUsageSpecific =
      Boolean(input.productLineLock?.lockedProductLineKey) &&
      !knowledgeKindSourcesDominate(input.sources) &&
      (hasUsageSafetyQuestionShape(input.userMessage) ||
        asksAboutThisProductsLabelClaims(input.userMessage));
    if (productUsageSpecific) {
      return { mode: 'decline', reason: 'product_usage_specific_question' };
    }
  }

  /**
   * B0-985 / B0-1000 — sentence-shaped details FIRST, each located against the ORIGINAL draft, then
   * token-shaped details, so a sentence carrying both never orphans one category's snippet after
   * the other category already removed it. Each detail's snippet may occur more than once in the
   * draft (`checkTokenCategory` in `validator.ts` dedupes identical literal token text into one
   * detail even when it appears in several sentences), so every occurrence is walked and its own
   * containing sentence withheld — not just the first. A sentence already withheld for one category
   * (or one occurrence) is left alone the next time it is reached.
   */
  let redactedText = input.draftAnswer;
  const removedSentences = new Set<string>();
  const unlocatedSnippets: string[] = [];
  const withheldSpans: Array<{ category: RegulatedClaimCategory; span: string; evidenceCheck: string }> = [];

  const withholdPass = (matchesCategory: (category: RegulatedClaimCategory) => boolean) => {
    for (const detail of grounding.ungroundedDetails) {
      if (!matchesCategory(detail.category)) continue;
      let matchedAnyOccurrence = false;
      let searchFrom = 0;
      for (;;) {
        const occurrenceIndex = input.draftAnswer.indexOf(detail.snippet, searchFrom);
        if (occurrenceIndex < 0) break;
        matchedAnyOccurrence = true;
        searchFrom = occurrenceIndex + detail.snippet.length;
        const sentence = expandRegulatedClaimSnippetToSentence(
          input.draftAnswer,
          detail.snippet,
          occurrenceIndex,
        );
        if (!sentence || removedSentences.has(sentence) || !redactedText.includes(sentence)) {
          continue;
        }
        removedSentences.add(sentence);
        withheldSpans.push({
          category: detail.category,
          span: sentence,
          evidenceCheck: detail.evidenceCheck ?? 'unspecified',
        });
        redactedText = redactedText.replaceAll(sentence, regulatedClaimWithheldMarker(detail.category));
      }
      if (!matchedAnyOccurrence) {
        unlocatedSnippets.push(detail.snippet);
      }
    }
  };
  withholdPass(isSentenceRedactable);
  withholdPass((category) => TOKEN_SHAPED_REGULATED_CATEGORIES.has(category));

  if (redactedText === input.draftAnswer) {
    // Nothing at all could be located, so nothing was redacted; serving the untouched draft under a
    // "withheld" footer would misstate what was done. Not reachable when the details came from
    // `evaluateRegulatedClaimGrounding` on this same draft.
    return { mode: 'decline', reason: 'snippet_not_found_in_draft' };
  }
  if (unlocatedSnippets.length > 0) {
    console.warn(
      `[regulated-claim-guardrail] ${unlocatedSnippets.length} snippet(s) not found verbatim in the draft; other redaction(s) still applied`,
      { snippets: unlocatedSnippets },
    );
  }

  // B0-971 — two withheld bullets in a row read "[one efficacy claim withheld …]" twice; merged into
  // one pluralised marker ("[two efficacy claims withheld …]").
  redactedText = mergeRepeatedRegulatedClaimWithheldMarkers(redactedText);

  // B0-1000 — the minimum-remaining-content bar is skipped only for a PURE token-shaped case where
  // `hasGroundedCategoryWorthKeeping` is true (something else on the draft WAS grounded and is
  // worth keeping): withholding just the one sentence that made an ungrounded numeric claim should
  // not ALSO have to clear a character count, or a short-but-otherwise-fine answer (e.g. a
  // two-sentence dilution + contact-time answer where only the contact time was unverifiable) would
  // decline outright over one sentence.
  //
  // B0-1024 — a PURE token-shaped case with NO other grounded category previously declined before
  // ever attempting redaction (see the removed early return above), discarding substantial
  // non-regulated-claim content (e.g. a full product-recommendation list) that has nothing to do
  // with the flagged claim. It now reaches this same bar instead: redact, then decline only if what
  // remains is too thin to be a real answer.
  if (!allUngroundedAreTokenShaped || !hasGroundedCategoryWorthKeeping) {
    const remaining = stripRegulatedClaimWithheldMarkers(redactedText);
    if (countSubstantiveContentChars(remaining) < REGULATED_CLAIM_REDACTION_MIN_REMAINING_CHARS) {
      return {
        mode: 'decline',
        reason: allUngroundedAreTokenShaped ? 'nothing_grounded_to_keep' : 'nothing_substantive_remains',
      };
    }
  }

  return {
    mode: allUngroundedAreTokenShaped ? 'token_redaction' : 'sentence_redaction',
    redactedText,
    withheldCategories: orderedWithheldCategories,
    withheldSpans,
    ...(unlocatedSnippets.length > 0 ? { unlocatedSnippets } : {}),
  };
}

/**
 * B0-368 — closed set of human-review discriminators. All 219 historical
 * `review_requested` audit rows had `reason: null`, so a reviewer opening a trace
 * got a red item with no headline.
 *
 * The vocabulary is the one the `review_tasks` table already uses
 * (`regulated_claim_unverified` × 208, `validator_rejected` × 12), extended with
 * `revision_refused` for the `revision_skipped_refusal` path — a second spelling for
 * the same states would have split every existing triage query.
 */
export const REVIEW_REQUEST_REASONS = [
  /** The B0-257 regulated-claim guardrail could not verify a regulated value. */
  'regulated_claim_unverified',
  /** The revision pass refused to re-ground the flagged claims (`revision_skipped_refusal`). */
  'revision_refused',
  /** The validator disapproved and nothing more specific applies. */
  'validator_rejected',
] as const;

export type ReviewRequestReason = (typeof REVIEW_REQUEST_REASONS)[number];

/**
 * Most specific cause wins: the guardrail is a hard regulated-data rejection, a
 * refused revision is a distinct model behaviour, and everything else is the generic
 * validator rejection.
 */
export function resolveReviewRequestReason(input: {
  hasUngroundedRegulatedClaim: boolean;
  revisionPassRefused: boolean;
}): ReviewRequestReason {
  if (input.hasUngroundedRegulatedClaim) {
    return 'regulated_claim_unverified';
  }
  if (input.revisionPassRefused) {
    return 'revision_refused';
  }
  return 'validator_rejected';
}

function buildComparableBetcoProductMarkdownLine(match: CrossReferenceMatch): string | null {
  const link = match.productUrl?.trim();
  if (!link) {
    return null;
  }
  const title = resolveCrossReferenceComparableTitle(match);
  return `Comparable Betco product: [${title}](${link})`;
}

function assistantAlreadyStartsWithComparableLink(text: string): boolean {
  const firstLine = text.trimStart().split('\n')[0]?.trim() ?? '';
  return /^Comparable Betco product:\s*\[[^\]]+\]\([^)]+\)\s*$/.test(firstLine);
}

/**
 * When cross-reference returns a URL, the first line must be the markdown comparable line.
 * If the model also produced usage/safety text (after forced RAG), keep it below that line.
 */
/**
 * Decline/refusal markers. When the model declines (e.g. the cross_reference agent's
 * sub-threshold "contact a Betco sales representative" reply, or the product agent's
 * low-confidence line), we must NOT staple a "Comparable Betco product" headline on top —
 * that produced the contradictory BNC-15 output (a wrong-chemistry product link above a decline).
 */
const DECLINE_ANSWER_MARKERS = [
  "don't have enough information",
  'do not have enough information',
  "don't have enough verified information",
  'do not have enough verified information',
  'contact a betco sales representative',
  'contact a sales representative',
];

export function isDeclineAnswer(text: string): boolean {
  const lower = text.toLowerCase();
  return DECLINE_ANSWER_MARKERS.some((marker) => lower.includes(marker));
}

function composeCrossReferenceUserFacingAnswer(input: {
  match: CrossReferenceMatch;
  assistantText: string;
}): string {
  const headline = buildComparableBetcoProductMarkdownLine(input.match);
  const raw = input.assistantText.trim();

  if (!headline) {
    return raw;
  }

  // A declined answer stands on its own — never prepend a comparable-product headline.
  if (isDeclineAnswer(raw)) {
    return raw;
  }

  if (!raw) {
    return buildCrossReferenceAnswerShortOnly(input.match);
  }

  if (assistantAlreadyStartsWithComparableLink(raw)) {
    return raw;
  }

  return `${headline}\n\n${raw}`;
}

/** Short reply when no enriched body is available (no RAG synthesis). */
function buildCrossReferenceAnswerShortOnly(match: CrossReferenceMatch) {
  const title = resolveCrossReferenceComparableTitle(match);
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
  const productName = resolveCrossReferenceComparableTitle(input.crossReferenceMatch).slice(
    0,
    256,
  );

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
    productName,
    topic,
  };
}

/**
 * B0-389 — the `{ prompt }` fragment for a step's `input`, spread in at INSERT time: all three
 * prompts are known before their step row exists, so nothing needs to update `input` later.
 *
 * `parse` rather than `safeParse` — the record is constructed here from local values, so a shape
 * mismatch is a bug in this file, not untrusted data.
 */
export function recordPrompt(record: PromptRecord): { prompt: PromptRecord } {
  return { prompt: promptRecordSchema.parse(record) };
}

/**
 * B0-391 — the `{ gates }` fragment for a step's `output`.
 *
 * Returns `{}` for an empty list, so a gate that did NOT run is ABSENT from the persisted row
 * rather than present-and-empty (an empty array reads as "evaluated, nothing to say", which is a
 * different claim). `parse`, like `recordPrompt`: these records are built from local values, so a
 * shape mismatch is a bug in this file.
 */
export function recordGates(records: readonly GateRecord[]): { gates?: GateRecord[] } {
  if (records.length === 0) {
    return {};
  }
  return { gates: records.map((record) => gateRecordSchema.parse(record)) };
}

/**
 * B0-554 — sums per-call usage into one totals object, the same shape `openai_responses_agent`
 * already persists as `usage` alongside its own `usageByCall`. Used by the `validator` step, which
 * can call the model once (a plain approval/rejection) or twice (approval, then a second pass after
 * the revision model rewrote the draft) — both calls' usage must be attributed to the one step row.
 */
export function sumLlmUsage(calls: readonly LlmTokenUsage[]): LlmTokenUsage {
  return calls.reduce(
    (acc, call) => ({
      promptTokens: acc.promptTokens + call.promptTokens,
      completionTokens: acc.completionTokens + call.completionTokens,
      totalTokens: acc.totalTokens + call.totalTokens,
      cachedPromptTokens: acc.cachedPromptTokens + call.cachedPromptTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
  );
}

/**
 * B0-389 — the single spelling for "the validator pass did not run". The bypassed path used to say
 * `reason: 'temporary_test_bypass'` on the step while putting `validator_bypassed_for_testing` in
 * `validation.issues`, so the same state had two names. The issues token is load-bearing (the
 * observability timeline's `validator_bypass` gate keys off it), so it is the one that survives.
 */
export const VALIDATOR_BYPASS_REASON = 'validator_bypassed_for_testing';

/**
 * B0-546 — the single spelling for "the validator pass was skipped because retrieval already
 * found a near-exact match on a non-safety route", distinct from `VALIDATOR_BYPASS_REASON` (the
 * admin `useValidator` toggle being off). Kept separate so the observability timeline can tell
 * the two skip reasons apart instead of conflating "never asked for the validator" with "asked
 * for it, but the confidence gate decided it wasn't needed this turn".
 */
export const VALIDATOR_SKIP_HIGH_SIMILARITY_REASON =
  'validator_skipped_high_similarity_non_safety_route';

/**
 * B0-546 — minimum top-source retrieval similarity required to skip the validator's LLM pass
 * entirely on a non-safety route. Deliberately high: this bypasses the one LLM check that catches
 * a hallucinated/unsupported claim, so it only fires when retrieval already found a near-exact
 * match. Configurable via `BEX_VALIDATOR_SKIP_MIN_SIMILARITY` without a redeploy; falls back to
 * the default on anything that is not a finite number in (0, 1].
 */
export const DEFAULT_VALIDATOR_SKIP_MIN_SIMILARITY = 0.85;

export function resolveValidatorSkipMinSimilarity(): number {
  const raw = process.env.BEX_VALIDATOR_SKIP_MIN_SIMILARITY;
  if (!raw) {
    return DEFAULT_VALIDATOR_SKIP_MIN_SIMILARITY;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1
    ? parsed
    : DEFAULT_VALIDATOR_SKIP_MIN_SIMILARITY;
}

/** Kill switch: `BEX_VALIDATOR_SKIP_ENABLED=false` disables the B0-546 skip gate without a redeploy. */
export function isValidatorSkipEnabled(): boolean {
  return process.env.BEX_VALIDATOR_SKIP_ENABLED !== 'false';
}

/**
 * B0-546 — routes considered safety-sensitive enough that the validator pass must never be
 * skipped purely on retrieval-similarity grounds: usage/safety/dilution-shaped questions
 * (`hasUsageSafetyLexicalSignal` — B0-872 split this off from the usage/safety coverage gate's own
 * trigger so that narrowing the gate did not also let dilution-shaped questions skip validation;
 * this predicate is the pre-B0-872 one, unchanged), the dedicated `dilution` SME (dilution ratios
 * are inherently regulated per the org's regulated-data rule), and `cross_reference` (an
 * equivalence claim between an EPA-registered competitor product and a Betco one).
 */
export function isSafetySensitiveRoute(userMessage: string, decision: string): boolean {
  return (
    hasUsageSafetyLexicalSignal(userMessage) ||
    decision === 'dilution' ||
    decision === 'cross_reference'
  );
}

/**
 * B0-386 — `error.reason` written on a step that was still `running` but is not the step the
 * throw came from, so a trace reader can tell "this is where it broke" from "this never got to
 * run". Steps must never be left `running` once the workflow returns or throws.
 */
export const ABANDONED_WORKFLOW_STEP_REASON = 'abandoned_after_workflow_failure';

/**
 * B0-386 — fail the steps that were still open when the workflow threw.
 *
 * The failure handler used to mark the agent step `failed` unconditionally, which flipped an
 * already-completed agent step back to `failed` and nulled its persisted `toolTrace`, while the
 * step that actually threw (usually `validator`) was left `running` forever. Only steps still
 * open are touched here, and the most recently opened one — the step the throw came from — gets
 * the error message.
 */
export async function failOpenWorkflowSteps(
  openStepIds: readonly string[],
  message: string,
  /**
   * B0-390 — output to write on a still-open step as it is failed, keyed by step id. Used to keep
   * the partial tool trace of a run that threw mid-generation, which is exactly the run worth
   * inspecting. Only ever ADDS an output to a step that is still open (and therefore has none):
   * B0-386's rule holds — a step that already completed is not in `openStepIds`, and any step with
   * no entry here has the `output` key omitted from its patch rather than nulled.
   */
  partialOutputByStepId: ReadonlyMap<string, Json> = new Map(),
): Promise<void> {
  const mostRecentFirst = [...openStepIds].reverse();
  for (const [index, stepId] of mostRecentFirst.entries()) {
    const partialOutput = partialOutputByStepId.get(stepId);
    await completeWorkflowStep(stepId, {
      status: 'failed',
      error: jsonContent(
        index === 0
          ? { message }
          : { message, reason: ABANDONED_WORKFLOW_STEP_REASON },
      ),
      ...(partialOutput !== undefined ? { output: partialOutput } : {}),
    });
  }
}

export async function runProductSupportWorkflow(input: {
  traceId: string;
  conversationId: string;
  userMessage: string;
  /**
   * B0-416 — entry point that started this run, persisted on `workflow_runs.source`. Required
   * (not defaulted) so a new caller cannot silently inherit another caller's provenance: the
   * column is the only record of where a run came from, and `/admin/observability` filters on it.
   */
  source: RunSource;
  modelTag?: string;
  useValidator?: boolean;
  agentMode?: BexChatAgentMode;
  /** B0-681 — see `RouterTypeOverride`. Absent everywhere except the test-run workbench. */
  routerTypeOverride?: RouterTypeOverride;
  priorMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  onEvent?: (event: ProductSupportWorkflowEvent) => void;
  onAssistantDelta?: (delta: string) => void;
}): Promise<ProductSupportFinalOutput> {
  const model = await resolveModel(input.modelTag);
  /**
   * B0-519 — capped once, up front, so every consumer (the `historyCapApplied` step record below
   * and the generation loop further down) agrees on the same decision for this turn. See
   * `capConversationHistory`. Generation is stateless (B0-914): this capped tail is the whole
   * conversation memory the model sees.
   */
  const { cappedHistory, historyCapApplied } = capConversationHistory(input.priorMessages ?? []);
  const agentMode = input.agentMode ?? DEFAULT_BEX_CHAT_AGENT_MODE;
  const route = routeUserMessageToSme(input.userMessage);
  // B0-389 — read once so the flag recorded as run config is the same value the gate below used.
  const earlyDeclineGateEnabled = await isEarlyDeclineGateEnabled();
  /**
   * B0-389/B0-649 — every routing flag is read ONCE here and reused for both the decision and the
   * recorded run config, for the same reason `earlyDeclineGateEnabled` is (above): a second read
   * could resolve differently (the `settings` cache expires mid-turn, or an admin flips a row) and
   * the persisted trace would then describe a configuration the turn never ran under.
   *
   * Resolved CONCURRENTLY rather than as four sequential awaits: each getter is a `settings` row
   * read behind a 30s cache, so on a cold cache four awaits in series put four Postgres
   * round-trips on the critical path of every turn — a latency regression in the one epic whose
   * whole point is removing latency from routing. `Promise.all` also means the two LLM flags are
   * now always both read (previously `isLlmRouterShadowMode()` was short-circuited away when the
   * router was disabled), which is what the gate record wants anyway: the recorded config should
   * describe both levers, not leave one undefined because of evaluation order.
   */
  const [
    llmRouterEnabledFromSettings,
    llmRouterShadowModeFromSettings,
    semanticRouterEnabledFromSettings,
    semanticRouterShadowModeFromSettings,
    // B0-786 — read HERE, with the other routing flags, for the reason documented above: a second
    // read can resolve differently mid-turn (the 30s settings cache expires, or an admin flips the
    // row) and the persisted trace would then describe a configuration the turn never ran under.
    signalsAnalysisEnabled,
    // B0-786 — the router model/timeout are `settings` rows now, so they are resolved once here
    // too and reused by every gate record below rather than re-read per record.
    routerModel,
    routerTimeoutMs,
  ] = await Promise.all([
    isLlmRouterEnabled(),
    isLlmRouterShadowMode(),
    isSemanticRouterEnabled(),
    isSemanticRouterShadowMode(),
    isSignalsAnalysisEnabled(),
    resolveRouterModel(),
    resolveRouterTimeoutMs(),
  ]);

  /**
   * B0-681 — `routerTypeOverride` supersedes the `settings`-table rollout levers for this turn
   * only. Forcing one router also forces the OTHER router off (rather than leaving it to the
   * settings value), so a degraded `semantic`/`llm` override falls straight to the keyword floor
   * instead of silently picking up whatever the live settings happen to say — see the type doc.
   */
  const routerTypeOverride = input.routerTypeOverride;
  const llmRouterEnabled = routerTypeOverride
    ? routerTypeOverride === 'llm'
    : llmRouterEnabledFromSettings;
  const llmRouterShadowMode = routerTypeOverride ? false : llmRouterShadowModeFromSettings;
  const semanticRouterEnabledSetting = routerTypeOverride
    ? routerTypeOverride === 'semantic'
    : semanticRouterEnabledFromSettings;
  const semanticRouterShadowModeSetting = routerTypeOverride
    ? false
    : semanticRouterShadowModeFromSettings;

  /**
   * B0-649 — the semantic router's three-state rollout (see `semantic-router-decision.ts` for the
   * full precedence contract):
   *   `live`   — the semantic router decides; on `path: 'fallback'` the turn degrades to the
   *              PRE-EXISTING chain (LLM classifier if enabled → keyword agent → `'ambiguous'`).
   *   `shadow` — it runs and is logged, but the LLM/keyword routers still decide.
   *   `off`    — never called; the code below is byte-identical to the pre-B0-649 path.
   *
   * `classifyUserIntentSemantic` shares `classifyUserIntent`'s safety contract: it never throws and
   * degrades to `path: 'fallback'`, so this await cannot fail the turn.
   *
   * The call is AWAITED here in shadow mode too, rather than raced against the tool loop the way
   * the B0-507 LLM shadow gate is. That is deliberate: B0-511 learned the hard way that a
   * concurrent shadow call hides its own latency and timeouts (`intent-classifier.ts`'s
   * `DEFAULT_BEX_ROUTER_TIMEOUT_MS` comment), so a shadow stage measured that way cannot answer the
   * one question the B0-653 cutover turns on. Shadow mode therefore pays the router's real latency,
   * which is exactly what it is there to measure.
   */
  const semanticRouterMode = resolveSemanticRouterMode({
    enabled: semanticRouterEnabledSetting,
    shadowMode: semanticRouterShadowModeSetting,
    agentMode,
  });
  const priorTurnsForRouting = cappedHistory.map(
    (m, index): PriorTurnMessage => ({
      id: String(index),
      role: m.role,
      content: m.content,
    }),
  );
  const semanticRouteDecision: SemanticRouteDecision | null =
    semanticRouterMode === 'off'
      ? null
      : await classifyUserIntentSemantic(input.userMessage, priorTurnsForRouting);
  /** Non-null only when the semantic router genuinely decided this turn (mode `live` + `path: 'semantic'`). */
  const semanticRoute: IntentValue | null = resolveSemanticRoute(
    semanticRouterMode,
    semanticRouteDecision,
  );

  /**
   * B0-511 — the routing cutover: when the LLM router is enabled AND shadow mode is off (both the
   * defaults since 2026-08-18), the classifier's own intent becomes this turn's `routingDecision`
   * instead of the keyword router's. `classifyUserIntent` is the safety net here (see
   * `intent-classifier.ts`): disabled, timeout, or any LLM error all degrade to an `ambiguous`
   * fallback internally and it never throws, so this await cannot fail the turn. Only applies in
   * `orchestrator` mode — a forced direct `agentMode` bypasses routing entirely, same as it always
   * has (and never spends a classifier call).
   *
   * B0-653 — `&& semanticRoute === null` is the cutover itself: once the semantic router has
   * decided, the LLM classifier is NOT CALLED AT ALL (no model call, no token spend, no ~1.5s
   * synchronous wait). It is still reached on a semantic FALLBACK, which is the whole point of
   * degrading to the old chain rather than to `'ambiguous'`.
   */
  const llmRouterCutoverActive =
    agentMode === 'orchestrator' && llmRouterEnabled && !llmRouterShadowMode;
  const llmClassifierWillDecide = llmRouterCutoverActive && semanticRoute === null;
  // Wall time this turn actually paid waiting on the classifier (a cache hit legitimately reads
  // ~0ms) — recorded on the live gate so the observability page answers the latency question the
  // cutover decision traded on, without needing server logs.
  const liveClassifierStartedAtMs = Date.now();
  /**
   * B0-786 — the consolidated signals call takes the classifier's precedence position exactly: it
   * runs when, and only when, `classifyUserIntent` would have run, and its `intent`/`confidence`
   * are the same routing decision. It answers eight more questions in the same call (competitor
   * identity, cross-reference intent, chemistry/conversion-list, answer shape, decline class,
   * regulated-section intent) that were previously spread across nine sites, plus the second LLM
   * call `extractCompetitorProduct` used to make for a competitor identity this call already has.
   *
   * `analyzeTurnSignals` shares `classifyUserIntent`'s never-throws contract, so this await cannot
   * fail the turn; a degraded result carries the keyword router's decision.
   */
  const turnSignals: TurnSignals | null =
    llmClassifierWillDecide && signalsAnalysisEnabled
      ? await analyzeTurnSignals(input.userMessage, priorTurnsForRouting)
      : null;
  /** True only when the model call actually ran and parsed — a degraded turn must keep the old deterministic checks. */
  const signalsDecided = turnSignals !== null && turnSignals.source === 'llm';
  const liveIntentClassification: IntentClassification | null = turnSignals
    ? toIntentClassification(turnSignals)
    : llmClassifierWillDecide
      ? await classifyUserIntent(input.userMessage, priorTurnsForRouting)
      : null;
  const liveClassifierLatencyMs = Date.now() - liveClassifierStartedAtMs;
  /**
   * B0-514 — the turn's single cross-reference-intent verdict, consumed by every downstream site
   * that used to call `shouldForceCrossReferenceLookup` (early-decline suppression, the pinned
   * round-0 `tool_choice`, `forcedCrossReference`). When the classifier genuinely ran (`source:
   * 'llm'`), its judgment decides: intent `cross_reference` is strictly competitor cross-reference
   * post-cutover, and a cross-reference `suggestedTool` catches equivalence asks that routed to
   * another specialist (B0-339). The substring check survives only for turns the classifier did
   * not decide (kill-switch, shadow mode, or a degraded fallback), preserving the old world there.
   *
   * B0-649 — when the SEMANTIC router decided the turn, its route label is the only signal it
   * offers (`SemanticRouteDecision` has no `suggestedTool` counterpart), so the keyword substring
   * check is kept as an OR rather than dropped. That is deliberately the conservative direction:
   * it cannot lose a cross-reference the old world would have caught, at the cost of keeping the
   * substring check's known false positives on this path. See `src/docs/semantic-router-cutover.md`.
   *
   * B0-751 — this is now the PRELIMINARY verdict: the routers' own opinion, before the competitor
   * self-reference check below has looked at WHO the "competitor" is. `crossReferenceIntentForTurn`
   * (the value every downstream site consumes) is derived from it further down.
   */
  const preliminaryCrossReferenceIntentForTurn = semanticRoute
    ? semanticRoute === 'cross_reference' || shouldForceCrossReferenceLookup(input.userMessage)
    : // B0-786 — the signals call answers this directly, replacing `shouldForceCrossReferenceLookup`
      // on the deciding path. A DEGRADED signals result already carries that same substring check
      // as its `crossReferenceIntent` (see `fallbackTurnSignals`), so reading it unconditionally
      // here preserves the pre-B0-786 behaviour on the degraded path too.
      turnSignals
      ? turnSignals.crossReferenceIntent
      : liveIntentClassification && liveIntentClassification.source === 'llm'
      ? liveIntentClassification.intent === 'cross_reference' ||
        // B0-734 — a cross-reference `suggestedTool` only counts when the classifier also extracted
        // a competitor. On the 2026-08-28 re-runs the classifier suggested a cross-reference tool
        // for job questions it had routed to `recommendations` ("why is my VCT flooring dull"),
        // which made the whole message the "competitor product", ran the prefetch and the B0-355
        // backstop, and replaced the specialist's draft with the engine's template or its decline
        // (six answers scoring 1 to 31). A genuine equivalence ask that routed elsewhere (B0-339)
        // still carries the competitor entity, so it still forces the lookup.
        ((liveIntentClassification.suggestedTool === 'lookup_cross_reference' ||
          liveIntentClassification.suggestedTool === 'recommend_cross_reference') &&
          Boolean(
            liveIntentClassification.entities.competitorBrand ||
              liveIntentClassification.entities.competitorProduct,
          ))
      : shouldForceCrossReferenceLookup(input.userMessage);
  /**
   * B0-649 — precedence: semantic router (when it decided) → LLM classifier → keyword agent →
   * `'ambiguous'`. The value space is unchanged (`IntentValue`), because everything downstream
   * (`buildProductSupportInstructions`, `buildProductSupportPromptCacheKey`,
   * `productSupportToolsForRoute`, `effectivePromptIdForDecision`, `computePromptVersion`, the
   * cross-reference gating) is keyed on it.
   *
   * B0-751 — preliminary for the same reason as the intent verdict above; `routingDecision` is
   * finalised below once the self-reference check has run.
   */
  const preliminaryRoutingDecision =
    agentMode === 'orchestrator'
      ? (semanticRoute ?? liveIntentClassification?.intent ?? route.agent ?? 'ambiguous')
      : agentMode;

  /**
   * B0-751 — competitor self-reference check. The routers decide WHETHER a turn is a competitor
   * cross-reference from its phrasing; nothing before this point asked WHO the competitor is. On
   * the fada7fde eval run the "competitor" was a Betco product (Speedex, Grease Solv, Triforce), a
   * chemistry ("bleach") or a whole-catalog conversion ask, and because the cross-reference verdict
   * alone pinned `tool_choice`, ran the prefetch and the B0-355 backstop, the B0-356 engine gate
   * replaced the specialist's draft with the engine's decline (answers scoring 6-61). The B0-734
   * prompt text already says these are not cross-references, but the workflow decided before the
   * model ran.
   *
   * Evaluated ONCE, only for turns that would otherwise be cross-reference (the routers' verdict
   * above, or a `cross_reference` route from any router), and only in `orchestrator` mode — a
   * forced direct specialist is an explicit operator choice this check must not second-guess.
   * Competitor identity comes from the classifier's own entities when it extracted any; otherwise
   * `extractCompetitorProduct` is awaited HERE and its promise is reused as
   * `resolvedCompetitorPromise` below, so the turn never pays for a second extraction call
   * (B0-357: one competitor identity per turn). That await is the one latency cost this adds, and
   * only on turns that already run the extraction — it moves the call ahead of the tool loop
   * instead of alongside it. The message-only conversion-list rule is checked first so those turns
   * skip the extraction entirely. The resolver is the freeform-mode alias lookup (exact + tokenized
   * tiers only, no trigram): a genuine competitor name must never fuzzy-match a Betco alias.
   *
   * When suppressed, `crossReferenceIntentForTurn` is false and a `cross_reference` route becomes
   * `product` — the product policy carries the shared "Comparing Betco products to each other"
   * section — so `forcedToolChoiceName`, the prefetch, `competitorIdentityNeeded`,
   * `useCrossReferencePostProcessing`, `decideXrefBackstop` and the engine gate all fall through
   * on their existing conditions. `routingDecidedBy` is left alone (the router did decide; this
   * check overrode it) — the override is recorded on `activeGates.crossReferenceSelfReference` and
   * the `cross_reference_self_reference_suppressed` audit row instead.
   */
  const crossReferenceCandidate =
    agentMode === 'orchestrator' &&
    (preliminaryCrossReferenceIntentForTurn || preliminaryRoutingDecision === 'cross_reference');
  const classifierCompetitorBrand = liveIntentClassification?.entities.competitorBrand ?? null;
  const classifierCompetitorProduct = liveIntentClassification?.entities.competitorProduct ?? null;
  /**
   * B0-786 — on the signals path there is NOTHING to extract: the one call already produced the
   * competitor brand/product/other, which is the duplicate LLM call this ticket removes.
   */
  const earlyCompetitorExtractionPromise: Promise<ExtractedCompetitor> | null =
    !turnSignals &&
    crossReferenceCandidate &&
    !classifierCompetitorBrand &&
    !classifierCompetitorProduct &&
    !isConversionListAsk(input.userMessage)
      ? extractCompetitorProduct(input.userMessage)
      : null;
  const earlyExtractedCompetitor = earlyCompetitorExtractionPromise
    ? await earlyCompetitorExtractionPromise
    : null;
  /**
   * B0-786 — `analyzeTurnSignals` already ran this check as its deterministic enrichment step,
   * reusing the competitor identity above; re-running it here would repeat the alias/catalog
   * lookups for the same identity.
   */
  const selfReferenceVerdict: CompetitorSelfReferenceVerdict | null = turnSignals
    ? turnSignals.selfReferenceVerdict
    : crossReferenceCandidate
    ? await classifyCompetitorSelfReference({
        userMessage: input.userMessage,
        competitorBrand: classifierCompetitorBrand ?? earlyExtractedCompetitor?.brand ?? null,
        competitorProduct:
          classifierCompetitorProduct ?? earlyExtractedCompetitor?.product ?? null,
        // B0-751 follow-up — the curated alias table and the catalog disagree about what exists,
        // so ask both. The alias tiers give a product line when they can; catalog membership
        // answers "is this ours at all" for the many names with no alias row.
        resolveBetcoEntity: async (name) => {
          const [resolution, catalog] = await Promise.all([
            resolveProductEntityByName(name, { mode: 'freeform' }),
            matchBetcoProductName(name),
          ]);
          return {
            productLineKey: resolution.productLineKey,
            ambiguousAlias: resolution.ambiguousAlias,
            catalogMatch: catalog.matched,
            catalogProductLineKey: catalog.productLineKey,
          };
        },
      })
    : null;
  const selfReferenceSuppressed = selfReferenceVerdict?.suppressed === true;
  /** B0-514 — the turn's single cross-reference-intent verdict (see the preliminary value above). */
  const crossReferenceIntentForTurn = selfReferenceSuppressed
    ? false
    : preliminaryCrossReferenceIntentForTurn;
  const routingDecision =
    selfReferenceSuppressed && preliminaryRoutingDecision === 'cross_reference'
      ? 'product'
      : preliminaryRoutingDecision;
  const crossReferenceSelfReferenceActivation: GateActivationRecord = !selfReferenceVerdict
    ? { state: 'not_applicable' }
    : selfReferenceVerdict.suppressed
      ? {
          state: 'ran',
          verdict: 'suppressed',
          reason: `${selfReferenceVerdict.reason}:${selfReferenceVerdict.matched}`.slice(0, 256),
        }
      : { state: 'ran', verdict: 'passed' };
  const earlyDeclineDecision = earlyDeclineGateEnabled
    ? classifyEarlyDecline(input.userMessage, {
        crossReferenceIntent: crossReferenceIntentForTurn,
        // B0-786 — supplied ONLY when the model call really produced a class; a degraded turn omits
        // the key entirely so `classifyEarlyDecline` keeps its own regexes.
        ...(signalsDecided && turnSignals ? { declineClass: turnSignals.declineClass } : {}),
      })
    : null;
  /** Which router the value above came from — recorded on the semantic gate and the log line. */
  const routingDecidedBy = semanticRoute
    ? 'semantic_router'
    : liveIntentClassification
      ? 'llm_classifier'
      : route.agent
        ? 'keyword_router'
        : 'ambiguous_fallback';
  // REC-4: the claims-validator requires RAG evidence for every assertion, which a competitive
  // recommendation (grounded by its cross-reference match, not by retrieved chunks) can't satisfy —
  // forcing it on made the validator reject the recommendation as "unsupported" and the not-approved
  // fallback overwrote it with "I could not fully verify…". Chemistry-consistency + confidence
  // calibration for the cross_reference route is instead enforced by evaluateRecommendationGate
  // (below), which runs regardless of this flag. So the validator stays opt-in on every route.
  const useValidator = input.useValidator ?? false;
  /**
   * B0-494 — resolved value of every behavior switch this run observes, computed once so every
   * consumer (the run-level chip, `/gate`, the final output) agrees on the same snapshot. Resolved
   * values, not env-var names: `rerankerActive` in particular depends on `isRerankerConfigured()`
   * (COHERE_API_KEY presence), which can differ between otherwise-identical deploys.
   */
  // B0-984 — read once per turn; the same value gates the runtimes below and is recorded here.
  const factToolEnforcementEnabled = await isFactToolEnforcementEnabled();
  const runtimeConfig: RuntimeConfig = {
    useValidator,
    earlyDeclineGateEnabled,
    factToolEnforcementEnabled,
    rerankerActive: PRODUCT_SUPPORT_RERANK_ENABLED && isRerankerConfigured(),
    multiIntentQueryExpansionEnabled: await getBooleanSetting('RAG_MULTI_INTENT_ENABLED', false),
    confidenceGatingDisabled: await isConfidenceGatingDisabled(),
    recommendationConfidenceGatingDisabled: await isRecommendationConfidenceGatingDisabled(),
    agentMode,
    routedDirectly: agentMode !== 'orchestrator',
    // B0-649 — the semantic-router rollout state this run observed, from the SAME flag reads the
    // decision above used.
    ...semanticRouterRuntimeConfigFields({
      mode: semanticRouterMode,
      enabled: semanticRouterEnabledSetting,
      shadowMode: semanticRouterShadowModeSetting,
      decision: semanticRouteDecision,
      decidedRoute: semanticRoute,
    }),
  };
  /**
   * B0-649 — same precedence as `routingDecision`: whoever decided explains the turn. A semantic
   * FALLBACK deliberately does not claim the rationale (it did not decide) — the classifier/keyword
   * sentence stands, and the fallback itself is explained by the semantic gate record below.
   */
  const routerRationale =
    agentMode === 'orchestrator'
      ? semanticRoute && semanticRouteDecision
        ? semanticRouterRationale(semanticRouteDecision)
        : liveIntentClassification
          ? `LLM intent classifier (${liveIntentClassification.source}, confidence ${liveIntentClassification.confidence}) routed to "${liveIntentClassification.intent}".${liveIntentClassification.routingOverrideReason ? ` ${liveIntentClassification.routingOverrideReason}.` : ''}`
          : route.rationale
      : `Forced direct routing to ${agentMode} specialist by admin selection.`;
  // B0-751 — the router's sentence still stands (it did decide); the override is appended so the
  // planner step never claims a `cross_reference` decision for a turn that ran the product policy.
  const routingRationale =
    selfReferenceVerdict?.suppressed
      ? `${routerRationale} Competitor self-reference check (B0-751) withdrew cross-reference handling (${selfReferenceVerdict.reason}: "${selfReferenceVerdict.matched}")${routingDecision !== preliminaryRoutingDecision ? ` and re-routed "${preliminaryRoutingDecision}" to "${routingDecision}"` : ''}.`
      : routerRationale;
  const instructions = buildProductSupportInstructions({
    mode: agentMode,
    routing: {
      decision: routingDecision,
      rationale: routingRationale,
      productScore: route.productScore,
      bathroomScore: route.bathroomScore,
      dilutionScore: route.dilutionScore,
      floorWoodSportScore: route.floorWoodSportScore,
      floorConcreteScore: route.floorConcreteScore,
      floorStgScore: route.floorStgScore,
      floorVctScore: route.floorVctScore,
      recommendationScore: route.recommendationScore,
      crossReferenceScore: route.crossReferenceScore,
    },
    // B0-508 — the hint block renders the classifier's intent/confidence/entities instead of the
    // raw keyword scores whenever the classifier genuinely ran (`source: 'llm'`); degraded or
    // kill-switched turns keep the scores line.
    classification: liveIntentClassification ?? undefined,
  });
  // B0-324 — same prefix ⇒ same cache pool, for every model call in this turn and every later turn
  // routed the same way.
  const promptCacheKey = buildProductSupportPromptCacheKey({
    mode: agentMode,
    decision: routingDecision,
  });
  /**
   * B0-437 — route-scoped tool schemas (all 14 serialize to ~2,785 tokens and used to go out on every
   * call). Keyed on the same `routingDecision` as `promptCacheKey` and `instructions`, so the whole
   * cacheable prefix — instructions + tool schemas — stays byte-identical for every call that shares
   * the key, both within this tool loop and across later turns routed the same way.
   */
  const routeTools = productSupportToolsForRoute(routingDecision);

  /**
   * B0-392 — the specialist policy that ACTUALLY ran, which is not always `routingDecision`:
   * `'ambiguous'` (and any unknown decision) falls through to the product specialist, so a UI
   * showing only "ambiguous" implies no agent policy was applied, which is false. Derived from the
   * same function `buildProductSupportInstructions` used to pick the prompt above.
   */
  const effectivePromptId = effectivePromptIdForDecision(routingDecision);
  /** B0-393/B0-388 — stamps for the prompt that ran; keyed off the same decision as the prompt. */
  const promptVersion = computePromptVersion(routingDecision);

  /**
   * B0-391 — the keyword-routing gate: six scores (B0-663 split `recommendations` into the
   * competitor `cross_reference` score and a new job-based `recommendations` score), the phrases
   * behind them, and which branch decided. In `orchestrator` mode the verdict IS the branch taken
   * (`no_signal` is the state the workflow relabels `ambiguous`); in a forced direct mode the
   * scores were computed but did not decide, and saying so is the point of recording the gate at
   * all.
   */
  const keywordRoutingGate: GateRecord = {
    gate: 'keyword_routing',
    inputs: {
      agentMode,
      scores: {
        product: route.productScore,
        bathroom: route.bathroomScore,
        dilution: route.dilutionScore,
        floor_wood_sport: route.floorWoodSportScore,
        floor_concrete: route.floorConcreteScore,
        floor_stg: route.floorStgScore,
        floor_vct: route.floorVctScore,
        cross_reference: route.crossReferenceScore,
        recommendations: route.recommendationScore,
      },
      // B0-392 — the counts are not comparable across categories (the lists overlap internally),
      // so the phrases are what make a score reviewable.
      matchedPhrases: route.matchedPhrases,
      decisiveCrossReferencePhrases: route.decisiveCrossReferencePhrases,
      routedAgent: route.agent,
      decisionPath: route.decisionPath,
      tiedCategories: route.tiedCategories,
      rationale: route.rationale,
    },
    thresholds: {
      minHitsToRoute: SME_ROUTE_MIN_HITS_TO_ROUTE,
      tieBreakOrder: [...SME_ROUTE_TIE_BREAK_ORDER],
      decisiveCrossReferenceSignalWinsOutright: true,
    },
    verdict:
      agentMode === 'orchestrator'
        ? // B0-649 — the semantic router, when it decided, is what overrode the keyword scores;
          // saying "llm cutover" there would misattribute the override.
          semanticRoute
          ? 'overridden_by_semantic_router'
          : llmRouterCutoverActive
            ? 'overridden_by_llm_cutover'
            : route.decisionPath
        : 'overridden_by_direct_mode',
    effect:
      agentMode === 'orchestrator'
        ? semanticRoute
          ? `Semantic router decided this turn; keyword scores computed for comparison only (would have routed to "${route.agent ?? 'ambiguous'}").`
          : llmRouterCutoverActive
            ? `LLM routing cutover active; keyword scores computed for comparison only (would have routed to "${route.agent ?? 'ambiguous'}").`
            : route.agent
              ? `Routed to the ${route.agent} specialist; ran the ${effectivePromptId} prompt.`
              : `No keyword signal fired, so routingDecision is "ambiguous" — the ${effectivePromptId} specialist prompt ran by fallthrough, while the model was told "No specialist keywords matched".`
        : `Admin forced direct \`${agentMode}\` routing, so the keyword scores did not decide; ran the ${effectivePromptId} prompt.`,
  };

  /**
   * B0-511 — the live counterpart to the B0-507 shadow gate below: recorded whenever the cutover
   * actually decided this turn's routing (`llmRouterCutoverActive`), so the same
   * agrees/disagrees-with-keyword-router comparison the rollout dashboard already reads survives
   * cutover instead of only existing pre-cutover.
   */
  const intentClassifierLiveGate: GateRecord | null = liveIntentClassification
    ? {
        gate: 'llm_intent_classifier_live',
        inputs: {
          classifiedIntent: liveIntentClassification.intent,
          classifierConfidence: liveIntentClassification.confidence,
          classifierSource: liveIntentClassification.source,
          classifierFallbackReason: liveIntentClassification.fallbackReason,
          // B0-977 — non-null when the deterministic floor-substrate override re-routed the verdict.
          routingOverrideReason: liveIntentClassification.routingOverrideReason ?? null,
          classifierLatencyMs: liveClassifierLatencyMs,
          entities: liveIntentClassification.entities,
          suggestedTool: liveIntentClassification.suggestedTool,
          keywordRoutingDecision: route.agent ?? 'ambiguous',
        },
        thresholds: {
          model: routerModel,
          timeoutMs: routerTimeoutMs,
        },
        verdict:
          liveIntentClassification.intent === (route.agent ?? 'ambiguous')
            ? 'agrees_with_keyword_router'
            : 'disagrees_with_keyword_router',
        effect:
          liveIntentClassification.source === 'llm'
            ? `Routing cutover: the LLM classifier routed this turn to "${liveIntentClassification.intent}" (confidence ${liveIntentClassification.confidence}, ${liveClassifierLatencyMs}ms); the keyword router would have chosen "${route.agent ?? 'ambiguous'}".${liveIntentClassification.routingOverrideReason ? ` Deterministic override applied (B0-977): ${liveIntentClassification.routingOverrideReason}.` : ''}`
            : `Routing cutover DEGRADED: the LLM call fell back to the keyword router (${liveIntentClassification.fallbackReason ?? 'unknown reason'}, ${liveClassifierLatencyMs}ms), so this turn was still routed to "${liveIntentClassification.intent}" by keyword scoring.`,
      }
    : null;

  /**
   * B0-786 — the whole `TurnSignals` object, persisted on the one step every run has, so every
   * consolidated decision this turn made is queryable from `/admin/observability` instead of being
   * re-derived from nine call sites. Modeled on `llm_intent_classifier_live` above (which already
   * records `entities`); that gate still records the routing half, so the two are readable side by
   * side while the rollout flag is being flipped.
   */
  const signalsAnalysisGate: GateRecord | null = turnSignals
    ? {
        gate: 'signals_analysis',
        inputs: {
          signals: turnSignals,
          analysisLatencyMs: liveClassifierLatencyMs,
          keywordRoutingDecision: route.agent ?? 'ambiguous',
        },
        thresholds: {
          model: routerModel,
          timeoutMs: routerTimeoutMs,
          signalsAnalysisEnabled,
        },
        verdict: turnSignals.source === 'llm' ? 'signals_analyzed' : 'degraded_to_keyword_router',
        effect:
          turnSignals.source === 'llm'
            ? `One signals call routed this turn to "${turnSignals.intent}" (confidence ${turnSignals.confidence}, ${liveClassifierLatencyMs}ms) and supplied crossReferenceIntent=${turnSignals.crossReferenceIntent}, answerShape="${turnSignals.answerShape}", declineClass=${turnSignals.declineClass ?? 'null'}, regulatedSectionIntent=${turnSignals.regulatedSectionIntent}, productLineLock=${turnSignals.resolvedProductLineKey ?? 'none'}. No separate competitor-extraction call was made.`
            : `Signals analysis DEGRADED (${turnSignals.fallbackReason ?? 'unknown reason'}, ${liveClassifierLatencyMs}ms): the keyword router decided this turn ("${turnSignals.intent}") and every downstream consumer fell back to its own deterministic check.`,
      }
    : null;

  /**
   * B0-651 — the persisted, queryable record of this turn's semantic routing decision (every route's
   * similarity, confidence, margin, per-threshold pass/fail, path, and the latency split), plus the
   * matching real-time structured log line. Emitted for BOTH rollout stages: `semantic_router_live`
   * when the router decided (or degraded while live), `semantic_router_shadow` when it only
   * compared. `null` — and therefore no log line and no gate — when the router never ran.
   */
  const semanticRouterGate: GateRecord | null =
    semanticRouterMode !== 'off' && semanticRouteDecision
      ? buildSemanticRouterGate({
          mode: semanticRouterMode,
          decision: semanticRouteDecision,
          routingDecision,
          decidedBy: routingDecidedBy,
        })
      : null;
  if (semanticRouterMode !== 'off' && semanticRouteDecision) {
    logSemanticRouterDecision({
      mode: semanticRouterMode,
      decision: semanticRouteDecision,
      routingDecision,
      decidedBy: routingDecidedBy,
      traceId: input.traceId,
      conversationId: input.conversationId,
    });
  }

  // `model` was resolved at the top of this function (B0-908) so the runtime decision could see it.
  // The OpenAI client is still constructed on a Claude turn for the Responses-only helpers below
  // (it only needs OPENAI_API_KEY present); the validator, revision pass and intent classifier now
  // route by model id through `~/lib/llm/structured-completion`, so they follow the selected provider.
  /** B0-389 — which generation runtime the agent prompt ran on. One loop since B0-914. */
  const agentRuntime: PromptRecord['runtime'] = 'ai-sdk';

  /**
   * B0-428 / B0-429 — time to first assistant token, surfaced as the "Stream" column on
   * `/admin/observability`. Anchored here rather than at the HTTP boundary so it shares the run's
   * duration anchor (`workflow_runs.created_at`) and the two numbers stay comparable.
   *
   * Recorded on EVERY run, not only those whose caller wants deltas: the observer below is passed to
   * the generation runtime unconditionally (`observeAssistantDelta`), which is measurement-only and
   * therefore leaves both delta forwarding and the runtime's retry window untouched.
   */
  const workflowStartedAtMs = Date.now();
  let firstAssistantTokenAtMs: number | null = null;
  const observeAssistantDelta = () => {
    if (firstAssistantTokenAtMs === null) {
      firstAssistantTokenAtMs = Date.now();
    }
  };
  const ttftMs = (): number | null =>
    firstAssistantTokenAtMs === null
      ? null
      : Math.max(0, firstAssistantTokenAtMs - workflowStartedAtMs);
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

  /**
   * B0-439 — audit rows are recorded (with their own `created_at`) and written in batches that
   * overlap awaits this run already pays for, instead of costing a 45-90ms round trip each, inline.
   * `settle()` is awaited on every exit path, so no write is left to a background task the
   * serverless runtime may kill. Row count, payloads, event types and order are unchanged.
   */
  const audit = createAuditLogQueue();

  audit.enqueue(
    'workflow_started',
    { workflow: 'product-support', routing: routingDecision },
    // Deliberately unchanged: this row still carries a null `workflow_run_id` (the run does not
    // exist yet), so `listAuditLogsForRun` still never returns it and the run trace still anchors
    // its start marker on `workflow_runs.created_at`.
    { ...ctx, workflowRunId: null },
  );
  // Written concurrently with the run insert below: the row lands even if that insert throws, as it
  // did when this was an awaited write, and costs nothing because the insert is awaited anyway.
  audit.flushDetached();

  logInfo('workflow_started', {
    ...ctx,
    workflow: 'product-support',
    routing: routingDecision,
  });

  const run = await insertWorkflowRun({
    conversation_id: input.conversationId,
    workflow_name: 'product-support',
    status: 'running',
    // B0-416 — stamped on the insert, not patched afterwards: a second UPDATE would leave a
    // window in which the run exists with no provenance, and would be skipped entirely on the
    // failure paths that never reach a completion write.
    source: input.source,
    // B0-574 — queryable version stamps, written on the insert (same rationale as `source`
    // above: no patch-later window, and failure paths that never complete still carry them).
    // Pre-B0-574 rows have NULL here and read as "unversioned" — never backfilled.
    app_version: APP_VERSION,
    prompt_bundle_version: PROMPT_BUNDLE_VERSION,
    user_input: jsonContent({
      message: input.userMessage,
      modelTag: input.modelTag ?? 'preview',
    }),
  });

  // B0-780 — carries which specialist policy is running down into `executeProductTool` (via
  // `executeToolCall`'s `auditCtx`), so retrieval can bind to that specialist's product category
  // (see `resolveKnowledgeCategoryExclusions` in `~/lib/tools/product-tools.ts`).
  const wfCtx = { ...ctx, workflowRunId: run.id, specialistId: effectivePromptId as string };

  /**
   * B0-386 — ids of steps inserted `running` and not yet completed, oldest first. Every step
   * opened below must be registered here and unregistered on completion so the failure handler
   * can blame the step that was actually open (see `failOpenWorkflowSteps`). Steps inserted
   * already-`completed` (`orchestration_planner`, `early_decline_gate`) are never open.
   */
  const openStepIds: string[] = [];
  const markStepOpen = (stepId: string) => {
    openStepIds.push(stepId);
  };
  const markStepClosed = (stepId: string) => {
    const index = openStepIds.indexOf(stepId);
    if (index >= 0) {
      openStepIds.splice(index, 1);
    }
  };

  const plannerStep = await insertWorkflowStep({
    workflow_run_id: run.id,
    step_name: 'orchestration_planner',
    status: 'completed',
    input: jsonContent({
      message: input.userMessage,
      /**
       * B0-389 — run config lives on the planner step because it is the ONE step every run has,
       * including a decline-gate run that never reaches the agent step. `earlyDeclineGateEnabled`
       * is what explains whether the decline gate even had a chance to fire, so a trace with no
       * decline is only interpretable next to it.
       */
      runConfig: { earlyDeclineGateEnabled },
    }),
    output: jsonContent({
      routing: {
        decision: routingDecision,
        /**
         * B0-392 — the prompt `decision` actually selected. `decision: 'ambiguous'` means the
         * product specialist ran by fallthrough, not that no policy applied.
         */
        effectivePromptId,
        scores: {
          product: route.productScore,
          bathroom: route.bathroomScore,
          dilution: route.dilutionScore,
          floor_wood_sport: route.floorWoodSportScore,
          floor_concrete: route.floorConcreteScore,
          floor_stg: route.floorStgScore,
          floor_vct: route.floorVctScore,
          cross_reference: route.crossReferenceScore,
          recommendations: route.recommendationScore,
        },
        rationale: routingRationale,
      },
      // B0-391 — the same routing decision as a structured gate record (phrases + thresholds).
      ...recordGates([
        keywordRoutingGate,
        ...(intentClassifierLiveGate ? [intentClassifierLiveGate] : []),
        // B0-786 — the consolidated signals object, alongside the routing gate it supersedes.
        ...(signalsAnalysisGate ? [signalsAnalysisGate] : []),
        // B0-651 — the semantic router's own record, on the one step every run has.
        ...(semanticRouterGate ? [semanticRouterGate] : []),
      ]),
      /**
       * B0-563 — `classifyUserIntent`'s live model call was previously uncounted: this is the
       * ONE step every run has, so it's where that usage belongs. Absent (not zeroed) whenever no
       * NEW model call was billed for this turn — the router disabled, the keyword fallback, or a
       * cache hit replaying an earlier call's decision.
       */
      ...(liveIntentClassification?.usage
        ? { usage: liveIntentClassification.usage, model: liveIntentClassification.model }
        : {}),
    }),
    completed_at: new Date().toISOString(),
  });

  audit.enqueue(
    'step_started',
    { step: 'orchestration_planner', step_id: plannerStep.id },
    { ...wfCtx, stepId: plannerStep.id },
  );
  // B0-751 — one row per suppression, so "how often does the router call a Betco product a
  // competitor" is a query against `audit_logs` rather than an inference from missing engine rows.
  if (selfReferenceVerdict?.suppressed) {
    audit.enqueue(
      'cross_reference_self_reference_suppressed',
      {
        reason: selfReferenceVerdict.reason,
        matched: selfReferenceVerdict.matched,
        product_line_key: selfReferenceVerdict.productLineKey,
        preliminary_route: preliminaryRoutingDecision,
        final_route: routingDecision,
      },
      wfCtx,
    );
  }

  if (earlyDeclineDecision) {
    const declineResponseId = `decline_gate:${run.id}`;
    const finalText = earlyDeclineDecision.text;
    const validation: ValidatorResult = {
      approved: true,
      confidence: EARLY_DECLINE_CONFIDENCE,
      issues: [],
      requires_human_review: false,
    };
    const finalOutput: ProductSupportFinalOutput = {
      answerText: finalText,
      sources: [],
      retrieved_document_chunks: [],
      // The early-decline gate short-circuits before any tool runs, so there is nothing to record.
      // Empty, not absent: "this turn ran no retrieval" is a fact worth stating, and distinguishes
      // a decline from a payload written before this field existed.
      retrieval_calls: [],
      confidence: validation.confidence,
      workflowRunId: run.id,
      latestOpenaiResponseId: declineResponseId,
      validation,
      routingDecision,
      /**
       * B0-391 — the decline gate wrote this text; no model call happened on this path.
       * B0-393 — the prompt stamps are still recorded: the specialist prompt this run WOULD have
       * used is what makes a declined run comparable with the answered runs beside it.
       */
      answerProvenance: 'decline_gate',
      promptVersion,
      promptBundleVersion: PROMPT_BUNDLE_VERSION,
      priorMessageCount: input.priorMessages?.length ?? 0,
      // B0-519 — no model call happens on this path; still recorded for consistency with the
      // answered path's same field.
      historyCapApplied,
      // B0-491 — no model call happens on this path either; explicit null with a reason rather
      // than an absent field, same rule as every other run-config field on this branch.
      agentConfidence: NO_MODEL_CALL_AGENT_CONFIDENCE.agentConfidence,
      agentConfidenceBasis: NO_MODEL_CALL_AGENT_CONFIDENCE.agentConfidenceBasis,
      agentConfidenceReason: NO_MODEL_CALL_AGENT_CONFIDENCE.reason,
      // B0-492 — the fixed decline-gate constant, distinguishable by field from an approved
      // validator-judged run rather than by string-matching the answer text.
      ...confidenceProvenanceFields({
        provenance: 'decline_gate_constant',
        preCapValue: null,
        preCapProvenance: null,
      }),
      // B0-494 — the switches this run observed are still meaningful here (they're resolved
      // before the decline check runs); the other four gates never got a chance to run at all.
      runtimeConfig,
      activeGates: {
        validator: { state: 'not_applicable' },
        earlyDeclineGate: { state: 'ran', verdict: 'declined' },
        usageSafetyCoverage: { state: 'not_applicable' },
        regulatedClaimGuardrail: { state: 'not_applicable' },
        recommendationConfidence: { state: 'not_applicable' },
        recommendationEngineVerdict: { state: 'not_applicable' },
        // B0-751 — this check runs BEFORE the decline gate, so its record is real even here.
        crossReferenceSelfReference: crossReferenceSelfReferenceActivation,
      },
      // B0-358 — no validator pass exists on this path at all (no model was called), so the run
      // record says `not_run` rather than claiming either an LLM judgment or a bypass heuristic.
      validatorMode: 'not_run',
      timingBreakdown: {
        toolRounds: 0,
        cacheSource: null,
        searchMs: null,
        /**
         * B0-429 — no model call happens on this path, so there is no streamed token to time.
         * The decline text IS the first assistant output the caller receives, so its elapsed time
         * is the honest TTFT here, and the metric stays populated for policy-declined runs.
         */
        ttftMs: Math.max(0, Date.now() - workflowStartedAtMs),
      },
    };

    const policyGateStep = await insertWorkflowStep({
      workflow_run_id: run.id,
      step_name: 'early_decline_gate',
      status: 'completed',
      input: jsonContent({
        reason: earlyDeclineDecision.reason,
        message: input.userMessage,
      }),
      output: jsonContent({
        applied: true,
        reason: earlyDeclineDecision.reason,
        /**
         * B0-391 — recorded only on this step, which exists only when the gate FIRED. A run whose
         * message did not match any decline rule has no `early_decline_gate` step and therefore no
         * record; whether the gate was even eligible is the planner step's
         * `runConfig.earlyDeclineGateEnabled`.
         */
        ...recordGates([
          {
            gate: 'early_decline_gate',
            inputs: {
              reason: earlyDeclineDecision.reason,
              message: input.userMessage,
              crossReferenceIntent: crossReferenceIntentForTurn,
            },
            thresholds: {
              gateEnabled: earlyDeclineGateEnabled,
              reasons: [...EARLY_DECLINE_REASONS],
              declineConfidence: EARLY_DECLINE_CONFIDENCE,
            },
            verdict: 'declined',
            effect: `Short-circuited before any model call or retrieval (${earlyDeclineDecision.reason}); the canned decline text was returned with confidence ${EARLY_DECLINE_CONFIDENCE}.`,
          },
        ]),
      }),
      completed_at: new Date().toISOString(),
    });

    audit.enqueue(
      'step_completed',
      {
        step: 'early_decline_gate',
        step_id: policyGateStep.id,
        reason: earlyDeclineDecision.reason,
      },
      { ...wfCtx, stepId: policyGateStep.id },
    );

    audit.enqueue(
      'workflow_completed',
      {
        workflow_run_id: run.id,
        early_decline_reason: earlyDeclineDecision.reason,
      },
      wfCtx,
    );

    /**
     * B0-439 — the terminal writes hit three unrelated tables with no read dependency between them,
     * so they are issued together and awaited before returning. Still awaited, deliberately: a
     * detached terminal write can be killed once the response finishes, which would leave the run
     * `running` for the stalled-run sweeper to reap.
     */
    await Promise.all([
      updateWorkflowRun(run.id, {
        status: 'completed',
        final_output: jsonContent(finalOutput),
        confidence: validation.confidence,
      }),
      updateConversation(input.conversationId, {
        latest_model: model,
      }),
      insertMessage({
        conversation_id: input.conversationId,
        role: 'assistant',
        plain_text: finalText,
        openai_response_id: null,
        content: jsonContent({
          kind: 'assistant_turn',
          text: finalText,
          model,
          sources: [],
          confidence: validation.confidence,
          workflowRunId: run.id,
          routingHint: {
            decision: routingDecision,
            rationale: `${routingRationale} Early decline gate applied: ${earlyDeclineDecision.reason}`,
          },
          validation: {
            approved: validation.approved,
            issues: validation.issues,
            requiresHumanReview: validation.requires_human_review,
          },
          timingBreakdown: {
            toolRounds: 0,
            cacheSource: null,
            searchMs: null,
          },
          toolSummary: [],
        }),
      }),
      audit.settle(),
    ]);

    logInfo('workflow_completed', {
      ...wfCtx,
      early_decline_reason: earlyDeclineDecision.reason,
    });
    input.onEvent?.({ type: 'status', stage: 'workflow_completed' });

    return finalOutput;
  }

  /**
   * B0-390 — the run's RESOLVED tool trace, declared out here for two reasons:
   *
   * 1. the agent step used to persist `agentResult.toolTrace`, which never contains the
   *    force-injected cross-reference search (that was pushed onto a separate local copy), so the
   *    forced call executed but was never persisted;
   * 2. the catch block needs to reach it, to keep the calls that completed before a throw.
   *
   * Every tool call in the run lands here exactly once, in execution order: model-chosen calls via
   * `executeTool`, plus the workflow's own forced/safety-net calls.
   */
  const resolvedToolTrace: ToolTraceEntry[] = [];

  const agentStep = await insertWorkflowStep({
    workflow_run_id: run.id,
    step_name: 'openai_responses_agent',
    status: 'running',
    input: jsonContent({
      model,
      historyCapApplied,
      /**
       * B0-389 — the prompt record for this call. `runtime` is always `ai-sdk` since B0-914;
       * older runs keep their recorded `responses` value.
       */
      ...recordPrompt({
        stage: 'openai_responses_agent',
        instructions,
        model,
        runtime: agentRuntime,
      }),
    }),
  });
  markStepOpen(agentStep.id);

  audit.enqueue(
    'openai_response_requested',
    { step: 'agent', step_id: agentStep.id },
    { ...wfCtx, stepId: agentStep.id },
  );
  input.onEvent?.({ type: 'status', stage: 'agent_started' });

  try {
    const toolOutputLog: RuntimeToolOutput[] = [];
    const cacheSourceCounts = new Map<string, number>();
    let totalSearchMs = 0;
    let retrievalSamples = 0;

    /**
     * B0-390 — `tool_choice` is pinned on the FIRST model round only (both runtimes send `auto`
     * afterwards), so the first executed call of the pinned tool is the one the model had no say
     * in; a later call of the same tool was its own choice.
     *
     * B0-436 — the actual `toolChoice` is resolved further down, once speculative retrieval has
     * run (a usable speculative hit downgrades it to `auto`). Pinning to a named function only ever
     * happens on the cross-reference path, so the pinned name is derived from that condition here —
     * it must be in scope before `executeTool` is defined below.
     */
    const forcedToolChoiceName = crossReferenceIntentForTurn ? 'lookup_cross_reference' : null;
    let forcedToolChoiceConsumed = false;

    /**
     * B0-786 — the retrieval-shaping signals handed to every product tool this turn. Only set when
     * the model call really ran (`signalsDecided`): a degraded turn leaves this undefined so
     * `classifyRetrievalIntent` and `resolveRequiredDocumentKinds` keep their own deterministic
     * checks, exactly as before this ticket.
     *
     * `regulatedSectionIntent` is ADDITIVE: it is OR'd with `isClaimLikeQuery` /
     * `inferSectionTypeFromQuery` inside `resolveRequiredDocumentKinds`, never substituted for
     * them, so a model miss can only widen label-first grounding.
     */
    const turnToolOptions: ProductToolTurnOptions | undefined =
      signalsDecided && turnSignals
        ? {
            answerShape: turnSignals.answerShape,
            regulatedSectionIntent: turnSignals.regulatedSectionIntent,
          }
        : undefined;

    /**
     * B0-786 PRODUCT LOCK — separable block: delete this constant and the one spread that uses it
     * below to drop the lock while leaving the rest of the signals wiring intact.
     *
     * The speculative pre-fetch searches the RAW user message with no product anchor at all, which
     * is why B0-635 had to stop citing its weak hits. When the signals call named a Betco product
     * AND that name resolved to a real product line, hand this key to EVERY `search_product_docs`
     * call this turn (speculative pre-fetch and model-chosen alike, as of B0-738) so it searches the
     * right product instead of whatever the message's incidental words match, or whatever this call's
     * own arguments happen to resolve to. Every other tool case still resolves for itself.
     */
    const speculativeProductLineLock =
      signalsDecided && turnSignals?.resolvedProductLineKey
        ? {
            productLineKey: turnSignals.resolvedProductLineKey,
            resolutionSource: turnSignals.resolutionSource,
          }
        : null;

    /**
     * B0-738 — deterministic query augmentation built from this turn's signals (no LLM call; see
     * `buildSignalQueryRewrite`). Composes with alias resolution rather than duplicating it: it
     * never resolves a product line itself, it only adds context terms the model's own
     * `search_product_docs` query may have missed. Gated on `signalsDecided` for the same reason as
     * the lock above — a degraded turn's signals aren't trustworthy enough to act on.
     */
    const signalQueryRewrite =
      signalsDecided && turnSignals ? buildSignalQueryRewrite(turnSignals) : null;

    const executeTool = async ({
      name,
      argumentsJson,
      callId,
      speculative,
      productLineLockOverride,
    }: {
      name: string;
      argumentsJson: string;
      callId: string;
      /** B0-436 — this call was fired before the first model call, not requested by the model. */
      speculative?: boolean;
      /**
       * B0-890 — forces `search_product_docs` to resolve THIS product line rather than the shared
       * B0-786 `speculativeProductLineLock` (or its own argument-based resolution). Used by the
       * two-product comparison fan-out (`runComparisonRetrieval`) so each scoped call anchors to its
       * OWN resolved entity instead of collapsing onto whichever single product line the turn's
       * signals happened to resolve. `undefined` (the default, for every other call) leaves the
       * existing lock behaviour completely unchanged; `null` explicitly clears any lock.
       */
      productLineLockOverride?: { productLineKey: string; resolutionSource: ProductEntityResolutionSource } | null;
    }) => {
      input.onEvent?.({
        type: 'tool',
        phase: 'started',
        name,
        callId,
      });
      audit.enqueue(
        'tool_called',
        {
          tool_name: name,
          call_id: callId,
          ...(speculative ? { speculative: true } : {}),
        },
        { ...wfCtx, toolName: name },
      );
      logInfo('tool_called', {
        ...wfCtx,
        tool_name: name,
        call_id: callId,
        ...(speculative ? { speculative: true } : {}),
      });

      // B0-439 — this row (and the previous call's outcome row) is written while the tool runs, so
      // an in-flight run's trace stays about as fresh as it was when the write blocked the call.
      audit.flushDetached();

      /**
       * B0-390 + B0-436 — a speculative retrieval runs before the first model call, so the model
       * demonstrably did not choose it: it is workflow-injected. Leaving it `model_chosen` would be
       * exactly the mis-attribution this attribution exists to prevent. It also cannot consume the
       * `tool_choice` pin, which applies to the first MODEL round.
       */
      let origin: ToolCallOrigin = speculative ? 'workflow_injected' : 'model_chosen';
      if (!speculative && forcedToolChoiceName === name && !forcedToolChoiceConsumed) {
        origin = 'tool_choice_forced';
        forcedToolChoiceConsumed = true;
      }

      const out = await executeToolCall({
        name,
        argumentsJson,
        callId,
        origin,
        auditCtx: wfCtx,
        /**
         * B0-738 — the product-line lock and the signals-derived query rewrite used to apply only
         * to the speculative pre-fetch (`speculative && speculativeProductLineLock`). They now
         * apply to EVERY `search_product_docs` call this turn, model-chosen or speculative — a
         * model-chosen call previously got `turnToolOptions` (answerShape,
         * regulatedSectionIntent) but never the lock or rewrite, even when the signals call had
         * already resolved a product line and extra context for this exact turn. Every other tool
         * name is untouched: it still gets plain `turnToolOptions` (or nothing), exactly as before.
         */
        ...(turnToolOptions || productLineLockOverride !== undefined
          ? {
              turnOptions:
                name === 'search_product_docs'
                  ? {
                      ...(turnToolOptions ?? {}),
                      // B0-890 — an explicit per-call override (the comparison fan-out) always wins
                      // over the turn-wide B0-786 signals lock; `undefined` (every other call) falls
                      // back to that existing behaviour exactly as before this ticket.
                      productLineLock:
                        productLineLockOverride !== undefined
                          ? (productLineLockOverride ?? undefined)
                          : (speculativeProductLineLock ?? undefined),
                      /**
                       * B0-974 — the speculative pre-fetch embeds the user's message VERBATIM.
                       * Appending the signals rewrite to it distorted the query vector: "how soon
                       * can people walk on the VCT floor after the last coat?" became "… floor
                       * finish vct time before walking on VCT floor after last coat"
                       * (`rag.search_embedding` 16613), which pulled between-coats/mastic docs to
                       * the top and pushed "VCT Reopening to Traffic" to rank 6; the verbatim
                       * embedding (row 15965) puts it at rank 1. A MODEL-chosen search still gets
                       * the rewrite (B0-738) — its own query terms are what can miss context.
                       */
                      queryRewrite: speculative ? null : signalQueryRewrite,
                    }
                  : turnToolOptions,
            }
          : {}),
      });
      // B0-436 — the marker travels on the persisted trace as well as the audit row, so an
      // `/admin/observability` timeline shows which retrieval the model did not ask for.
      const trace: ToolTraceEntry = speculative
        ? { ...out.trace, speculative: true }
        : out.trace;
      const retrievalTiming = extractRetrievalTiming(out.output);
      if (retrievalTiming) {
        cacheSourceCounts.set(
          retrievalTiming.cacheSource,
          (cacheSourceCounts.get(retrievalTiming.cacheSource) ?? 0) + 1,
        );
        totalSearchMs += retrievalTiming.searchMs;
        retrievalSamples += 1;
      }

      // B0-439 — enqueued, not awaited: the `tool_called` / settle pair used to add two round trips
      // to EVERY tool call, including the speculative one that now runs before the first model call.
      // Both rows keep their own `created_at`, which is what the timeline diffs for tool duration.
      audit.enqueue(
        trace.ok ? 'tool_succeeded' : 'tool_failed',
        // B0-363: failures also carry `error_message` + a bounded `arguments_preview`
        // so the cause is recoverable from the audit row alone.
        {
          ...buildToolCallAuditPayload(trace),
          ...(speculative ? { speculative: true } : {}),
        },
        { ...wfCtx, toolName: name },
      );

      // B0-390 — the resolved trace is the single array every call lands in; B0-436's speculative
      // marker rides on the entry pushed here.
      resolvedToolTrace.push(trace);
      toolOutputLog.push({
        toolName: trace.toolName,
        ok: trace.ok,
        output: out.output,
        trace,
      });
      input.onEvent?.({
        type: 'tool',
        phase: 'completed',
        name,
        ok: trace.ok,
        callId,
      });
      return { ...out, trace };
    };

    // B0-514 — the classifier-derived verdict computed once at the top of the run.
    const forcedCrossReference = crossReferenceIntentForTurn;

    /**
     * B0-357 — resolve the ONE (competitorBrand, competitorProduct) tuple for this turn,
     * deterministically, before any of its consumers run. Threaded through the forced-lookup
     * prefetch below, the deterministic override safety net, and the B0-355 web-search backstop —
     * replacing each one's own "guess from the raw message" with a single shared resolution, so the
     * same phrasing produces the same tuple (and therefore a byte-identical `buildRecommendationQuery`
     * output) every consumer agrees on.
     *
     * Only resolved when this turn could actually need it (cross_reference route or explicit
     * cross-reference intent) — an LLM call on every turn would cost latency/spend for the vast
     * majority of turns that never touch this path. Kicked off here and NOT awaited: it runs
     * concurrently with the model's forced tool-call round, same latency shape as the B0-461
     * prefetch it now feeds, rather than stacking in front of it.
     */
    const competitorIdentityNeeded = routingDecision === 'cross_reference' || forcedCrossReference;
    // B0-751 — when the self-reference check already awaited the extraction for this turn, that
    // settled promise IS the turn's competitor identity; never start a second extraction call.
    const resolvedCompetitorPromise: Promise<ExtractedCompetitor> | null = competitorIdentityNeeded
      ? // B0-786 — the signals call IS the competitor identity for this turn; the second LLM call
        // it replaces was the literal duplicate this ticket set out to remove.
        turnSignals
        ? Promise.resolve(competitorIdentityFromSignals(turnSignals, input.userMessage))
        : (earlyCompetitorExtractionPromise ?? extractCompetitorProduct(input.userMessage))
      : null;

    /**
     * B0-507 — shadow-mode LLM intent classification, run alongside the keyword router above
     * (`route` / `routingDecision`) without ever changing this turn's actual routing. Gated on
     * BOTH `BEX_LLM_ROUTER_ENABLED` and `BEX_LLM_ROUTER_SHADOW_MODE`: `classifyUserIntent`
     * already no-ops to the keyword-router fallback when the router is disabled, but checking
     * `isLlmRouterEnabled()` here too skips even building the cache key / prior-message payload
     * on the overwhelming majority of turns where the router is off.
     *
     * B0-511 — mutually exclusive with the cutover path above by construction: once shadow mode
     * is off, `llmRouterCutoverActive` already awaited the classifier earlier (as
     * `liveIntentClassification`) and used it to decide `routingDecision`, so
     * `shadowIntentClassificationEnabled` below evaluates false and this block never fires a
     * second, redundant call for the same turn.
     *
     * Kicked off here (after the early-decline short-circuit above has already returned for the
     * turns that never reach this point, so a declined turn never pays for an unused model call)
     * and NOT awaited — it runs concurrently with the model's tool-call round, same shape as the
     * `resolvedCompetitorPromise` prefetch above, and is only awaited later, right before the
     * agent step is persisted (see `shadowIntentClassification` below).
     */
    // B0-649 — reuses the single flag read at the top of the run (see `llmRouterEnabled`), so the
    // shadow gate can never describe a different flag state than the routing decision did.
    const shadowIntentClassificationEnabled = llmRouterEnabled && llmRouterShadowMode;
    const shadowIntentClassificationPromise: Promise<IntentClassification> | null =
      shadowIntentClassificationEnabled
        ? classifyUserIntent(input.userMessage, priorTurnsForRouting)
        : null;

    /**
     * B0-461 — the forced-cross-reference path still pins `tool_choice` to the named
     * `lookup_cross_reference` function (a full single-call collapse was judged too risky here: the
     * pinned-tool attribution, the safety-net override, and the persisted-trace ordering asserted by
     * `workflow-instrumentation.test.ts` all assume the model's own call is what resolves a match).
     * Ticket's fallback instead applies to the piece of this path that is actually slow and
     * sequential today: the curated-override safety net further down only starts its lookup AFTER
     * the full two-round model loop completes and comes up empty. Kicking it off here, concurrently
     * with that loop, overlaps its DB round trip with the model's forced tool-call round instead of
     * stacking after it — exactly the case the ticket's BNC-15 -> Triforce example exercises.
     *
     * B0-357: uses the same resolved (brand, product) tuple as the safety net below, instead of the
     * previous lenient full-message args (`{ brand: message, productName: message }`); `.catch` only
     * suppresses an unhandled-rejection warning when the model's own call already resolves a match
     * and this prefetch is never awaited — the real await below still sees a genuine rejection.
     */
    const safetyNetLookupPrefetch = forcedCrossReference
      ? (() => {
          const promise = (
            resolvedCompetitorPromise ??
            Promise.resolve({ brand: null, product: input.userMessage, otherCompetitorProduct: null })
          ).then((resolved) =>
            lookupCrossReference({
              brand: resolved.brand ?? '',
              productName: resolved.product,
            }),
          );
          promise.catch(() => undefined);
          return promise;
        })()
      : null;

    // B0-439 — the rows recorded so far go out DURING the retrieval below, not before it.
    audit.flushDetached();

    /**
     * B0-890 — two-product comparison detection. A comparison question ("what's the difference
     * between pH7Q and pH7Q Dual?") named two DIFFERENT products, but the single speculative search
     * below only ever anchors to one product line — the other product's evidence never reaches the
     * generator, and the validator then rejects the half of the draft it can't support. Detected and
     * resolved deterministically (comparison phrasing + `resolveProductEntityByName` on each side, no
     * LLM call), and skipped under the exact same conditions the ordinary speculative retrieval skips
     * (flag off, forced/route cross-reference, empty message) — a comparison is always Betco-to-Betco
     * so those gates would never legitimately fire for one, but honouring them keeps this addition
     * inert wherever speculative retrieval itself is inert.
     */
    const speculativeSkipReason = classifySpeculativeRetrievalSkip({
      userMessage: input.userMessage,
      forcedCrossReference,
      routingDecision,
    });
    const comparisonEntities =
      speculativeSkipReason === null ? await resolveComparisonEntities(input.userMessage) : null;

    /**
     * B0-436 — speculative retrieval. Runs the obvious `search_product_docs` call ourselves so the
     * first model call can be the answering call. Placed after the early-decline gate (which returns
     * long before here) so no run ever pays for a search whose result is discarded.
     *
     * B0-890 — a validated two-product comparison instead runs ONE scoped call per resolved product
     * line (see `runComparisonRetrieval`) rather than the single unanchored search, so both labels
     * reach the generator/validator/guardrail.
     */
    let comparisonResults: Awaited<ReturnType<typeof runComparisonRetrieval>>['results'] | null = null;
    const speculation = comparisonEntities
      ? await (async () => {
          const { results } = await runComparisonRetrieval({
            entities: comparisonEntities,
            runId: run.id,
            execute: executeTool,
          });
          comparisonResults = results;
          const okResult = results.find((r) => r.trace.ok) ?? results[0];
          return { skippedReason: null, result: okResult };
        })()
      : await runSpeculativeRetrieval({
          userMessage: input.userMessage,
          routingDecision,
          forcedCrossReference,
          callId: buildSpeculativeCallId(run.id),
          execute: executeTool,
        });
    // A failed speculative search is no evidence at all: keep `tool_choice: 'required'` so the model
    // still has to retrieve before answering, and never present the error payload as evidence.
    const usableSpeculation =
      speculation.result && speculation.result.trace.ok ? speculation.result : null;

    let speculativeReuseCount = 0;
    const executeToolForGeneration = createSpeculativeReuseExecutor({
      speculative: usableSpeculation,
      userMessage: input.userMessage,
      execute: executeTool,
      onReuse: () => {
        speculativeReuseCount += 1;
      },
    });

    // B0-788 — the speculative search_product_docs result is prose, not the fact tables. For an
    // exact dilution/contact-time/kill-claim question, prose alone is not sufficient evidence even
    // when the model is willing to answer from it — verified live, the model called get_efficacy_data
    // ZERO times across a 14-item real eval despite the prompt explicitly requiring it. Pin the named
    // function instead of leaving 'auto' so this one question shape still gets its required second
    // call; everything else keeps the B0-436 latency win unchanged.
    const forceEfficacyLookup =
      Boolean(usableSpeculation) &&
      looksLikeExactEfficacyQuestion(input.userMessage) &&
      routeTools.some((tool) => 'name' in tool && tool.name === 'get_efficacy_data');

    /**
     * B0-889 — same fix shape as B0-788 immediately above: "best glass cleaner" named 2 of 13
     * documented lines, "strongest wood floor stripper" listed 4 with no item numbers, "what should
     * I use for greasy kitchen floors" named one degreaser with no item number. The prompt already
     * requires calling the category tool for these (`product-support-prompts.ts` "Best/strongest…"
     * and "Lists of products" sections), but the model kept answering from whichever chunks the
     * speculative `search_product_docs` call happened to rank top instead. Not checked when
     * `forceEfficacyLookup` already fired — an exact dilution/contact-time/EPA-registration question
     * takes priority when a message somehow matches both shapes. `dilution` is the one route with no
     * category tool (see `ROUTE_TOOL_NAMES`), so this never forces a tool that route doesn't have.
     */
    const forceCategoryList =
      !forceEfficacyLookup &&
      Boolean(usableSpeculation) &&
      looksLikeCategoryListOrSuperlativeAsk(input.userMessage) &&
      routeTools.some((tool) => 'name' in tool && tool.name === CATEGORY_LIST_TOOL_NAME);

    /**
     * B0-977 — a MULTI-category ask ("what stripping and finish products should I use for my VCT
     * floor?") cannot be served by the single pinned call above: the model makes one
     * `get_products_in_category` call whose `categoryName` normalises to its first token only
     * ('stripper'), so the finishes were never listed and the answer collapsed to two products.
     * When the message names two or more category tokens, run one category call PER token here —
     * through the workflow's own `executeTool`, so each lands in `toolTrace`/`toolOutputLog` as a
     * `workflow_injected` call like the speculative search — and hand every payload to round 1 as
     * preloaded evidence. The `tool_choice` pin is then dropped to `auto` (the calls already ran).
     * A single-category ask keeps the B0-889 pin exactly as before.
     */
    const multiCategoryTerms = forceCategoryList ? detectCategorySearchTerms(input.userMessage) : [];
    const perCategoryListResults =
      multiCategoryTerms.length >= 2
        ? await Promise.all(
            multiCategoryTerms.map(async (categoryTerm) => ({
              categoryTerm,
              result: await executeTool({
                name: CATEGORY_LIST_TOOL_NAME,
                argumentsJson: buildCategoryListArgumentsJson(categoryTerm),
                callId: buildCategoryListCallId(run.id, categoryTerm),
                speculative: true,
              }),
            })),
          )
        : [];
    const usablePerCategoryListResults = perCategoryListResults.filter(
      (entry) => entry.result.trace.ok,
    );
    const categoryListsPreloaded = usablePerCategoryListResults.length > 0;

    const toolChoice = forcedCrossReference
      ? ({ type: 'function', name: 'lookup_cross_reference' } as const)
      : forceEfficacyLookup
        ? ({ type: 'function', name: 'get_efficacy_data' } as const)
        : forceCategoryList && !categoryListsPreloaded
          ? ({ type: 'function', name: 'get_products_in_category' } as const)
          : usableSpeculation
            ? // Round 1 already holds retrieved evidence, so forcing another tool call would re-create
              // the wasted round this ticket removes.
              ('auto' as const)
            : ('required' as const);

    // B0-890 — a validated comparison gets the COMBINED two-product block (both labels) instead of
    // the single-search block, whenever at least one of the two scoped calls actually succeeded.
    const searchPreloadedEvidence =
      comparisonEntities && comparisonResults && usableSpeculation
        ? buildComparisonPreloadedEvidence({ entities: comparisonEntities, results: comparisonResults })
        : usableSpeculation
          ? buildPreloadedEvidence({
              userMessage: input.userMessage,
              // B0-437 — the model gets the slimmed variant when the tool produced one; the FULL
              // payload is what `toolOutputLog` (validator + regulated-claim guardrail) already holds.
              output: usableSpeculation.modelOutput ?? usableSpeculation.output,
            })
          : undefined;
    // B0-977 — the per-category lists ride in the same round-1 evidence block, payloads verbatim.
    const preloadedEvidence =
      searchPreloadedEvidence && categoryListsPreloaded
        ? appendCategoryListEvidence(
            searchPreloadedEvidence,
            usablePerCategoryListResults.map((entry) => ({
              categoryTerm: entry.categoryTerm,
              output: entry.result.modelOutput ?? entry.result.output,
            })),
          )
        : searchPreloadedEvidence;

    // B0-439 — the speculative call's rows go out DURING the model call, not before it: nothing
    // between here and the first token waits on `audit_logs` any more.
    audit.flushDetached();

    // B0-459 — same ceiling on both runtimes; see `resolveMaxOutputTokens`.
    const maxOutputTokens = resolveMaxOutputTokens();

    /**
     * B0-491 — the model appends a machine-readable `<!--BEX_AGENT_CONFIDENCE {...}-->` marker to
     * its answer (see `agent-self-confidence.ts`), but `onAssistantDelta` is the CALLER-VISIBLE
     * stream sink — "whatever is written here has been shown to someone and cannot be retracted".
     * This filter sits between the runtime and the caller's own sink so the marker (and a short
     * lookahead buffer that could be its opening sequence) never reaches the live chat stream, even
     * though it is still present in the runtime's own `assistantText` return value for extraction
     * below. `finish()` is called once the whole agent call (all rounds) has resolved.
     */
    const confidenceStreamFilter = input.onAssistantDelta
      ? createAgentConfidenceStreamFilter(input.onAssistantDelta)
      : null;

    /**
     * B0-948 — fact-tool enforcement. `requireFactToolForDraft` is consulted once, on the model's
     * first finished draft: if the draft asserts a fact category whose OWNING tool was never called
     * this turn, the runtime forces that one call and re-drafts. The outcome is captured here so
     * the agent step can persist it as a gate — a run report must be able to show that the
     * requirement fired (or did not) rather than leaving it invisible.
     */
    // A holder rather than a bare `let`: the runtime writes it from a callback, and TypeScript's
    // control-flow analysis would otherwise narrow the variable to `null` at every read below.
    const factToolEnforcementSink: { outcome: FactToolEnforcementOutcome | null } = {
      outcome: null,
    };
    const onFactToolEnforced = (outcome: FactToolEnforcementOutcome) => {
      factToolEnforcementSink.outcome = outcome;
    };
    /**
     * B0-984 — `undefined` when the flag is off, which makes both runtimes behave exactly as they
     * did before B0-948. When on, the check also learns whether a Betco product resolved this turn
     * (`speculativeProductLineLock`), so a compatibility claim in a product-less answer is not
     * forced into a `list_allowed_surfaces` lookup of a non-product.
     */
    // B0-976 — on the floor routes a reopening / walk-on question is checked FIRST: it is what the
    // user asked, and the draft that withholds the schedule asserts no fact category for B0-948 to
    // catch. Same flag, same one-forced-call-per-turn contract, same gate record.
    // B0-1031 — that check is now the first entry of a TABLE of floor question types with a
    // documented knowledge-corpus answer (stripper dwell, stripping failure, finish appearance
    // problem, maintenance cadence, dry-between-coats); `requireFloorProcedureTool` consults the
    // reopen check unchanged, then the table. Same contract, same gate.
    const factToolRequirementCheck = factToolEnforcementEnabled
      ? (check: { draftAnswer: string; toolNames: string[] }) =>
          requireFloorProcedureTool({
            ...check,
            userMessage: input.userMessage,
            effectivePromptId,
          }) ??
          requireFactToolForDraft({
            ...check,
            context: {
              productResolved: speculativeProductLineLock !== null,
              // B0-972 — lets the check recognise a list/superlative/organism-first ask and name
              // the batch `get_efficacy_data({ category, organism })` form instead of the
              // single-product form.
              userMessage: input.userMessage,
            },
          })
      : undefined;

    // Generation: the AI SDK (`streamText`) tool loop for every model, OpenAI and Anthropic alike
    // (B0-914). Returns { assistantText, finalResponseId, toolTrace, responseIds } consumed below;
    // `finalResponseId` is the synthetic `ai_sdk:<runId>` marker.
    const agentResult = await runAiSdkWithToolLoop({
      modelTag: input.modelTag,
      instructions,
      // B0-519 — capped tail, not the raw list; see `capConversationHistory`.
      history: cappedHistory,
      userMessage: input.userMessage,
      tools: routeTools,
      toolChoice,
      promptCacheKey,
      preloadedEvidence,
      maxOutputTokens,
      onAssistantDelta: confidenceStreamFilter?.onDelta,
      observeAssistantDelta,
      requireFactTool: factToolRequirementCheck,
      onFactToolEnforced,
      executeTool: executeToolForGeneration,
    });

    // B0-491 — flush whatever the filter was still holding back as a cautious lookahead (never
    // actually part of a marker); if a marker opened but never closed, this drops it silently.
    confidenceStreamFilter?.finish();

    // B0-491 — extract the model's self-reported confidence and strip the marker out of the text
    // BEFORE anything downstream (decline detection, cross-reference composition, the validator's
    // evidence summary, persistence) ever sees it.
    const { text: strippedAssistantText, selfConfidence: agentSelfConfidence } =
      extractAgentSelfConfidence(agentResult.assistantText);

    /**
     * B0-390 — reconcile the workflow's trace with what the runtime reported. Both normally hold the
     * SAME entries for model-chosen calls (the shared `executeTool` closure records each call on the
     * workflow side as the runtime records it on its own), so this is a no-op in practice — but the
     * persisted trace must never end up smaller than the runtime's own report, whatever a runtime
     * does internally. Runs before the safety-net / force-injected pushes below, so execution order
     * is preserved.
     */
    for (const entry of agentResult.toolTrace) {
      if (!resolvedToolTrace.some((recorded) => recorded.callId === entry.callId)) {
        resolvedToolTrace.push(entry);
      }
    }

    // B0-436 — one self-describing row per run so `/admin/observability` can tell a speculative
    // retrieval from a model-requested one, and see whether the model's own call reused it.
    audit.enqueue(
      'speculative_retrieval',
      {
        executed: speculation.result !== null,
        skipped_reason: speculation.skippedReason,
        ok: speculation.result?.trace.ok ?? null,
        used_as_evidence: usableSpeculation !== null,
        reuse_count: speculativeReuseCount,
        tool_choice_round_1: typeof toolChoice === 'string' ? toolChoice : toolChoice.name,
      },
      { ...wfCtx, stepId: agentStep.id, toolName: 'search_product_docs' },
    );

    // AI SDK has no OpenAI response id; use a synthetic marker so the persisted chain stays populated.
    const finalResponseId = agentResult.finalResponseId ?? `ai_sdk:${run.id}`;
    input.onEvent?.({ type: 'status', stage: 'agent_completed' });
    const timingBreakdown = {
      toolRounds: agentResult.responseIds.length,
      cacheSource: dominantCacheSource(cacheSourceCounts),
      searchMs:
        retrievalSamples > 0 ? Number((totalSearchMs / retrievalSamples).toFixed(1)) : null,
      ttftMs: ttftMs(),
    };

    /**
     * B0-436 + B0-390 — the speculative retrieval executes through `executeTool`, so it is already
     * in `resolvedToolTrace` (in execution order, first), and the reconciliation loop above has
     * folded in anything the generation runtime reported separately. B0-436's own prepend onto
     * `agentResult.toolTrace` is therefore unnecessary here and would double-count the call.
     */
    const crossReferenceIntent = forcedCrossReference;
    /**
     * B0-339 — the cross-reference post-processing below must not hinge on the routing label alone.
     * A cross-reference request phrased without "equivalent" ("Which Betco product replaces X?")
     * can still land on the `product` route, and gating on `routingDecision` meant the curated
     * override was looked up, matched, and then silently ignored. Explicit cross-reference intent
     * is treated as equivalent to the cross_reference route so the override always wins.
     */
    const useCrossReferencePostProcessing =
      routingDecision === 'cross_reference' || crossReferenceIntent;
    let crossReferenceResult =
      extractTopCrossReferenceMatchFromToolOutputs(toolOutputLog) ??
      extractTopCrossReferenceMatch(resolvedToolTrace);

    // Deterministic override safety-net: don't depend on the model to call lookup_cross_reference
    // with the competitor's exact name. On the cross_reference route, if no cross-reference surfaced,
    // consult the curated override directly with the resolved competitor identity — so a curated
    // equivalence (e.g. BNC-15 → Triforce) always wins.
    //
    // B0-357: `safetyNetArgs` used to be the whole raw message duplicated into both `brand` and
    // `productName`, relying on the lenient matcher's token-overlap scoring to find the competitor
    // mention buried inside it. That can't disambiguate two competitor products in one message and
    // fragments the (brand, product) pair the web-search cache key is built from. Replaced with the
    // ONE tuple `resolvedCompetitorPromise` resolved above, shared with the prefetch and the web
    // fallback below.
    let overrideFromSafetyNet = false;
    if (useCrossReferencePostProcessing && !crossReferenceResult) {
      const resolvedCompetitorForSafetyNet = resolvedCompetitorPromise
        ? await resolvedCompetitorPromise
        : { brand: null, product: input.userMessage, otherCompetitorProduct: null };
      const safetyNetArgs = {
        brand: resolvedCompetitorForSafetyNet.brand ?? '',
        productName: resolvedCompetitorForSafetyNet.product,
      };
      const safetyNetStartedAtMs = Date.now();
      // B0-461 — reuse the concurrently-kicked-off lookup when this run forced cross-reference
      // tool_choice from the start; identical args to a fresh call, just started earlier so its DB
      // round trip overlapped the model's forced tool-call round instead of stacking after it.
      const forced = safetyNetLookupPrefetch
        ? await safetyNetLookupPrefetch
        : await lookupCrossReference(safetyNetArgs);
      /**
       * B0-390 — this lookup bypasses `executeToolCall` entirely, so until now it produced no trace
       * entry at all: the run showed a cross-reference match that no recorded tool call could
       * explain. Recorded with the same previews and truncation flags as a real tool call, and
       * attributed so it is never read as a call the model chose. Logged whether or not it matched —
       * a lookup that found nothing is exactly what a reader needs to see.
       */
      resolvedToolTrace.push(
        buildToolTraceEntry({
          toolName: 'lookup_cross_reference',
          callId: `safety-net-xref-${safetyNetStartedAtMs}`,
          argumentsJson: JSON.stringify(safetyNetArgs),
          output: JSON.stringify(forced),
          ok: true,
          durationMs: Date.now() - safetyNetStartedAtMs,
          origin: 'safety_net_override',
        }),
      );
      const top = forced.matches?.[0];
      if (top && !forced.fallbackRecommended) {
        crossReferenceResult = {
          fallbackRecommended: false,
          match: top as unknown as CrossReferenceMatch,
        };
        overrideFromSafetyNet = true;
      }
    }

    /**
     * B0-183 / B0-355 — deterministic invocation backstop for `recommend_cross_reference`.
     *
     * `lookup_cross_reference` has had a deterministic safety net since B0-339 (the curated-override
     * block directly above). The second hop — the web-grounded recommendation engine — used to live
     * entirely in prompt text ("if `lookup_cross_reference` returns no matches or
     * `fallbackRecommended: true`, call `recommend_cross_reference`"), so a model that simply didn't
     * make the call fell through to generic RAG or a flat decline, and NOTHING in the run record
     * said the web path had been skipped: an absent `toolTrace` entry is indistinguishable from
     * "not applicable". B0-183's original version of this block only covered the
     * `routingDecision === 'cross_reference' && !crossReferenceResult` case, which misses both the
     * B0-339 intent-without-the-route turns AND the `fallbackRecommended: true` case (a weak legacy
     * match makes `crossReferenceResult` truthy, so the block never fired).
     *
     * `decideXrefBackstop` holds the three conditions; a row is enqueued for EVERY cross-reference
     * turn (fired or not), so the model's miss rate is `fired = true` over that population — one
     * query against `audit_logs`, instead of an invisible absence.
     */
    const modelCalledRecommendationEngine = toolOutputLog.some(
      (entry) => entry.toolName === RECOMMEND_CROSS_REFERENCE_TOOL && entry.ok,
    );
    const backstopDecision = decideXrefBackstop({
      crossReferencePostProcessing: useCrossReferencePostProcessing,
      legacyMatch: crossReferenceResult,
      modelCalledEngine: modelCalledRecommendationEngine,
    });

    let webFallback: Awaited<ReturnType<typeof runCrossReferenceRecommendation>> | null = null;
    let webFallbackCompetitorLabel = '';
    if (backstopDecision.fired) {
      // B0-357: reuse the SAME resolved (brand, product) tuple as the prefetch/safety-net above
      // instead of calling `extractCompetitorProduct` a second time for this turn — a second call is
      // not guaranteed to reproduce byte-identical output, which is exactly what fragmented the
      // `buildRecommendationQuery` cache key run-to-run before that ticket.
      const competitor = resolvedCompetitorPromise
        ? await resolvedCompetitorPromise
        : // B0-786 — same rule as the prefetch above: when the signals call ran, IT is this turn's
          // competitor identity, so this last-resort branch must not fire a second extraction.
          turnSignals
          ? competitorIdentityFromSignals(turnSignals, input.userMessage)
          : await extractCompetitorProduct(input.userMessage);
      /**
       * B0-779 — `competitor.product` is NEVER empty (it falls back to the raw message, see
       * `extractCompetitorProduct`), so `competitor.product.trim()` was never actually gating
       * anything here: this backstop fired the web-grounded engine on the raw message text even
       * when no competitor was named at all (PRO-045). `isCompetitorIdentityUnresolved` is the
       * real check — no brand and no confidently-extracted product means there is nothing to
       * cross-reference, so the engine must not be invoked on the raw message.
       */
      if (competitor.product.trim() && !isCompetitorIdentityUnresolved(competitor)) {
        webFallbackCompetitorLabel = [competitor.brand, competitor.product]
          .filter(Boolean)
          .join(' ')
          .trim();
        /**
         * B0-355 / B0-329 — the backstop runs AFTER the model's tool loop, so handing it a fresh
         * `totalBudgetMs` would stack a second full 20s+ ceiling onto an already-slow turn. It gets
         * the turn's REMAINING budget instead, floored at `XREF_BACKSTOP_MIN_BUDGET_MS` (below which
         * the engine cannot complete step 1 plus a budgeted web search, so a smaller budget would
         * only manufacture a timeout that says nothing about the real match). Per-step ceilings need
         * no adjustment: `createStepGuard` already clamps each one to the remaining total.
         */
        const backstopPolicy = resolveXrefBackstopPolicy(
          await loadXrefLatencyPolicy(),
          Date.now() - workflowStartedAtMs,
        );
        const backstopStartedAtMs = Date.now();
        webFallback = await runCrossReferenceRecommendation(
          { competitorProduct: competitor.product, competitorBrand: competitor.brand },
          { traceId: run.id },
          { policy: backstopPolicy },
        );
        /**
         * B0-355 — the backstop's invocation is recorded as a real tool call with
         * `origin: 'workflow_injected'`, so a reader can tell a backstop-forced engine run from one
         * the model chose (`model_chosen`) directly on the persisted step. Before this it executed
         * with no trace entry at all. Pushed into `toolOutputLog` in the SAME payload shape
         * `product-tools.ts` emits, so the B0-356 gate below reads model-called and backstopped runs
         * through one code path.
         */
        const backstopToolOutput = JSON.stringify({
          ok: true,
          adapter: 'cross_reference_recommendation_v1',
          source: webFallback.source,
          answered: webFallback.answered,
          status: webFallback.status,
          overallConfidence: webFallback.overallConfidence,
          thresholdUsed: webFallback.thresholdUsed,
          declineReason: webFallback.declineReason,
          candidates: webFallback.candidates,
          evidence: webFallback.evidence,
          recommendationId: webFallback.recommendationId,
        });
        const backstopTrace = buildToolTraceEntry({
          toolName: RECOMMEND_CROSS_REFERENCE_TOOL,
          callId: `xref-backstop-${backstopStartedAtMs}`,
          argumentsJson: JSON.stringify({
            competitorProduct: competitor.product,
            competitorBrand: competitor.brand,
          }),
          output: backstopToolOutput,
          ok: true,
          durationMs: Date.now() - backstopStartedAtMs,
          origin: 'workflow_injected',
        });
        resolvedToolTrace.push(backstopTrace);
        toolOutputLog.push({
          toolName: RECOMMEND_CROSS_REFERENCE_TOOL,
          ok: true,
          output: backstopToolOutput,
          trace: backstopTrace,
        });
        audit.enqueue(
          'recommendation_web_fallback',
          {
            competitor_label: webFallbackCompetitorLabel,
            source: webFallback.source,
            status: webFallback.status,
            answered: webFallback.answered,
            overall_confidence: webFallback.overallConfidence,
            recommendation_id: webFallback.recommendationId,
          },
          wfCtx,
        );
      }
    }
    // B0-355 — one row per cross-reference turn, fired or not, so the miss rate has a denominator.
    if (useCrossReferencePostProcessing) {
      audit.enqueue(
        'recommendation_backstop',
        {
          fired: backstopDecision.fired,
          reason: backstopDecision.reason,
          model_called_engine: modelCalledRecommendationEngine,
          legacy_match_present: crossReferenceResult !== null,
          legacy_fallback_recommended: crossReferenceResult?.fallbackRecommended ?? null,
          routing_decision: routingDecision,
          /** Null when the backstop did not fire, or fired but found no competitor to look up. */
          engine_status: webFallback?.status ?? null,
          engine_answered: webFallback?.answered ?? null,
          min_budget_ms: XREF_BACKSTOP_MIN_BUDGET_MS,
        },
        { ...wfCtx, stepId: agentStep.id, toolName: RECOMMEND_CROSS_REFERENCE_TOOL },
      );
    }

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
        // B0-390 — executed by the workflow, not chosen by the model.
        origin: 'workflow_injected',
        auditCtx: wfCtx,
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
        extractTopCrossReferenceMatch(resolvedToolTrace) ??
        crossReferenceResult;
    }

    /**
     * B0-357 — resolve (by now, virtually always already-settled) the ONE competitor-identity
     * tuple for this turn, whether or not any consumer above ended up needing it (the model's own
     * forced tool call can still match on the first try, in which case neither the safety net nor
     * the web fallback ever awaits `resolvedCompetitorPromise`). Recorded as its own gate so a bad
     * resolution — including which of two named competitor products was picked — is diagnosable
     * from the trace, and persisted on `finalOutput.resolvedCompetitor` below (see AC).
     */
    const resolvedCompetitor: ExtractedCompetitor | null = resolvedCompetitorPromise
      ? await resolvedCompetitorPromise
      : null;
    const competitorIdentityGate: GateRecord | null = competitorIdentityNeeded
      ? {
          gate: 'competitor_identity_resolution',
          inputs: {
            resolvedBrand: resolvedCompetitor?.brand ?? null,
            resolvedProduct: resolvedCompetitor?.product ?? null,
            otherCompetitorProductDetected: resolvedCompetitor?.otherCompetitorProduct ?? null,
            trigger:
              routingDecision === 'cross_reference' ? 'cross_reference_route' : 'cross_reference_intent',
          },
          thresholds: {
            // B0-904 — the resolved model id the identity actually came from (`null` when no model
            // call produced it: the extraction fallback or a degraded signals turn), never a re-read
            // of the XREF_COMPETITOR_EXTRACT_MODEL setting, which could differ from what ran.
            extractionModel: resolvedCompetitor?.model ?? null,
          },
          verdict: resolvedCompetitor?.otherCompetitorProduct ? 'resolved_with_alternate' : 'resolved',
          effect: resolvedCompetitor?.otherCompetitorProduct
            ? `Two competitor products were named; deterministically picked "${[resolvedCompetitor.brand, resolvedCompetitor.product].filter(Boolean).join(' ')}" over "${resolvedCompetitor.otherCompetitorProduct}" as the one being cross-referenced. Reused by the forced-lookup prefetch, the deterministic override safety net, and the web-search backstop.`
            : `Resolved competitor identity: brand="${resolvedCompetitor?.brand ?? '(none)'}", product="${resolvedCompetitor?.product ?? '(none)'}". Reused by the forced-lookup prefetch, the deterministic override safety net, and the web-search backstop.`,
        }
      : null;

    /**
     * B0-507 — await the shadow classification kicked off far earlier (alongside
     * `resolvedCompetitorPromise`, above): by this point in the turn the full tool-call round has
     * already run, so the classifier's ~800ms budget has almost always already elapsed and this
     * await resolves immediately. `classifyUserIntent` never rejects (it falls back to the
     * keyword router internally on any error/timeout), so this cannot fail the turn.
     *
     * Recorded purely for observability — `keywordRoutingDecision` is what actually routed this
     * turn; `classifiedIntent` is never substituted for it while shadow mode is on.
     */
    const shadowIntentClassification: IntentClassification | null = shadowIntentClassificationPromise
      ? await shadowIntentClassificationPromise
      : null;
    const intentClassifierShadowGate: GateRecord | null = shadowIntentClassification
      ? {
          gate: 'llm_intent_classifier_shadow',
          inputs: {
            classifiedIntent: shadowIntentClassification.intent,
            classifierConfidence: shadowIntentClassification.confidence,
            classifierSource: shadowIntentClassification.source,
            classifierFallbackReason: shadowIntentClassification.fallbackReason,
            entities: shadowIntentClassification.entities,
            suggestedTool: shadowIntentClassification.suggestedTool,
            keywordRoutingDecision: routingDecision,
          },
          thresholds: {
            model: routerModel,
            timeoutMs: routerTimeoutMs,
          },
          verdict:
            shadowIntentClassification.intent === routingDecision
              ? 'agrees_with_keyword_router'
              : 'disagrees_with_keyword_router',
          effect: `Shadow mode only: the classifier proposed "${shadowIntentClassification.intent}" (confidence ${shadowIntentClassification.confidence}, source ${shadowIntentClassification.source}) while the keyword router actually routed this turn to "${routingDecision}". Not used to route this turn; recorded for rollout comparison only.`,
        }
      : null;

    let draftAnswer = strippedAssistantText;
    /**
     * B0-391 — the single mutable answer-provenance cursor. Several branches below overwrite the
     * answer, so the rule is LAST WRITER THAT ACTUALLY CHANGED THE TEXT WINS: whatever survives here
     * must describe what the user really saw, not the first branch that touched the draft. A
     * composition that returns the text unchanged deliberately does NOT claim provenance.
     */
    let answerProvenance: AnswerProvenance = 'model_generated';
    // A curated-override match (carries analysis facts) is authoritative on the cross_reference
    // route — build a full competitive analysis from those facts + retrieved context, replacing
    // whatever product the model may have drafted. Works even with no web URL (Triforce, OnWeb=0).
    const isOverrideMatch =
      useCrossReferencePostProcessing &&
      !!crossReferenceResult &&
      (overrideFromSafetyNet ||
        !!crossReferenceResult.match.rationale ||
        !!crossReferenceResult.match.competitorEpaReg);
    if (isOverrideMatch && crossReferenceResult) {
      const m = crossReferenceResult.match;
      const ctx = await fetchRecommendationContext({
        chemistryClass: m.chemistryClass ?? null,
        betcoProductLineId: m.betcoProductLineId ?? null,
      });
      const recommendedTitle = (m.betcoProduct?.title ?? '')
        .replace(/\s*\([^)]*\b(gal|bottle|case|oz|ct|pack|drum|pail|fastdraw|liter|l)\b[^)]*\)\s*$/i, '')
        .trim();
      draftAnswer = buildCompetitiveRecommendationAnswer({
        competitorLabel: [m.competitorBrand, m.competitorProductName]
          .filter(Boolean)
          .join(' '),
        recommendedTitle: recommendedTitle || 'the recommended Betco product',
        recommendedUrl: m.productUrl,
        chemistryClass: m.chemistryClass ?? null,
        competitorEpa: m.competitorEpaReg ?? null,
        betcoEpa: ctx.betcoEpaRegistration,
        rationale: m.rationale ?? null,
        alternatives: ctx.alternatives,
      });
      // B0-391 — code-composed template; the model's draft was discarded wholesale.
      answerProvenance = 'template_override';
    } else if (crossReferenceResult?.match.productUrl?.trim()) {
      draftAnswer = composeCrossReferenceUserFacingAnswer({
        match: crossReferenceResult.match,
        assistantText: strippedAssistantText,
      });
      // The composer is a no-op on a declined answer, or one that already leads with the comparable
      // link — claiming composition there would overstate what the workflow did to the text.
      if (draftAnswer.trim() !== strippedAssistantText.trim()) {
        answerProvenance = 'cross_reference_composed';
      }
    } else if (webFallback) {
      // B0-183 — surface the web-grounded fallback outcome. An answered result is authoritative on the
      // cross_reference route (it already passed the engine's grounding + validator gate); a declined /
      // pending result becomes a decline the user sees and is already queued for human 1-1 review.
      draftAnswer = buildWebFallbackAnswer({
        result: webFallback,
        competitorLabel: webFallbackCompetitorLabel,
      }).answerText;
    }

    /**
     * B0-356 — enforce the recommendation engine's OWN verdict.
     *
     * `recommend_cross_reference` returns `answered`, `status`, `overallConfidence`, `thresholdUsed`
     * and `declineReason`, and the specialist prompt calls them authoritative — but until this
     * ticket nothing read them: both cross-reference extractors filter on `lookup_cross_reference`
     * and skipped the engine payload entirely. So an engine decline (sub-threshold score, a
     * validator-forced `escalated`, or a B0-329 latency-ceiling trip returning `XREF_DECLINE_COPY`)
     * could be paraphrased away by the model and shipped at the workflow's default
     * `confidence: 0.9`, discarding `filterGroundedCandidates` and `scanUnsupportedSafetyClaims` on
     * a product-equivalence claim for EPA-registered chemistry.
     *
     * The gate is skipped when a CONFIDENT legacy/curated 1:1 match is what grounds this turn
     * (`fallbackRecommended === false`): that mapping is human-curated and authoritative, the engine
     * would have returned it from its own step-1 fast path anyway, and REC-4's
     * `evaluateRecommendationGate` already calibrates its confidence below. A weak legacy match
     * (`fallbackRecommended: true`) is NOT authoritative and does not skip the gate — that case is
     * exactly the B0-355 backstop's reason for existing.
     */
    const recommendationEngineOutcome =
      extractRecommendationEngineOutcomeFromToolOutputs(toolOutputLog);
    const legacyMatchIsAuthoritative = Boolean(
      crossReferenceResult && !crossReferenceResult.fallbackRecommended,
    );
    // B0-756 — this gate's numeric cap is calibrated against XREF_RECOMMENDATION_MIN_CONFIDENCE,
    // one of the recommendation-path signals real calibration data showed to be non-predictive;
    // it reads the split, recommendation-only kill switch, not the general one.
    const recommendationConfidenceGatingDisabled =
      runtimeConfig.recommendationConfidenceGatingDisabled ?? true;
    const recommendationEngineGate =
      recommendationEngineOutcome && !legacyMatchIsAuthoritative
        ? evaluateRecommendationEngineGate({
            outcome: recommendationEngineOutcome,
            // Placeholder: the engine's cap is re-applied against the REAL confidence at the
            // validator step below (this call only decides the answer text). Passing 1 here keeps
            // `declineText` / `requiresHumanReview` decisions independent of confidence.
            confidence: 1,
            approved: true,
            requiresHumanReview: false,
            confidenceGatingDisabled: recommendationConfidenceGatingDisabled,
            fallbackDeclineCopy: XREF_DECLINE_COPY,
          })
        : null;
    if (recommendationEngineGate?.declineText) {
      // Verbatim, and it outranks whatever the model drafted: there is no grounded equivalent to
      // state. Enforced even under `BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING` — see the
      // kill-switch note in `evaluateRecommendationEngineGate`.
      //
      // B0-875 — the engine text stays verbatim; for a claim-equivalence question ("kills
      // everything X does, right?") the regulatory non-transfer statement is placed IN FRONT of
      // it, because the decline alone answers nothing about the claim the user assumed.
      draftAnswer = buildRecommendationEngineDeclineCopy({
        userMessage: input.userMessage,
        engineDeclineText: recommendationEngineGate.declineText,
      });
      answerProvenance = 'recommendation_engine_decline';
    }

    /**
     * B0-779 — final backstop against a fabricated "Comparable Betco product" match line.
     *
     * `resolvedCompetitor` is the turn's SINGLE competitor-identity resolution (B0-357,
     * `extractCompetitorProduct`), shared by the forced-lookup prefetch, the curated override
     * safety net, and the web-search backstop above. When it comes back with neither a brand nor a
     * confidently-extracted product, there is no competitor identity to match against — and that
     * holds regardless of HOW a match line reached `draftAnswer`: the backstop is already gated
     * above (`isCompetitorIdentityUnresolved`), but the model can also call `recommend_cross_reference`
     * itself with the same degraded identity (PRO-036's shape) and, per its own prompt instructions,
     * append a "Comparable Betco product" line whenever the tool call returns a `productUrl` — which
     * `recommendationEngineGate` above does NOT catch when the engine's own confidence gate happened
     * to clear (PRO-045's fabricated "Portable Chemical Management System" match). This check is the
     * last writer specifically because of that: it must outrank a model-drafted match line the
     * engine itself approved.
     *
     * Deliberately does NOT touch `isOverrideMatch` / `crossReferenceResult` — those are the
     * curated/legacy `lookup_cross_reference` match, whose matching quality is explicitly out of
     * scope for this guard (B0-779); it only ever overrides a web-grounded match (the backstop's or
     * the model's own `recommend_cross_reference` call).
     */
    const hasLegacyOrCuratedMatch =
      isOverrideMatch || Boolean(crossReferenceResult?.match.productUrl?.trim());
    if (
      useCrossReferencePostProcessing &&
      !hasLegacyOrCuratedMatch &&
      resolvedCompetitor &&
      isCompetitorIdentityUnresolved(resolvedCompetitor)
    ) {
      // B0-875 — no competitor identity means there is nothing to decline ABOUT: ask for the brand
      // and exact product name instead of the fixed sales-rep copy (P#10), and say what a
      // cross-reference finds (comparable, never "identical").
      draftAnswer = buildCompetitorIdentityClarification({ userMessage: input.userMessage });
      answerProvenance = 'competitor_identity_unresolved_decline';
    }

    /**
     * B0-875 — the self-reference check found a chemistry-class DESCRIPTION in place of a product
     * ("Diversey quat disinfectant", P#8). The turn was withdrawn from the cross-reference path at
     * routing time (no forced lookup, no backstop, no engine gate), so whatever the product
     * specialist drafted is replaced with the clarifying question: which product (label name +
     * EPA registration number) and why it matters. Deterministic, like the two guards above, so a
     * model draft can never name a Betco product for an unnamed competitor.
     */
    if (
      selfReferenceVerdict?.suppressed &&
      selfReferenceVerdict.reason === 'generic_chemistry_description'
    ) {
      draftAnswer = buildGenericChemistryClarification({ described: selfReferenceVerdict.matched });
      answerProvenance = 'generic_chemistry_clarification';
    }

    // B0-349 — frozen snapshot of the fully-composed answer before the validator, revision pass,
    // or any downstream gate can touch it.
    const originalDraftAnswer = draftAnswer;

    const sources = collectSourcesFromToolOutputs(toolOutputLog);
    const retrieved_document_chunks =
      collectRetrievedDocumentChunksFromToolOutputs(toolOutputLog);
    const retrieval_calls = collectRetrievalCallsFromToolOutputs(toolOutputLog);
    const sourceMeta = collectSourceMetaFromToolOutputs(toolOutputLog);
    /**
     * B0-885 — re-fetch the full (unwindowed) document body per distinct real source so both the
     * validator/revision evidence summary below and the regulated-claim guardrail further down
     * ground against the same thing. `sourceMeta[].documentBody` is only the narrowed
     * matched-chunk-plus-neighbors window shown to the generator (B0-547); this is the whole
     * approved document. Never reaches the model or the persisted tool payload directly — it costs
     * one extra DB read, not extra prompt tokens (the evidence summary below is still capped at the
     * existing 60k/24k budgets). Synthetic sources (e.g. `VERIFIED_FACTS_SOURCE_ID`,
     * `'verified-facts'`, and its batch composite form `verified-facts:<productLineKey>`) are not
     * `rag.document` rows and are not valid uuids — `document_id` is a uuid column, so passing one
     * through to `assembleDocumentBodies`'s `.in('document_id', ...)` filter throws a hard Postgres
     * error rather than just omitting that row. Filter to real-looking document ids first; a
     * synthetic source's `documentBody` (already the full facts/lab-report block, not a chunk
     * window) is used as-is via `buildEvidenceSummary`'s fallback.
     */
    const UUID_PATTERN =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const fullDocumentBodies = await assembleDocumentBodies(
      sourceMeta.map((s) => s.documentId).filter((id) => UUID_PATTERN.test(id)),
    );
    // B0-490 — raw (pre-curation) vs. post-selection top retrieval similarity for this turn.
    const similarityRollup = extractSimilarityRollupFromToolOutputs(toolOutputLog);
    const usageSafetyCoverage = evaluateUsageSafetyCoverage(sourceMeta);
    /**
     * B0-872 — the gate now needs BOTH a usage/safety-shaped question and an identifiable product
     * subject (see `queryNeedsUsageAndSafetyCoverage`). `resolvedToolTrace` is complete here (the
     * tool loop has returned), so the B0-619 product-line lock is readable from it; the same
     * `extractProductLineLockFromToolTrace` call is repeated for the final-output rollup below.
     */
    const usageSafetyQuestionShape = hasUsageSafetyQuestionShape(input.userMessage);
    const usageSafetyProductSubject = resolveUsageSafetyProductSubject({
      productLineLock: extractProductLineLockFromToolTrace(resolvedToolTrace),
      signalsProductLineKey: signalsDecided ? turnSignals?.resolvedProductLineKey : null,
      toolTrace: resolvedToolTrace,
    });
    const needsUsageSafetyCoverage = queryNeedsUsageAndSafetyCoverage(
      input.userMessage,
      usageSafetyProductSubject,
    );
    /**
     * B0-546 — gate for skipping the validator's LLM pass entirely: retrieval already found a
     * near-exact match (`topSourceSimilarity` clears `resolveValidatorSkipMinSimilarity()`) AND the
     * route is not safety-sensitive. Computed here (before the validator step even calls the
     * model) so it can also decide whether that step's `input` records a prompt at all.
     */
    const topSourceSimilarity = sources.reduce(
      (max, s) => (typeof s.similarity === 'number' && s.similarity > max ? s.similarity : max),
      0,
    );
    const canSkipValidatorForHighSimilarity =
      isValidatorSkipEnabled() &&
      sources.length > 0 &&
      topSourceSimilarity >= resolveValidatorSkipMinSimilarity() &&
      !isSafetySensitiveRoute(input.userMessage, routingDecision);
    let evidenceSummary = buildEvidenceSummary(sourceMeta, fullDocumentBodies);
    // A competitive recommendation is grounded by its cross-reference match, not by RAG chunks.
    // Feed that match to the validator as evidence so it doesn't reject the recommendation as
    // "unsupported" (a curated/legacy cross-reference IS the support for the equivalence claim).
    if (useCrossReferencePostProcessing && crossReferenceResult) {
      const m = crossReferenceResult.match;
      const competitorLabel = [m.competitorBrand, m.competitorProductName]
        .filter(Boolean)
        .join(' ');
      const xref = [
        `Cross-reference match (confidence ${m.confidence}):`,
        `competitor "${competitorLabel}" maps to Betco "${m.betcoProduct?.title ?? ''}"${
          m.betcoProduct?.sku ? ` (SKU ${m.betcoProduct.sku})` : ''
        }.`,
        'This curated/legacy cross-reference is authoritative evidence that the recommended Betco product is the correct equivalent for the competitor product.',
      ].join(' ');
      evidenceSummary = evidenceSummary ? `${xref}\n\n${evidenceSummary}` : xref;
    }
    // B0-183 — same for a web-grounded fallback recommendation, so the (opt-in) validator doesn't
    // reject an already-gated web answer as "unsupported" for lack of RAG chunks.
    if (routingDecision === 'cross_reference' && webFallback?.answered) {
      const top = webFallback.candidates[0];
      const xref = [
        `Web-grounded cross-reference (confidence ${webFallback.overallConfidence.toFixed(2)}):`,
        `competitor "${webFallbackCompetitorLabel}" maps to Betco "${top?.betcoTitle ?? ''}".`,
        "This web-grounded recommendation already passed the recommendation engine's grounding and validator gate; it is the support for the equivalence claim.",
      ].join(' ');
      evidenceSummary = evidenceSummary ? `${xref}\n\n${evidenceSummary}` : xref;
    }

    /**
     * B0-563 — `extractCompetitorProduct`'s call (via `resolvedCompetitor`, resolved above) runs
     * inside this step's window but outside `agentResult`'s own tool loop, so its usage was
     * previously uncounted. Folded in here rather than left on `resolvedCompetitor` alone, so this
     * step's `usage`/`usageByCall` stay the single source of truth for "every model call this step
     * made".
     */
    const agentStepUsageByCall = resolvedCompetitor
      ? [...agentResult.usageByCall, resolvedCompetitor.usage]
      : agentResult.usageByCall;
    const agentStepUsage = resolvedCompetitor
      ? sumLlmUsage(agentStepUsageByCall)
      : agentResult.usage;

    /**
     * B0-948 — the enforcement outcome, as a gate record on the agent step and as an
     * `activeGates` entry on the run. Without this the forced call is invisible: it looks like an
     * ordinary tool call in the trace and the run report cannot tell a turn that needed no
     * enforcement from one where the requirement fired.
     */
    const factToolEnforcement = factToolEnforcementSink.outcome;
    const factToolEnforcementActivation: GateActivationRecord = !factToolEnforcementEnabled
      ? { state: 'skipped', reason: 'disabled_by_flag' }
      : !factToolEnforcement
        ? { state: 'not_applicable' }
      : !factToolEnforcement.requiredTool
        ? { state: 'ran', verdict: 'passed' }
        : factToolEnforcement.enforced
          ? { state: 'ran', verdict: 'enforced' }
          : {
              state: 'ran',
              verdict: 'not_enforced',
              ...(factToolEnforcement.reason ? { reason: factToolEnforcement.reason } : {}),
            };
    const factToolEnforcementGate: GateRecord | null = factToolEnforcement
      ? {
          gate: 'fact_tool_enforcement',
          inputs: {
            requiredTool: factToolEnforcement.requiredTool,
            toolNamesCalled: agentResult.toolTrace.map((entry) => entry.toolName),
            toolSucceeded: factToolEnforcement.toolSucceeded,
            ...(factToolEnforcement.reason ? { reason: factToolEnforcement.reason } : {}),
            // B0-984 — the draft before the forced round, so a report can diff what changed.
            ...(factToolEnforcement.preEnforcementDraft
              ? { preEnforcementDraft: factToolEnforcement.preEnforcementDraft }
              : {}),
          },
          thresholds: {
            note: 'category-driven, not count-driven: every fact category the draft asserts must have its owning tool in this turn\'s trace',
            maxForcedRoundTripsPerTurn: 1,
          },
          verdict: factToolEnforcementActivation.verdict ?? 'not_applicable',
          effect: !factToolEnforcement.requiredTool
            ? 'Every fact category the draft asserts already had its owning tool in this turn\'s trace; the draft was finalized unchanged.'
            : factToolEnforcement.enforced
              ? `The draft asserted a fact owned by ${factToolEnforcement.requiredTool}, which had not been called; that call was forced (ok=${String(factToolEnforcement.toolSucceeded)}) and the answer re-drafted against its result.`
              : `The draft asserted a fact owned by ${factToolEnforcement.requiredTool}, which had not been called, but the call could not be forced (${factToolEnforcement.reason ?? 'unknown'}); the draft stands as written and the regulated-claim guardrail still judges it.`,
        }
      : null;

    await completeWorkflowStep(agentStep.id, {
      status: 'completed',
      output: jsonContent({
        responseIds: agentResult.responseIds,
        /**
         * B0-390 — kept for back-compat (the observability timeline spreads it into the step detail
         * as `toolCalls`, and it is asserted by the B0-386 failure-attribution test), but it now
         * counts the RESOLVED trace. It used to count `agentResult.toolTrace`, which excluded the
         * workflow's forced/injected calls and therefore disagreed with the trace beside it.
         */
        toolCalls: resolvedToolTrace.length,
        /**
         * Full per-call trace (B0-331) so the observability timeline can render
         * arguments/output previews, ok flags and durations without a migration.
         *
         * B0-390 — the RESOLVED trace: the force-injected cross-reference search and the
         * safety-net lookup used to execute without ever being persisted.
         *
         * B0-436 — the speculative retrieval is in here too (it runs through `executeTool`),
         * flagged `speculative: true`.
         */
        toolTrace: resolvedToolTrace,
        // B0-324 — token usage for the turn plus the per-model-call breakdown, so prompt-cache
        // reuse across the multi-round tool loop is verifiable from the persisted step alone
        // (`cachedPromptTokens` should be non-zero from the 2nd call onward).
        // B0-563 — includes the competitor-extraction call's usage (see agentStepUsage above).
        usage: agentStepUsage,
        usageByCall: agentStepUsageByCall,
        // B0-563 — the model this step's primary calls ran on, so cost views can join
        // `model_pricing` without reading three different jsonb shapes.
        model,
        // B0-491 — the agent's own self-reported confidence, persisted alongside the B0-390 tool
        // trace on this same step row (never the validator/step-level `confidence`).
        agentConfidence: agentSelfConfidence.agentConfidence,
        agentConfidenceBasis: agentSelfConfidence.agentConfidenceBasis,
        agentConfidenceReason: agentSelfConfidence.reason,
        // B0-357 — the one resolved competitor-identity gate for this turn, when it ran.
        // B0-507 — the shadow-mode classifier comparison, when the classifier ran.
        ...recordGates([
          ...(competitorIdentityGate ? [competitorIdentityGate] : []),
          ...(intentClassifierShadowGate ? [intentClassifierShadowGate] : []),
          // B0-948 — what the fact-tool requirement did on this turn.
          ...(factToolEnforcementGate ? [factToolEnforcementGate] : []),
        ]),
      }),
    });
    markStepClosed(agentStep.id);

    const validationStep = await insertWorkflowStep({
      workflow_run_id: run.id,
      step_name: 'validator',
      status: 'running',
      input: jsonContent({
        modelTag: input.modelTag ?? 'preview',
        // B0-349 — the answer as composed before this step's validator pass could touch it.
        // Recorded unconditionally (validator on or off) so it's a true superset of "every run".
        draftAnswer: originalDraftAnswer,
        /**
         * B0-389 — recorded only when the pass actually calls a model. On the bypassed path
         * (`useValidator === false`, the test runner's default) there is no model call, and a prompt
         * record there would make a step that never ran look like it had. The bypass is instead
         * declared in the step's output (`skipped` + `VALIDATOR_BYPASS_REASON`).
         *
         * B0-546 — same reasoning applies to the high-similarity skip: `canSkipValidatorForHighSimilarity`
         * means this run never calls the model either, so no prompt is recorded for it.
         */
        ...(useValidator && !canSkipValidatorForHighSimilarity
          ? recordPrompt({
              stage: 'validator',
              instructions: VALIDATOR_SYSTEM_PROMPT,
              model: await resolveValidatorModel(input.modelTag),
              runtime: 'responses',
            })
          : {}),
      }),
    });
    markStepOpen(validationStep.id);
    input.onEvent?.({ type: 'status', stage: 'validation_started' });

    // B0-368 — set when the revision pass refused to re-ground, so the eventual
    // human-review escalation is distinguishable from a plain validator rejection.
    let revisionPassRefused = false;
    /**
     * B0-886 — whether `draftAnswer` at any later point in this turn is the REVISION pass's text
     * (possibly recomposed by `composeCrossReferenceUserFacingAnswer`) rather than the untouched
     * original draft. Used at the final "keep it visible" branch below to pick between
     * `validator_rejected_draft_retained` (original) and `revised_answer_retained` (revised) —
     * collapsing the two lost exactly which text the user saw whenever the second validator pass
     * also rejected a successfully-revised answer.
     */
    let draftReplacedByRevision = false;
    /**
     * B0-886 — the first validator pass's own result, snapshotted before the revision pass (or the
     * second validator pass it can trigger) can overwrite `validation`. Persisted alongside
     * `validation` so a rewritten answer's original rejection reason is never lost.
     */
    let validationFirstPass: ValidatorResult | null = null;
    /**
     * B0-886 — the revision pass's raw (preamble-stripped) output, captured before any later
     * redaction or cross-reference recomposition can change it further. Null when no revision pass
     * ran, or it ran and was refused.
     */
    let revisedAnswerRecord: string | null = null;
    /**
     * B0-923 — the draft exactly as it stood IMMEDIATELY BEFORE the revision pass overwrote it:
     * the text that would have shipped had the revision pass not run. Deliberately not
     * `strippedAssistantText` — the cross-reference branches above legitimately recompose
     * `draftAnswer` before this point, and this snapshot must carry those.
     *
     * Read only by the regulated-claim guardrail below, to separate a regulated claim the MODEL
     * asserted from safety framing OUR revision pass added on top of it. Null when no revision pass
     * replaced the draft this turn.
     */
    let preRevisionDraftAnswer: string | null = null;
    // B0-554 — per-model-call usage for every call this step makes (0, 1, or 2: the validator can
    // run twice when the revision pass produces a re-check), summed onto the step's output below.
    const validatorUsageByCall: LlmTokenUsage[] = [];
    /**
     * B0-358 — this is NOT a temporary toggle awaiting re-tuning (the TODO that used to sit here
     * claimed it was, with no ticket behind it). `useValidator` defaulting to `false` is the
     * documented REC-4 decision recorded above: the claims validator requires RAG evidence for
     * every assertion, which a competitive recommendation — grounded by a cross-reference match,
     * not by retrieved chunks — cannot satisfy, so it rejected valid recommendations and the
     * not-approved fallback overwrote them. The deterministic guardrails (regulated-claim
     * grounding, usage/safety coverage, `evaluateRecommendationGate`) run regardless. What B0-358
     * changes is only LEGIBILITY: `validatorMode` below says outright which of the three states a
     * run reached, instead of leaving the answer to a magic string inside `validation.issues`.
     */
    const validatorLlmPassRan = useValidator && !canSkipValidatorForHighSimilarity;
    const validatorMode: ValidatorMode = validatorLlmPassRan ? 'llm' : 'bypassed';
    let validation: ValidatorResult;
    if (useValidator && !canSkipValidatorForHighSimilarity) {
      const pass = await runValidatorPass({
        draftAnswer,
        evidenceSummary,
        modelTag: input.modelTag,
      });
      validatorUsageByCall.push(pass.usage);
      validation = pass;
    } else if (useValidator) {
      // B0-546 — high-similarity, non-safety route: skip the LLM pass and use the same
      // heuristic-confidence shape as the `useValidator === false` bypass, tagged with its own
      // reason so the two skip paths stay distinguishable in the trace.
      validation = {
        approved: true,
        confidence: Math.max(0.9, topSourceSimilarity),
        issues: [VALIDATOR_SKIP_HIGH_SIMILARITY_REASON],
        requires_human_review: false,
      };
    } else {
      validation = {
        approved: true,
        confidence: sources.length > 0 ? 0.9 : 0.6,
        issues: [VALIDATOR_BYPASS_REASON],
        requires_human_review: false,
      };
    }
    // B0-492 — the base provenance for this run's confidence chain; every cap below only ever
    // moves this to `gate_capped` (via `applyConfidenceCap`), never back.
    let confidenceState: ConfidenceProvenanceState = {
      provenance: useValidator ? 'validator_judged' : 'validator_bypassed_heuristic',
      preCapValue: null,
      preCapProvenance: null,
    };

    /**
     * B0-358 — `validatorMode` travels on the audit payload too, not only on the step row. The
     * observability timeline picks its `llm_validator` vs `validator_bypass` gate label from THIS
     * payload (`~/lib/observability/timeline.ts`), and it used to do so by string-matching
     * `issues.includes('validator_bypassed_for_testing')`. With the mode present, that token is
     * redundant rather than load-bearing.
     */
    audit.enqueue(
      'validation_completed',
      { ...validation, validatorMode },
      {
        ...wfCtx,
        stepId: validationStep.id,
      },
    );

    if (useValidator && !validation.approved && validation.issues.length > 0) {
      // B0-886 — snapshot the first pass BEFORE anything below can overwrite `validation`.
      validationFirstPass = validation;

      /**
       * B0-886 — optional skip: when every first-pass issue is already a
       * `regulated_claim_unverified:*` marker, the deterministic redaction planner
       * (`planRegulatedClaimRedaction`, evaluated later this turn) handles the rejection without an
       * LLM rewrite, and running the revision pass on top risks paraphrasing away the exact
       * verbatim citation that planner needs. Gated behind a settings flag (default OFF) pending
       * Tom's decision on the epic — see `isRevisionSkipForRegulatedClaimOnlyEnabled`'s doc comment
       * for why this condition cannot yet be true given the current call order (the guardrail that
       * produces this issue shape runs AFTER this gate, not before).
       */
      const skipRevisionForRegulatedClaimOnly =
        isOnlyRegulatedClaimIssues(validation.issues) &&
        (await isRevisionSkipForRegulatedClaimOnlyEnabled());

      if (skipRevisionForRegulatedClaimOnly) {
        validation = { ...validation, requires_human_review: true };
        audit.enqueue(
          'revision_skipped_regulated_claim_only',
          { issues: validation.issues },
          { ...wfCtx, stepId: validationStep.id },
        );
      } else {
        /**
         * B0-389 — the revision pass is its own model call, with its own prompt, model and output,
         * so it gets its own step. Filing it under the validator step (as it was) made a rewritten
         * answer look like the validator had produced it.
         */
        const revisionStep = await insertWorkflowStep({
          workflow_run_id: run.id,
          step_name: 'revision',
          status: 'running',
          input: jsonContent({
            modelTag: input.modelTag ?? 'preview',
            validatorIssues: validation.issues,
            ...recordPrompt({
              stage: 'revision',
              instructions: REVISION_SYSTEM_PROMPT,
              model: await resolveRevisionModel(input.modelTag),
              runtime: 'responses',
            }),
          }),
        });
        markStepOpen(revisionStep.id);

        const revisionResult = await runRevisionPass({
          draftAnswer,
          validatorIssues: validation.issues,
          evidenceSummary,
          modelTag: input.modelTag,
        });
        // B0-886 — `runRevisionPass` already stripped a leaked "Revised Answer:"-style preamble.
        const revised = revisionResult.text.trim();
        // The revision pass is told to refuse / ask for docs when it can't ground the flagged
        // claims. Never let such a refusal OVERWRITE a substantive answer the user already saw —
        // keep the draft and flag it for review instead. This matters most for cross_reference,
        // whose helpful usage/safety detail often isn't in the retrieved marketing profile.
        const revisionRefused =
          !revised ||
          isDeclineAnswer(revised) ||
          /clarification needed|could not (fully )?verify|cannot (revise|fix|provide|answer)|no( supporting)? evidence (was |has been )?provided|no( supporting)? evidence (is |was )?available|please (supply|provide) (approved )?(documentation|references|evidence)|supply (approved )?documentation/i.test(
            revised,
          );

        /**
         * B0-389 — closed before the (optional) second validator pass, which is a VALIDATOR call and
         * stays on the validator step. The output says what the revision produced and whether it was
         * taken: a refusal deliberately keeps the original draft, so `outcome` records that the
         * answer the user saw is still the draft.
         */
        await completeWorkflowStep(revisionStep.id, {
          status: 'completed',
          output: jsonContent({
            refused: revisionRefused,
            outcome: revisionRefused ? 'refused_draft_retained' : 'draft_replaced',
            revisedAnswer: revised,
            // B0-554 — the revision pass is its own model call; capture its usage on its own step
            // instead of leaving it unattributed (it used to be dropped entirely).
            usage: revisionResult.usage,
            // B0-563 — same reasoning as the agent step's `model` field above.
            model: await resolveRevisionModel(input.modelTag),
          }),
        });
        markStepClosed(revisionStep.id);

        if (revised && !revisionRefused) {
          // B0-923 — snapshot the text the revision pass is about to replace; see
          // `preRevisionDraftAnswer`'s doc comment above.
          preRevisionDraftAnswer = draftAnswer;
          draftAnswer = revised;
          // B0-391 — the revision model wrote this text, replacing whatever the earlier branches had.
          answerProvenance = 'revision_pass';
          // B0-886 — the raw revision output, before any later redaction/composition step. Also
          // marks `draftAnswer` as revision-derived for the final "keep it visible" branch below.
          revisedAnswerRecord = revised;
          draftReplacedByRevision = true;
          if (crossReferenceResult?.match.productUrl?.trim()) {
            draftAnswer = composeCrossReferenceUserFacingAnswer({
              match: crossReferenceResult.match,
              assistantText: revised,
            });
            // Last writer that changed the text wins: the composer prepends the comparable-product
            // headline on top of the revised body, so the composition is what the user saw.
            if (draftAnswer.trim() !== revised.trim()) {
              answerProvenance = 'cross_reference_composed';
            }
          }
          const secondPass = await runValidatorPass({
            draftAnswer,
            evidenceSummary,
            modelTag: input.modelTag,
          });
          validatorUsageByCall.push(secondPass.usage);
          validation = secondPass;
          audit.enqueue(
            'validation_completed',
            { pass: 'second', ...validation, validatorMode },
            {
              ...wfCtx,
              stepId: validationStep.id,
            },
          );
        } else {
          revisionPassRefused = true;
          validation = { ...validation, requires_human_review: true };
          audit.enqueue(
            'revision_skipped_refusal',
            { issues: validation.issues },
            // B0-389 — re-attributed from the validator step to the revision step that refused.
            { ...wfCtx, stepId: revisionStep.id },
          );
        }
      }
    }

    /**
     * B0-391 — deterministic gate records for this step, in evaluation order. Only the gates that
     * actually ran are pushed, so a gate that never applied is ABSENT from the persisted row rather
     * than recorded as having passed.
     */
    const validatorStepGates: GateRecord[] = [];
    /** Shared by both usage/safety branches: the thresholds the gate really applies. */
    const usageSafetyThresholds = {
      confidenceCap: USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP,
      bodyScanMaxChars: USAGE_SAFETY_COVERAGE_BODY_SCAN_MAX_CHARS,
      requiresUsageEvidence: true,
      requiresSafetyEvidence: true,
    };
    const usageSafetyInputs = {
      queryNeedsUsageAndSafetyCoverage: needsUsageSafetyCoverage,
      // B0-872 — the two halves of that trigger, recorded separately so a trace reader can tell
      // "not a usage question" from "a usage question about no identifiable product".
      usageSafetyQuestionShape,
      hasProductSubject: usageSafetyProductSubject.hasProductSubject,
      productSubjectSource: usageSafetyProductSubject.source,
      hasUsageEvidence: usageSafetyCoverage.hasUsageEvidence,
      hasSafetyEvidence: usageSafetyCoverage.hasSafetyEvidence,
      retrievedSourceCount: sourceMeta.length,
    };

    // B0-494 — this gate's own activation state, set in every branch below (including the
    // `not_applicable` case, when `needsUsageSafetyCoverage` is false and none of them run).
    // B0-872 — a usage/safety-SHAPED question that names no product is `not_applicable` too (no
    // cap, no fallback copy: the knowledge-base draft reaches the user), but carries a `reason` so
    // the timeline can show WHY the gate stood down instead of leaving it indistinguishable from
    // "not a usage question at all".
    let usageSafetyCoverageActivation: GateActivationRecord =
      usageSafetyQuestionShape && !usageSafetyProductSubject.hasProductSubject
        ? { state: 'not_applicable', reason: 'no_product_subject' }
        : { state: 'not_applicable' };

    if (
      needsUsageSafetyCoverage &&
      (!usageSafetyCoverage.hasUsageEvidence ||
        !usageSafetyCoverage.hasSafetyEvidence) &&
      !(await isConfidenceGatingDisabled())
    ) {
      const missingEvidence: string[] = [];
      if (!usageSafetyCoverage.hasUsageEvidence) {
        missingEvidence.push('usage');
      }
      if (!usageSafetyCoverage.hasSafetyEvidence) {
        missingEvidence.push('safety');
      }
      const coverageIssue = `insufficient_${missingEvidence.join('_and_')}_evidence`;
      const confidenceBeforeCap = validation.confidence;
      validation = {
        ...validation,
        approved: false,
        confidence: Math.min(
          validation.confidence,
          USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP,
        ),
        issues: Array.from(new Set([...validation.issues, coverageIssue])),
      };
      // B0-492 — record the cap (no-op if it somehow didn't actually lower the value).
      confidenceState = applyConfidenceCap(confidenceState, confidenceBeforeCap, validation.confidence);
      // B0-367: this was the only confidence gate with no audit row, which forced
      // the run-trace timeline to reverse-engineer it by diffing the logged
      // validator pass against the persisted validator step output.
      audit.enqueue(
        'usage_safety_coverage_cap_applied',
        {
          missingEvidence,
          confidenceBefore: confidenceBeforeCap,
          confidenceAfter: validation.confidence,
          cap: USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP,
          issues: [coverageIssue],
          approved: false,
          requires_human_review: validation.requires_human_review,
        },
        { ...wfCtx, stepId: validationStep.id },
      );
      validatorStepGates.push({
        gate: 'usage_safety_coverage',
        inputs: { ...usageSafetyInputs, missingEvidence },
        thresholds: usageSafetyThresholds,
        verdict: 'capped',
        effect: `approved forced to false, issue "${coverageIssue}" added, confidence ${confidenceBeforeCap} → ${validation.confidence}. The usage/safety fallback copy replaces the draft unless the regulated-claim guardrail also rejected, whose copy wins; see answerProvenance for what the user saw.`,
      });
      // B0-358 — the gate ran AND acted; `verdict` says which.
      usageSafetyCoverageActivation = { state: 'ran', verdict: 'capped' };
    } else if (
      needsUsageSafetyCoverage &&
      (!usageSafetyCoverage.hasUsageEvidence ||
        !usageSafetyCoverage.hasSafetyEvidence)
    ) {
      // B0-452: coverage is missing, but BEX_DISABLE_CONFIDENCE_GATING is set — this cap
      // is an unproven placeholder threshold, so it's bypassed rather than suppressing the
      // draft answer. Recorded as bypassed (not silently dropped) for audit continuity.
      validatorStepGates.push({
        gate: 'usage_safety_coverage',
        inputs: {
          ...usageSafetyInputs,
          missingEvidence: [
            ...(!usageSafetyCoverage.hasUsageEvidence ? ['usage'] : []),
            ...(!usageSafetyCoverage.hasSafetyEvidence ? ['safety'] : []),
          ],
        },
        thresholds: usageSafetyThresholds,
        verdict: 'bypassed',
        effect:
          'BEX_DISABLE_CONFIDENCE_GATING is set: coverage was insufficient but the confidence cap and approval override were skipped.',
      });
      usageSafetyCoverageActivation = {
        state: 'bypassed',
        reason: 'confidence_gating_disabled',
        verdict: 'capped',
      };
    } else if (needsUsageSafetyCoverage) {
      // The gate RAN and found both kinds of evidence — a real verdict, not a skipped gate.
      validatorStepGates.push({
        gate: 'usage_safety_coverage',
        inputs: { ...usageSafetyInputs, missingEvidence: [] },
        thresholds: usageSafetyThresholds,
        verdict: 'passed',
        effect:
          'Usage and safety evidence were both retrieved; no confidence cap and no fallback copy.',
      });
      // B0-358 — the gate ran and PASSED; distinguishable from "the gate never ran".
      usageSafetyCoverageActivation = { state: 'ran', verdict: 'passed' };
    }

    /**
     * B0-700 follow-up — deterministic fuzzy-alias disclosure. Applied here: `draftAnswer` is
     * fully settled (past the revision pass and every answer-replacing branch above), and this
     * runs BEFORE the regulated-claim guardrail below so the prepended sentence is itself swept
     * through that verbatim-grounding check (it must never trip it — see
     * `buildAliasFuzzyDisclosureSentence`'s doc comment and `alias-fuzzy-disclosure.test.ts`).
     * A no-op (returns `draftAnswer` unchanged) unless this turn actually grounded on an
     * `alias_fuzzy` resolution the model didn't already disclose itself.
     */
    const preDisclosureDraftAnswer = draftAnswer;
    draftAnswer = maybeDiscloseAliasFuzzyMatch(draftAnswer, toolOutputLog, {
      userMessage: input.userMessage,
    });
    if (draftAnswer !== preDisclosureDraftAnswer) {
      // B0-391 — last writer that actually changed the text wins; a no-op prepend (nothing to
      // disclose, or the model already did) deliberately leaves provenance untouched.
      answerProvenance = 'alias_fuzzy_disclosure_prepended';
    }
    // B0-923 — the pre-revision fallback draft gets the identical deterministic disclosure, so if
    // it is restored below it is byte-for-byte the text that would have shipped without the
    // revision pass, disclosure included — and it is swept through the guardrail the same way.
    if (preRevisionDraftAnswer !== null) {
      preRevisionDraftAnswer = maybeDiscloseAliasFuzzyMatch(preRevisionDraftAnswer, toolOutputLog, {
        userMessage: input.userMessage,
      });
    }

    /**
     * B0-1033 — deterministic "finish dries top-down" rationale on a floor-route recoat-timing
     * answer. Placed here for the same two reasons as the disclosure above: `draftAnswer` is fully
     * settled, and the appended sentence is itself swept through the regulated-claim guardrail
     * below (it states no dilution, contact time, dry time or hazard, so it must never trip it —
     * see `floor-recoat-rationale-backstop.test.ts`). A no-op unless this turn's question was a
     * recoat-timing ask, the draft answered it with a timing figure, and the WHY was missing.
     */
    const recoatRationale = applyFloorRecoatRationaleBackstop({
      userMessage: input.userMessage,
      effectivePromptId,
      draftAnswer,
    });
    if (recoatRationale.applied) {
      draftAnswer = recoatRationale.answer;
      // B0-391 — last writer that actually changed the text wins.
      answerProvenance = 'floor_recoat_rationale_appended';
    }
    // B0-923 — the pre-revision fallback draft gets the identical deterministic treatment, so a
    // restore below still ships the rationale.
    if (preRevisionDraftAnswer !== null) {
      preRevisionDraftAnswer = applyFloorRecoatRationaleBackstop({
        userMessage: input.userMessage,
        effectivePromptId,
        draftAnswer: preRevisionDraftAnswer,
      }).answer;
    }

    // B0-257: regulated-claim guardrail -- evaluated unconditionally (independent of the
    // `useValidator` opt-in toggle above, which only gates the LLM semantic-judge pass).
    // EPA registration, dilution/contact-time, hazard, and first-aid claims must be
    // traceable to an exact quote in a retrieved source; anything that fails is normally a
    // hard rejection, never a soft warning, per the org's regulated-data rule.
    //
    // B0-452 follow-up: while testing untuned thresholds, `BEX_DISABLE_CONFIDENCE_GATING` also
    // suppresses THIS rejection (previously the one check the kill-switch never touched) so the
    // draft answer reaches the user unmodified even when it contains an unverified regulated
    // claim. The detection still runs and is always recorded (`gates`, and the review task below
    // when not bypassed) so a reviewer can see exactly what would have been withheld and why --
    // turn the flag back off once real thresholds are calibrated.
    //
    // B0-547 follow-up: `sourceMeta[].documentBody` is only the narrowed matched-chunk-plus-
    // neighbors window shown to the model, not the whole approved document -- reusing it here
    // would silently shrink this guardrail's grounding pool and could reject (or, just as bad,
    // fail to catch) a genuinely correct regulated claim quoted from a part of the document
    // outside that window.
    //
    // B0-885: `fullDocumentBodies` is now fetched once, above (alongside `sourceMeta`), and reused
    // by both `buildEvidenceSummary` (validator/revision evidence) and this guardrail, so both
    // ground against the identical whole-document window instead of re-fetching it twice.
    //
    // B0-888: `isLockedProductLineSource` marks the source(s) whose `product_line_key` (read off
    // `retrieved_document_chunks`, computed above) matches this turn's locked product line -- one
    // of the three attribution channels the compatibility/efficacy_claim key-term fallback accepts
    // (see `attributedSources` in `validator.ts`). Null/no lock ⇒ every source is `false`.
    const lockedProductLineKeyForGrounding =
      extractProductLineLockFromToolTrace(resolvedToolTrace)?.lockedProductLineKey ?? null;
    const lockedProductLineDocumentIds = new Set(
      lockedProductLineKeyForGrounding
        ? retrieved_document_chunks
            .filter((c) => c.product_line_key === lockedProductLineKeyForGrounding)
            .map((c) => c.document_id)
        : [],
    );
    const regulatedClaimGroundingSources = sourceMeta.map((s) => ({
      documentId: s.documentId,
      title: s.title,
      documentBody: fullDocumentBodies.get(s.documentId)?.body ?? s.documentBody,
      isLockedProductLineSource: lockedProductLineDocumentIds.has(s.documentId),
      // B0-1131 — lets attribution recognise a product's own label / efficacy / SDS by the name it prints.
      documentKind: s.documentKind,
    }));
    // B0-997 — same "did this turn resolve a named Betco product" signal `requireFactToolForDraft`
    // already gates `compatibility` enforcement on (`speculativeProductLineLock !== null`), read here
    // off the post-generation product-line lock so the guardrail's own `compatibility` detection
    // agrees with it.
    const regulatedClaimGroundingProductResolved = lockedProductLineKeyForGrounding !== null;
    const servedDraftRegulatedClaimGrounding = evaluateRegulatedClaimGrounding({
      draftAnswer,
      sources: regulatedClaimGroundingSources,
      productResolved: regulatedClaimGroundingProductResolved,
    });

    /**
     * B0-923 — judge the model's OWN draft too, not only the revised one.
     *
     * The guardrail runs after the revision pass, so on a revised turn it judges text the revision
     * pass wrote. That pass is instructed to tighten grounding and it adds safety framing of its
     * own ("handle and dispose of oily rags accordingly", "always maintain adequate ventilation").
     * Attributing that prose to the model and declining on it is our own second pass manufacturing
     * a rejection: in the 2026-09-09 eval run `regulated_claim_unverified:hazard` fired 21 times on
     * 106 items with the validator on, against 2 with it off, each time replacing a ~2,000-char
     * grounded answer with 264 characters of decline copy.
     *
     * So: when the REVISED draft is rejected and the PRE-REVISION draft is clean, serve the
     * pre-revision draft. Fail-closed is preserved, and this is narrower than it may look:
     *
     * - The pre-revision draft must be ENTIRELY clean (`ungroundedCategories.length === 0`), not
     *   merely clean for the rejecting categories — a pre-revision draft carrying its own
     *   different ungrounded regulated claim is never served.
     * - What ships is text this guardrail INDEPENDENTLY PASSED. The revised text's rejection is
     *   never waived, and the revised text is never served with the objection ignored.
     * - Nothing about verbatim matching, what counts as grounding, or which sentences are
     *   classified as claims changes; only which of two candidate drafts is judged and served.
     * - If the pre-revision draft is also rejected, behaviour is byte-identical to today: the
     *   redaction/decline path below runs on the revised draft exactly as before.
     */
    let preRevisionDraftRestored = false;
    let regulatedClaimGrounding = servedDraftRegulatedClaimGrounding;
    if (
      servedDraftRegulatedClaimGrounding.ungroundedCategories.length > 0 &&
      preRevisionDraftAnswer !== null &&
      preRevisionDraftAnswer.trim().length > 0 &&
      preRevisionDraftAnswer !== draftAnswer
    ) {
      const preRevisionGrounding = evaluateRegulatedClaimGrounding({
        draftAnswer: preRevisionDraftAnswer,
        sources: regulatedClaimGroundingSources,
        productResolved: regulatedClaimGroundingProductResolved,
      });
      if (preRevisionGrounding.ungroundedCategories.length === 0) {
        draftAnswer = preRevisionDraftAnswer;
        // From here on the served text IS the pre-revision draft, so every downstream consumer
        // (the decline branch, the dilution-citation guardrail, the review task payload) reads the
        // grounding result for the text that actually ships.
        regulatedClaimGrounding = preRevisionGrounding;
        answerProvenance = 'pre_revision_draft_restored';
        preRevisionDraftRestored = true;
        audit.enqueue(
          'regulated_claim_pre_revision_draft_restored',
          {
            revisedDraftUngroundedCategories:
              servedDraftRegulatedClaimGrounding.ungroundedCategories,
            revisedDraftUngroundedDetails: servedDraftRegulatedClaimGrounding.ungroundedDetails,
            preRevisionCategoriesDetected: preRevisionGrounding.categoriesDetected,
          },
          { ...wfCtx, stepId: validationStep.id },
        );
      }
    }

    // B0-494 — this gate is evaluated unconditionally (see comment above), so it is either `ran`
    // (whether or not it found anything to reject) or `bypassed` by the kill switch — never
    // `skipped`/`not_applicable`.
    let regulatedClaimGuardrailActivation: GateActivationRecord = { state: 'ran' };
    /**
     * B0-829 / B0-871 — how the enforced rejection below will be honoured: redact the ungrounded
     * claim(s) out of the draft, or replace the whole draft with the decline copy. Decided HERE
     * (not in the answer-composition block further down) so the gate record persisted on this step
     * and `activeGates.regulatedClaimGuardrail` can say `redacted` vs `rejected` — the step row is
     * written before that block runs. Null when the guardrail passed or was bypassed.
     */
    let regulatedClaimRedactionPlan: RegulatedClaimRedactionPlan | null = null;

    if (regulatedClaimGrounding.ungroundedCategories.length > 0) {
      if (await isConfidenceGatingDisabled()) {
        validatorStepGates.push({
          gate: 'regulated_claim_guardrail',
          inputs: {
            categoriesDetected: regulatedClaimGrounding.categoriesDetected,
            ungroundedCategories: regulatedClaimGrounding.ungroundedCategories,
            ungroundedDetails: regulatedClaimGrounding.ungroundedDetails,
          },
          thresholds: { note: 'hard verbatim-match requirement, not a numeric threshold' },
          verdict: 'bypassed',
          effect: `BEX_DISABLE_CONFIDENCE_GATING is set: ${regulatedClaimGrounding.ungroundedCategories.join(', ')} could not be verified verbatim against a retrieved source, but the draft answer was allowed through unmodified instead of being replaced with the decline message. See draftAnswer on this run's final_output for exactly what was said.`,
        });
        regulatedClaimGuardrailActivation = {
          state: 'bypassed',
          reason: 'confidence_gating_disabled',
          verdict: 'rejected',
        };
      } else {
        const confidenceBeforeRegulatedCap = validation.confidence;
        validation = {
          ...validation,
          approved: false,
          confidence: Math.min(validation.confidence, 0.4),
          issues: Array.from(
            new Set([
              ...validation.issues,
              ...regulatedClaimGrounding.ungroundedCategories.map(
                (c) => `regulated_claim_unverified:${c}`,
              ),
            ]),
          ),
          requires_human_review: true,
        };
        // B0-492 — same capping-chain rule as the usage/safety coverage cap above.
        confidenceState = applyConfidenceCap(
          confidenceState,
          confidenceBeforeRegulatedCap,
          validation.confidence,
        );
        // B0-829 / B0-871 — redact or decline; see `planRegulatedClaimRedaction` for the policy.
        regulatedClaimRedactionPlan = planRegulatedClaimRedaction({
          draftAnswer,
          userMessage: input.userMessage,
          grounding: regulatedClaimGrounding,
          productLineLock: extractProductLineLockFromToolTrace(resolvedToolTrace),
          sources: sourceMeta,
        });
        const redactionApplied = regulatedClaimRedactionPlan.mode !== 'decline';
        const redactionDeclineReason =
          regulatedClaimRedactionPlan.mode === 'decline' ? regulatedClaimRedactionPlan.reason : null;
        audit.enqueue(
          'regulated_claim_guardrail_rejected',
          {
            categoriesDetected: regulatedClaimGrounding.categoriesDetected,
            ungroundedCategories: regulatedClaimGrounding.ungroundedCategories,
            ungroundedDetails: regulatedClaimGrounding.ungroundedDetails,
            // B0-871 — `token_redaction` | `sentence_redaction` | `decline` (+ why, for decline).
            outcome: regulatedClaimRedactionPlan.mode,
            ...(redactionDeclineReason ? { declineReason: redactionDeclineReason } : {}),
            ...(regulatedClaimRedactionPlan.mode !== 'decline'
              ? { withheldSpans: regulatedClaimRedactionPlan.withheldSpans }
              : {}),
          },
          { ...wfCtx, stepId: validationStep.id },
        );
        /**
         * B0-358 — the enforced rejection had no `GateRecord` of its own: the ONLY structured
         * record was the `bypassed` branch above, so a persisted step showed this gate exclusively
         * on runs where it did NOT act. Recorded here too, so the step row carries the rejection
         * as a first-class gate evaluation rather than only an audit row.
         *
         * B0-871 — `verdict` is `redacted` when the draft is kept minus the ungrounded claim(s)
         * (B0-829 token blanking or B0-871 sentence withholding), `rejected` when the whole draft is
         * replaced with the decline copy, so the timeline and the eval export can tell the two
         * apart. `validation` (approved=false, cap 0.4, human review) is identical for both.
         */
        validatorStepGates.push({
          gate: 'regulated_claim_guardrail',
          inputs: {
            categoriesDetected: regulatedClaimGrounding.categoriesDetected,
            ungroundedCategories: regulatedClaimGrounding.ungroundedCategories,
            ungroundedDetails: regulatedClaimGrounding.ungroundedDetails,
            redactionMode: regulatedClaimRedactionPlan.mode,
            // B0-1131 — the pool this verdict was judged against, and every span removed with why.
            groundedSourceCount: regulatedClaimGroundingSources.length,
            ...(regulatedClaimRedactionPlan.mode !== 'decline'
              ? { withheldSpans: regulatedClaimRedactionPlan.withheldSpans }
              : {}),
            // B0-888 — 'key_term' when at least one OTHER (still-grounded) compatibility/
            // efficacy_claim sentence on this draft was saved by the key-term/adjacent-quote
            // fallback rather than a plain verbatim match; 'verbatim' otherwise. Distinguishes the
            // two grounding paths for audits even on a turn that also has a genuine rejection.
            groundingMode:
              regulatedClaimGrounding.keyTermGroundedCategories.length > 0 ? 'key_term' : 'verbatim',
            ...(redactionDeclineReason ? { declineReason: redactionDeclineReason } : {}),
            // B0-985 — sentence snippets the planner could not locate verbatim (left in place,
            // token redaction still applied). Absent on every expected path.
            ...(regulatedClaimRedactionPlan.mode !== 'decline' &&
            regulatedClaimRedactionPlan.unlocatedSnippets?.length
              ? { unlocatedSnippets: regulatedClaimRedactionPlan.unlocatedSnippets }
              : {}),
          },
          thresholds: {
            note: 'hard verbatim-match requirement, not a numeric threshold',
            sentenceRedactionMinRemainingChars: REGULATED_CLAIM_REDACTION_MIN_REMAINING_CHARS,
          },
          verdict: redactionApplied ? 'redacted' : 'rejected',
          effect: redactionApplied
            ? `${regulatedClaimGrounding.ungroundedCategories.join(', ')} could not be verified verbatim against a retrieved source: approved forced to false, confidence ${confidenceBeforeRegulatedCap} → ${validation.confidence}, human review requested; the draft was KEPT with the ungrounded claim(s) redacted (${regulatedClaimRedactionPlan.mode}). See answerProvenance regulated_claim_partial_redaction.`
            : `${regulatedClaimGrounding.ungroundedCategories.join(', ')} could not be verified verbatim against a retrieved source: approved forced to false, confidence ${confidenceBeforeRegulatedCap} → ${validation.confidence}, human review requested, and the draft answer replaced with the regulated-claim decline copy (redaction not applied: ${redactionDeclineReason ?? 'unknown'}).`,
        });
        regulatedClaimGuardrailActivation = {
          state: 'ran',
          verdict: redactionApplied ? 'redacted' : 'rejected',
        };
      }
    } else if (preRevisionDraftRestored) {
      /**
       * B0-923 — the guardrail RAN and REJECTED the revised draft, the pre-revision draft was
       * clean, and the pre-revision draft was served. Recorded as its own verdict (not `passed`)
       * so the run trace shows the guardrail acted: `extractFiredGates` reports any verdict other
       * than `passed` as a gate that fired, which is exactly right here — the revision pass's text
       * was discarded on this gate's objection.
       */
      validatorStepGates.push({
        gate: 'regulated_claim_guardrail',
        inputs: {
          // The SERVED (pre-revision) draft's own grounding result.
          categoriesDetected: regulatedClaimGrounding.categoriesDetected,
          ungroundedCategories: [],
          groundedSourceCount: sourceMeta.length,
          groundingMode:
            regulatedClaimGrounding.keyTermGroundedCategories.length > 0 ? 'key_term' : 'verbatim',
          // What the guardrail rejected on the REVISED draft, i.e. what our own revision pass
          // introduced. Kept verbatim from the rejection so a reviewer can read the exact snippets.
          revisedDraftUngroundedCategories:
            servedDraftRegulatedClaimGrounding.ungroundedCategories,
          revisedDraftUngroundedDetails: servedDraftRegulatedClaimGrounding.ungroundedDetails,
          preRevisionDraftClean: true,
          servedDraft: 'pre_revision',
        },
        thresholds: { note: 'hard verbatim-match requirement, not a numeric threshold' },
        verdict: 'restored_pre_revision_draft',
        effect: `${servedDraftRegulatedClaimGrounding.ungroundedCategories.join(', ')} could not be verified verbatim against a retrieved source ON THE REVISED DRAFT, but the pre-revision draft contained nothing ungrounded — the rejection came from the revision pass's own added prose, not from the model's answer. The revised text was discarded and the pre-revision draft (which this guardrail passed) was served; no cap, no decline copy. See answerProvenance pre_revision_draft_restored, and revisedAnswer for the text that was rejected.`,
      });
      regulatedClaimGuardrailActivation = {
        state: 'ran',
        verdict: 'restored_pre_revision_draft',
      };
    } else {
      /**
       * B0-358 — the guardrail RAN and found nothing ungrounded. Previously this produced no record
       * at all, so "the guardrail ran and passed" and "the guardrail never ran" were the same empty
       * space in the trace. Recorded as a real `passed` verdict, listing which regulated categories
       * the draft even contained (an answer with no regulated claim in it passes trivially, which
       * is a different fact from one whose EPA/dilution values were all verified verbatim).
       */
      validatorStepGates.push({
        gate: 'regulated_claim_guardrail',
        inputs: {
          categoriesDetected: regulatedClaimGrounding.categoriesDetected,
          ungroundedCategories: [],
          groundedSourceCount: sourceMeta.length,
          // B0-888 — 'key_term' when at least one compatibility/efficacy_claim sentence on this
          // draft was grounded via the key-term/adjacent-quote fallback rather than a plain
          // verbatim match; 'verbatim' otherwise (including when nothing regulated was detected).
          groundingMode:
            regulatedClaimGrounding.keyTermGroundedCategories.length > 0 ? 'key_term' : 'verbatim',
        },
        thresholds: { note: 'hard verbatim-match requirement, not a numeric threshold' },
        verdict: 'passed',
        effect:
          regulatedClaimGrounding.categoriesDetected.length > 0
            ? `Every regulated value in the draft (${regulatedClaimGrounding.categoriesDetected.join(', ')}) was matched verbatim against a retrieved source. No cap, no replacement.`
            : 'The draft made no regulated claim (no EPA registration, dilution/contact time, hazard or first-aid statement), so there was nothing to verify. No cap, no replacement.',
      });
      regulatedClaimGuardrailActivation = { state: 'ran', verdict: 'passed' };
    }

    // B0-699 — `evaluateVerifiedFactsDilutionCitation`: catches the narrower case
    // `regulated_claim_guardrail` above cannot — a `[doc:verified-facts]` citation whose dilution
    // figure is a REAL row from the turn's shared (possibly multi-product) evidence block, but
    // for a DIFFERENT product line than the one this turn actually locked onto (the live incident
    // this ticket reproduces: "2 oz/gal (1:64)" cited to verified-facts for DAILY DISINFECT, whose
    // own locked fact row says "1:256"). Deliberately NOT gated behind
    // `BEX_DISABLE_CONFIDENCE_GATING` — see the function's own doc comment: that flag already
    // suppresses the verbatim guardrail's enforcement above, so wiring this one to the same switch
    // would leave today's production config with no working defense against this failure mode.
    //
    // B0-987 — a multi-product answer cites each product's OWN batch row as
    // `[doc:verified-facts:<key>]` (B0-549), so every cited key is re-fetched too and each dilution
    // figure is checked against the row it is attached to; the locked line is only the fallback for
    // a figure attached to no citation. Before this, an unlocked turn (`skipped_ambiguous`) had
    // nothing to compare against and every batch citation was "ungrounded" by construction
    // (39ef58b3: "2 oz/gal", "1:16", "1:64" rejected, confidence 0.9 → 0.4). The locked line is now
    // fetched by its `product_line_key` (`fetchFactsForProductLineKeys`): `lockedProductLineKey` is
    // the legacy line key, which `fetchProductLineFacts` — an `entity_id` lookup — never matched, so
    // `lockedFacts` was null on every locked turn as well.
    const dilutionLock = extractProductLineLockFromToolTrace(resolvedToolTrace);
    const citedVerifiedFactsKeys = extractVerifiedFactsCitationKeys(draftAnswer);
    const [dilutionLockedFactsMap, citedVerifiedFactsMap] = await Promise.all([
      dilutionLock?.lockedProductLineKey
        ? fetchFactsForProductLineKeys([dilutionLock.lockedProductLineKey])
        : Promise.resolve(null),
      citedVerifiedFactsKeys.length > 0
        ? fetchFactsForCitationKeys(citedVerifiedFactsKeys)
        : Promise.resolve(null),
    ]);
    const dilutionLockedFacts =
      dilutionLock?.lockedProductLineKey && dilutionLockedFactsMap
        ? (dilutionLockedFactsMap.get(dilutionLock.lockedProductLineKey) ?? null)
        : null;
    const citedDilutionFacts = new Map(
      Array.from(citedVerifiedFactsMap?.entries() ?? [], ([key, facts]) => [
        key,
        facts ? { dilutionDisplay: facts.dilutionDisplay, dilutionOzPerGal: facts.dilutionOzPerGal } : null,
      ]),
    );
    const dilutionCitationGrounding = evaluateVerifiedFactsDilutionCitation({
      draftAnswer,
      lockedFacts: dilutionLockedFacts
        ? {
            dilutionDisplay: dilutionLockedFacts.dilutionDisplay,
            dilutionOzPerGal: dilutionLockedFacts.dilutionOzPerGal,
          }
        : null,
      citedFacts: citedDilutionFacts,
    });

    let dilutionCitationGuardrailActivation: GateActivationRecord = { state: 'ran' };

    if (dilutionCitationGrounding.applicable && !dilutionCitationGrounding.grounded) {
      const confidenceBeforeDilutionCap = validation.confidence;
      validation = {
        ...validation,
        approved: false,
        confidence: Math.min(validation.confidence, 0.4),
        issues: Array.from(new Set([...validation.issues, 'dilution_citation_unverified'])),
        requires_human_review: true,
      };
      // Same capping-chain rule as the regulated-claim guardrail above.
      confidenceState = applyConfidenceCap(
        confidenceState,
        confidenceBeforeDilutionCap,
        validation.confidence,
      );
      audit.enqueue(
        'dilution_citation_guardrail_rejected',
        {
          citedTokens: dilutionCitationGrounding.citedTokens,
          ungroundedTokens: dilutionCitationGrounding.ungroundedTokens,
          lockedProductLineKey: dilutionLock?.lockedProductLineKey ?? null,
          citedProductLineKeys: dilutionCitationGrounding.citedProductLineKeys,
        },
        { ...wfCtx, stepId: validationStep.id },
      );
      validatorStepGates.push({
        gate: 'dilution_citation_guardrail',
        inputs: {
          citedTokens: dilutionCitationGrounding.citedTokens,
          ungroundedTokens: dilutionCitationGrounding.ungroundedTokens,
          lockedProductLineKey: dilutionLock?.lockedProductLineKey ?? null,
          // B0-987 — the batch rows each figure was checked against (its own citation's row).
          citedProductLineKeys: dilutionCitationGrounding.citedProductLineKeys,
        },
        thresholds: {
          note: "hard match against the cited product's own fact row (locked line for uncited figures), not a numeric threshold",
        },
        verdict: 'rejected',
        effect: `Cited dilution figure(s) ${dilutionCitationGrounding.ungroundedTokens.join(', ')} for [doc:verified-facts] did not match the cited/locked product line's own dilution fact: approved forced to false, confidence ${confidenceBeforeDilutionCap} → ${validation.confidence}, human review requested.`,
      });
      dilutionCitationGuardrailActivation = { state: 'ran', verdict: 'rejected' };
    } else {
      validatorStepGates.push({
        gate: 'dilution_citation_guardrail',
        inputs: {
          applicable: dilutionCitationGrounding.applicable,
          citedTokens: dilutionCitationGrounding.citedTokens,
          citedProductLineKeys: dilutionCitationGrounding.citedProductLineKeys,
        },
        thresholds: {
          note: "hard match against the locked product line's own fact row, not a numeric threshold",
        },
        verdict: 'passed',
        effect: dilutionCitationGrounding.applicable
          ? "Every cited [doc:verified-facts] dilution figure matched the locked product line's own fact row. No cap, no replacement."
          : 'The draft did not cite [doc:verified-facts] alongside a dilution figure, so there was nothing to verify. No cap, no replacement.',
      });
      dilutionCitationGuardrailActivation = { state: 'ran', verdict: 'passed' };
    }

    // REC-4: on the competitive-recommendation route, calibrate confidence to retrieval
    // strength (top-hit similarity < 60% cannot exceed 0.75) and enforce chemistry-class
    // consistency once REC-1 grounding + REC-2/3 structured fields are wired (dormant until then).
    //
    // B0-339 widened this past `routingDecision` alongside the branches above. Keeping it on the
    // label alone would have left the same question reporting a higher confidence when it happened
    // to route `product` than when it routed `cross_reference` — and this gate only ever tightens
    // confidence, so the conservative direction for an equivalence claim about an EPA-registered
    // product is to apply it whenever the cross-reference post-processing ran.
    // B0-494 — this gate's own trigger condition is `useCrossReferencePostProcessing` itself, so
    // `not_applicable` (not `skipped`) is the right label when it never fires this turn.
    let recommendationConfidenceActivation: GateActivationRecord = { state: 'not_applicable' };
    if (useCrossReferencePostProcessing) {
      const gateInput = {
        /**
         * B0-491 — the agent's own self-reported confidence replaces the validator/bypass-heuristic
         * value as this gate's calibration input, per this ticket's explicit ask. Falls back to
         * `validation.confidence` only when the model reported no parseable score this turn.
         */
        baseConfidence: agentSelfConfidence.agentConfidence ?? validation.confidence,
        /**
         * B0-490 — the RAW top similarity (the winning search's ANN score before
         * `selectCuratedMatches` filtered/deduped/truncated it), not the post-selection max of
         * `sources[]`. `LOW_SIMILARITY_THRESHOLD` was calibrated against the raw retrieval score,
         * so feeding it the post-filter max let a ~58% raw hit report 0.90 confidence — the
         * defect this ticket fixes. Null (gate skips the cap) only when no search tool ran.
         */
        topSimilarity: similarityRollup.rawTopSimilarity,
        /**
         * B0-513 — wired from the B0-357 competitor-identity resolution already computed for this
         * turn (`resolvedCompetitor`, above). Guaranteed non-null here: `useCrossReferencePostProcessing`
         * and `competitorIdentityNeeded` share the exact same trigger condition
         * (`routingDecision === 'cross_reference' || forcedCrossReference`), so whenever this branch
         * runs, `resolvedCompetitorPromise` was created and already awaited. `false` (not `undefined`)
         * when the extraction ran but found no brand, so `evaluateRecommendationGate`'s missing-brand
         * cap can actually fire instead of silently never applying.
         */
        brandKnown: Boolean(resolvedCompetitor?.brand?.trim()),
      };
      const gate = await evaluateRecommendationGate(gateInput);
      recommendationConfidenceActivation =
        gate.bypassedChecks.length > 0
          ? { state: 'bypassed', reason: 'confidence_gating_disabled' }
          : { state: 'ran' };
      const confidenceBeforeGate = validation.confidence;
      /**
       * B0-492 — the gate's OWN candidate provenance: `agent_self_scored` when B0-491 substituted
       * the agent's self-score as `baseConfidence`, otherwise whatever this run's confidence
       * already was. `applyConfidenceCap` then records whether the gate's internal caps
       * (low-similarity / missing-brand / category-mismatch) actually lowered that candidate below
       * `gateInput.baseConfidence`. The outer `Math.min` below decides whether this candidate or
       * the PRIOR value survives as the run's confidence — only if it wins does its provenance
       * (and any cap it carries) replace `confidenceState`.
       */
      let gateCandidateState: ConfidenceProvenanceState =
        agentSelfConfidence.agentConfidence !== null
          ? { provenance: 'agent_self_scored', preCapValue: null, preCapProvenance: null }
          : confidenceState;
      gateCandidateState = applyConfidenceCap(
        gateCandidateState,
        gateInput.baseConfidence,
        gate.confidence,
      );
      validation = {
        ...validation,
        approved: validation.approved && gate.approved,
        confidence: Math.min(validation.confidence, gate.confidence),
        issues: Array.from(new Set([...validation.issues, ...gate.issues])),
        requires_human_review:
          validation.requires_human_review || gate.requires_human_review,
      };
      if (gate.confidence < confidenceBeforeGate) {
        confidenceState = gateCandidateState;
      }
      audit.enqueue(
        'recommendation_gate_applied',
        { ...gate, topSimilarity: gateInput.topSimilarity },
        { ...wfCtx, stepId: validationStep.id },
      );
      /**
       * B0-391 — the same calibration as a structured record. The audit row above is kept: it is
       * the ONLY record for every run predating this step, and the timeline still reads it.
       *
       * `inputs` lists exactly what the call site passes. `evaluateRecommendationGate` also accepts
       * `competitorChemistryClass` and `recommendedChemistryClass`, but this workflow passes
       * neither (REC-1 grounding + REC-2/3 structured fields are still dormant), so the
       * category-mismatch cap cannot fire here — recording it as if it had been evaluated would be
       * a false claim. `brandKnown` WAS wired above (B0-513, see `gateInput`), so it is no longer
       * listed here.
       */
      validatorStepGates.push({
        gate: 'recommendation_confidence',
        inputs: {
          ...gateInput,
          retrievedSourceCount: sources.length,
          unwiredInputs: ['competitorChemistryClass', 'recommendedChemistryClass'],
          trigger:
            routingDecision === 'cross_reference'
              ? 'cross_reference_route'
              : 'cross_reference_intent',
          gateIssues: gate.issues,
          // B0-452 follow-up — always present so a run where nothing was bypassed is
          // distinguishable from one where this field is simply missing.
          bypassedChecks: gate.bypassedChecks,
        },
        // Read from the module's exported constants, never re-typed here, so a threshold change
        // cannot silently desync from what the record claims was applied.
        thresholds: {
          lowSimilarityThreshold: LOW_SIMILARITY_THRESHOLD,
          lowSimilarityConfidenceCap: LOW_SIMILARITY_CONFIDENCE_CAP,
          missingBrandConfidenceCap: MISSING_BRAND_CONFIDENCE_CAP,
          categoryMismatchConfidenceCap: CATEGORY_MISMATCH_CONFIDENCE_CAP,
        },
        verdict:
          gate.bypassedChecks.length > 0
            ? 'bypassed'
            : validation.confidence < confidenceBeforeGate
              ? 'capped'
              : 'passed',
        effect:
          gate.bypassedChecks.length > 0
            ? `BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING is set: ${gate.bypassedChecks.join(', ')} detected but not enforced. ${
                gate.issues.length > 0 ? `Issues: ${gate.issues.join(' | ')}` : ''
              }`
            : validation.confidence < confidenceBeforeGate
              ? `Confidence ${confidenceBeforeGate} → ${validation.confidence}${
                  gate.issues.length > 0 ? `; issues added: ${gate.issues.join(' | ')}` : ''
                }.`
              : `No change; confidence stayed at ${validation.confidence}.`,
      });
      // B0-358 — say whether the gate that RAN actually acted, not just that it ran.
      if (recommendationConfidenceActivation.state === 'ran') {
        recommendationConfidenceActivation = {
          state: 'ran',
          verdict: validation.confidence < confidenceBeforeGate ? 'capped' : 'passed',
        };
      }
    }

    /**
     * B0-356 — the recommendation engine's own verdict, enforced against the run's confidence.
     *
     * Runs LAST among the validator-step gates, deliberately: `overallConfidence` is the engine's
     * calibrated score for the equivalence claim itself, so it must cap whatever REC-4's
     * retrieval-strength gate above arrived at, never the other way round. The workflow's
     * `sources.length > 0 ? 0.9 : 0.6` default can only ever be lowered here — never raised.
     *
     * The answer-text half of this gate already ran (see `recommendationEngineGate` at the
     * draft-composition chain above); this half owns confidence / approval / human review, plus the
     * `thresholdUsed` + `source` record that makes the two confidence numbers reconcilable after
     * the fact.
     */
    let recommendationEngineVerdictActivation: GateActivationRecord | null = null;
    if (recommendationEngineOutcome && recommendationEngineGate) {
      const confidenceBeforeEngine = validation.confidence;
      const engineVerdict = evaluateRecommendationEngineGate({
        outcome: recommendationEngineOutcome,
        confidence: validation.confidence,
        approved: validation.approved,
        requiresHumanReview: validation.requires_human_review,
        confidenceGatingDisabled: recommendationConfidenceGatingDisabled,
        fallbackDeclineCopy: XREF_DECLINE_COPY,
      });
      validation = {
        ...validation,
        approved: engineVerdict.approved,
        confidence: engineVerdict.confidence,
        issues: Array.from(new Set([...validation.issues, ...engineVerdict.issues])),
        requires_human_review: engineVerdict.requiresHumanReview,
      };
      // B0-492 — same capping-chain rule as every other cap on this step.
      confidenceState = applyConfidenceCap(
        confidenceState,
        confidenceBeforeEngine,
        validation.confidence,
      );
      recommendationEngineVerdictActivation = engineVerdict.capBypassed
        ? { state: 'bypassed', reason: 'confidence_gating_disabled', verdict: engineVerdict.verdict }
        : { state: 'ran', verdict: engineVerdict.verdict };
      audit.enqueue(
        'recommendation_engine_verdict_applied',
        {
          invocation: recommendationEngineOutcome.invocation,
          source: recommendationEngineOutcome.source,
          answered: recommendationEngineOutcome.answered,
          status: recommendationEngineOutcome.status,
          overall_confidence: recommendationEngineOutcome.overallConfidence,
          threshold_used: recommendationEngineOutcome.thresholdUsed,
          confidence_before: confidenceBeforeEngine,
          confidence_after: validation.confidence,
          cap_bypassed: engineVerdict.capBypassed,
          verdict: engineVerdict.verdict,
          answer_replaced_with_decline: recommendationEngineGate.declineText !== null,
        },
        { ...wfCtx, stepId: validationStep.id, toolName: RECOMMEND_CROSS_REFERENCE_TOOL },
      );
      validatorStepGates.push({
        gate: 'recommendation_engine_verdict',
        inputs: {
          // B0-356 AC — `thresholdUsed` and `source` on the persisted step, so the engine's
          // calibrated number and the workflow's own confidence are reconcilable after the fact.
          source: recommendationEngineOutcome.source,
          invocation: recommendationEngineOutcome.invocation,
          answered: recommendationEngineOutcome.answered,
          status: recommendationEngineOutcome.status,
          overallConfidence: recommendationEngineOutcome.overallConfidence,
          declineReasonPresent: Boolean(recommendationEngineOutcome.declineReason),
          workflowConfidenceBefore: confidenceBeforeEngine,
        },
        thresholds: {
          // The engine's own gate threshold (XREF_RECOMMENDATION_MIN_CONFIDENCE), transcribed
          // exactly as the engine reported it — never recomputed here.
          thresholdUsed: recommendationEngineOutcome.thresholdUsed,
        },
        verdict: engineVerdict.verdict,
        effect: engineVerdict.capBypassed
          ? `BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING is set: the engine's overallConfidence ${recommendationEngineOutcome.overallConfidence} would have capped this run's ${confidenceBeforeEngine}, but the cap was not enforced.${
              recommendationEngineGate.declineText
                ? ' The decline copy and human-review escalation WERE still enforced (they are the engine\'s final verdict, not a threshold).'
                : ''
            }`
          : `Confidence ${confidenceBeforeEngine} → ${validation.confidence} (engine overallConfidence ${recommendationEngineOutcome.overallConfidence}, threshold ${recommendationEngineOutcome.thresholdUsed}).${
              recommendationEngineGate.declineText
                ? " The engine's declineReason replaced the draft answer verbatim."
                : ''
            }`,
      });
    }

    await completeWorkflowStep(validationStep.id, {
      status: 'completed',
      output: jsonContent({
        ...validation,
        /**
         * B0-358 — the step's verification level as a first-class field. Previously the ONLY
         * counter-signal to "this answer was validated" was the `validator_bypassed_for_testing`
         * magic string inside `issues`; that token is kept (the observability timeline and
         * historical rows still carry it) but is now redundant with this field, not load-bearing.
         */
        validatorMode,
        /**
         * B0-886 — the first validator pass's own result (issues, confidence, approved,
         * requires_human_review), preserved even though `validation`/`...validation` above is the
         * SECOND pass's result whenever a revision ran. Absent when no revision pass ran this turn
         * (the first pass IS `validation`, so recording it twice would add nothing).
         */
        ...(validationFirstPass ? { validationFirstPass } : {}),
        /**
         * B0-886 — the revision pass's raw (preamble-stripped) output, before any later redaction
         * or cross-reference recomposition. Absent when no revision pass ran, or it ran and was
         * refused (the original draft was kept, so there is nothing distinct to record).
         */
        ...(revisedAnswerRecord !== null ? { revisedAnswer: revisedAnswerRecord } : {}),
        /**
         * B0-554 — usage from every model call this step made (0 on either bypass path, 1 for a
         * plain approval/rejection, 2 when the revision pass triggered a re-check). Placed after
         * `...validation` so it wins over any single-call `usage` that a `ValidatorPassResult`
         * spread might otherwise leave stale on `validation` from just the LAST call.
         */
        ...(validatorUsageByCall.length > 0
          ? {
              usage: sumLlmUsage(validatorUsageByCall),
              usageByCall: validatorUsageByCall,
              // B0-563 — same reasoning as the agent step's `model` field above.
              model: await resolveValidatorModel(input.modelTag),
            }
          : {}),
        ...(useValidator && !canSkipValidatorForHighSimilarity
          ? {}
          : {
              // B0-389 — one unambiguous marker for a step that never called a model, using the
              // same token `validation.issues` already carries (see VALIDATOR_BYPASS_REASON).
              // B0-546 — the high-similarity skip gets its own reason (VALIDATOR_SKIP_HIGH_SIMILARITY_REASON)
              // so it stays distinguishable from the admin `useValidator` toggle being off.
              skipped: true,
              reason: !useValidator
                ? VALIDATOR_BYPASS_REASON
                : VALIDATOR_SKIP_HIGH_SIMILARITY_REASON,
            }),
        /**
         * B0-391 — the deterministic gates that mutated `validation` on this step. Both run after
         * the validator pass (or its bypass), so they belong on this row; the key is absent when
         * neither gate ran.
         */
        ...recordGates(validatorStepGates),
        // B0-492 — which mechanism produced the confidence recorded on THIS step, so the
        // observability trace can render it without reading `answerProvenance`/`issues` strings.
        ...confidenceProvenanceFields(confidenceState),
      }),
    });
    markStepClosed(validationStep.id);
    input.onEvent?.({
      type: 'status',
      stage: 'validation_completed',
      detail: validation.approved ? 'approved' : 'not_approved',
    });

    let finalText = draftAnswer;
    const hasUngroundedRegulatedClaim = regulatedClaimGrounding.ungroundedCategories.length > 0;
    /**
     * B0-350 — the validator prompt explicitly asks it to "Flag prohibited/off-label use
     * suggestions" into `issues` (see `VALIDATOR_SYSTEM_PROMPT`). This is the one
     * validator-detected condition that is a genuine SAFETY problem with the draft's own content
     * (as opposed to a coverage/grounding shortfall), so it stays a hard replace below alongside
     * the regulated-claim guardrail and the usage/safety coverage gate — per the org's
     * regulated-data rule, none of those three gates gets "kinder" here.
     */
    const hasSafetyFlaggedIssue = validation.issues.some((issue) =>
      /\boff[- ]label\b|\bprohibited\b/i.test(issue),
    );
    const draftIsEmpty = draftAnswer.trim().length === 0;

    if (!validation.approved) {
      if (hasUngroundedRegulatedClaim) {
        // B0-257: dedicated fallback for the regulated-claim guardrail -- distinct from the
        // generic "could not verify" message so it's clear the specific blocker is a missing
        // exact citation for a regulated value/statement, not general low retrieval coverage.
        const flagged = regulatedClaimGrounding.ungroundedCategories
          .map((c) => REGULATED_CLAIM_CATEGORY_LABELS[c] ?? c)
          .join(', ');
        // The plan was decided alongside the gate record above (same rejection, same turn); a
        // kill-switch bypass never reaches this branch because `validation.approved` stays true.
        const plan = regulatedClaimRedactionPlan;
        /**
         * B0-1012 — a partial redaction that withheld a `compatibility` sentence carries the same
         * "unlisted surface = not an approved use" governing rule the full decline already states
         * (`REGULATED_CLAIM_GOVERNING_RULES.compatibility`), so the caveat is not lost just because
         * some other part of the answer was grounded and kept. This does not reach a COMPLETELY
         * clean, non-redacted compatibility answer (nothing failed this guardrail to trigger a
         * footer at all) — that surface always carrying the caveat is a system-prompt concern
         * (`product-support-prompts.ts`), out of scope here; see the ticket write-up.
         */
        const compatibilityCaveat =
          plan && plan.mode !== 'decline' && plan.withheldCategories.includes('compatibility')
            ? REGULATED_CLAIM_GOVERNING_RULES.compatibility
            : null;

        if (plan && plan.mode === 'token_redaction') {
          /**
           * B0-1000 — partial redaction: keep the grounded content (e.g. a fully-verified dilution
           * answer) and withhold only the ungrounded token-shaped claim(s), at sentence granularity
           * (see `planRegulatedClaimRedaction`), instead of discarding the whole draft. Nothing here
           * reformats or invents; the withheld sentence(s) are removed verbatim.
           */
          finalText = [
            plan.redactedText,
            '',
            buildRegulatedClaimTokenRedactionFooter(flagged),
            ...(compatibilityCaveat ? ['', compatibilityCaveat] : []),
          ].join('\n');
          answerProvenance = 'regulated_claim_partial_redaction';
        } else if (plan && plan.mode === 'sentence_redaction') {
          /**
           * B0-871 — sentence-level redaction for `compatibility` / `efficacy_claim` on a KNOWLEDGE
           * answer (no locked product line, or knowledge-kind sources dominate), with substantive
           * content left. Each ungrounded sentence was replaced VERBATIM by
           * `regulatedClaimWithheldMarker` — the removed sentence is never rephrased, summarised
           * or hinted at. `hazard` / `first_aid` take this path only on a non-safety question
           * (B0-1131, see the planner).
           *
           * PROPOSED RULE IMPLEMENTED, PENDING TOM'S CONFIRMATION — see
           * `REDACTABLE_SENTENCE_REGULATED_CATEGORIES` and `src/docs/generation-runtimes.md`.
           */
          finalText = [
            plan.redactedText,
            '',
            buildRegulatedClaimSentenceRedactionFooter(flagged),
            ...(compatibilityCaveat ? ['', compatibilityCaveat] : []),
            // B0-1131 — a withheld hazard / first-aid sentence still points at SDS Section 2 / 4
            // (and poison control for first aid), so the safety direction is never just dropped.
            ...plan.withheldCategories
              .filter((c) => SAFETY_SENTENCE_REGULATED_CATEGORIES.has(c))
              .flatMap((c) => ['', REGULATED_CLAIM_GOVERNING_RULES[c]]),
          ].join('\n');
          answerProvenance = 'regulated_claim_partial_redaction';
        } else {
          /**
           * B0-928 (RC5) — the decline now carries the one-sentence GENERAL governing rule for each
           * flagged category (where the approved answer lives, and that it never transfers between
           * products), so a withheld answer is not informationally empty. The rules are
           * product-independent by construction: no value, dilution, contact time, or registration
           * number appears in any of them — see `REGULATED_CLAIM_GOVERNING_RULES`.
           */
          finalText = buildRegulatedClaimDeclineCopy({
            flagged,
            categories: regulatedClaimGrounding.ungroundedCategories,
          });
          /**
           * B0-391 — recorded as `validator_fallback`. The regulated-claim guardrail is a
           * validation-time rejection that replaces the answer with canned copy, exactly like the
           * generic fallback below; it differs only in wording. It is NOT a new provenance value:
           * the specific cause is already unambiguous elsewhere on the run (the
           * `regulated_claim_guardrail_rejected` audit row, the `regulated_claim_unverified:*`
           * validation issues, and the `regulated_claim_unverified` review task), so minting an
           * eighth enum member would add a second spelling for "the answer was withheld at
           * validation" without adding information.
           *
           * B0-829 / B0-871 — this branch now fires only when the planner chose `decline`: an
           * ungrounded `hazard` / `first_aid`, a product-usage-specific question with an ungrounded
           * compatibility/efficacy sentence, nothing grounded left to keep, a snippet that is not a
           * verbatim substring of the draft, or too little substantive content after redaction.
           * The exact reason is on the gate record (`inputs.declineReason`).
           */
          answerProvenance = 'validator_fallback';
        }
      } else if (answerProvenance === 'recommendation_engine_decline') {
        /**
         * B0-356 — the recommendation engine's own `declineReason` is ALREADY the final text (it
         * replaced the draft at composition time, and this branch runs because that same gate set
         * `approved: false`). Keep it verbatim: the generic "I could not fully verify this answer"
         * copy below says strictly less, and the `validator_rejected_draft_retained` branch after
         * it would both re-label the provenance and force human review on what is a normal,
         * expected sub-threshold decline. `requires_human_review` is deliberately left as the
         * engine set it — `escalated`/`pending` already forced it true, `declined` did not.
         *
         * Ordered AFTER the regulated-claim branch above on purpose: an ungrounded regulated claim
         * is the harder rejection and its more specific copy must win.
         */
        finalText = draftAnswer;
      } else if (
        needsUsageSafetyCoverage &&
        (!usageSafetyCoverage.hasUsageEvidence ||
          !usageSafetyCoverage.hasSafetyEvidence)
      ) {
        /**
         * B0-872 — reachable only for a usage/safety-shaped question about an IDENTIFIED product
         * (`needsUsageSafetyCoverage` now requires a product subject). A knowledge question with
         * the same shape but no product ("Can I use a disinfectant or bleach on our wood gym
         * floor?") never gets here: its gate is `not_applicable` (`reason: 'no_product_subject'`)
         * and the draft is kept. This template is for "how do I use <product>" with no label/SDS
         * retrieved — the one case where asking for the exact product/SKU is the right answer.
         */
        finalText = [
          'I do not have enough retrieved evidence to provide a reliable usage and safety answer yet.',
          '',
          '**What I still need**',
          '- Exact Betco product name or SKU.',
          '- Surface/material and application method.',
          '- Any relevant safety constraints for your environment.',
          '',
          'I can then return a grounded answer with both procedure and SDS-backed safety details.',
        ].join('\n');
        answerProvenance = 'usage_safety_fallback';
      } else if (draftIsEmpty || isDeclineAnswer(draftAnswer) || hasSafetyFlaggedIssue) {
        // B0-350: still snap to the generic fallback -- there is nothing substantive to keep
        // (empty draft), the model already declined on its own (no streamed answer to protect),
        // or the validator flagged an actual safety problem in the draft's own content.
        finalText = [
          'I could not fully verify this answer against the retrieved approved sources.',
          '',
          '**Next steps**',
          '- Confirm the exact Betco product name or SKU.',
          '- Specify the surface/material and environment.',
          '',
          'If this is safety-urgent, follow your facility protocol and SDS guidance.',
        ].join('\n');
        answerProvenance = 'validator_fallback';
      } else {
        /**
         * B0-350 (resolves B0-262) — the draft is substantive, the model didn't decline on its
         * own, and the validator's rejection is not a flagged safety problem: never overwrite an
         * answer the user already watched stream in. Keep it visible and escalate for human review
         * instead of hard-replacing it with confusing decline copy.
         *
         * This also completes the B0-368 `revisionRefused` guard above (see its comment): that
         * guard only stopped the REVISION pass's own refusal text from overwriting `draftAnswer` --
         * `validation.approved` stayed false either way, so without this branch the block here
         * still clobbered `finalText` with the canned fallback whenever no safety gate fired.
         */
        finalText = draftAnswer;
        // B0-886 — `draftAnswer` here is either the untouched original draft, or the revision
        // pass's text (recomposed by the cross-reference headline or not) when the SECOND validator
        // pass also rejected it. Distinguishing the two means a reviewer/observability reader can
        // tell which text the user actually saw without cross-referencing the revision step.
        // B0-923 — a restored pre-revision draft is neither of those two: the revision pass DID
        // replace the draft, and then the regulated-claim guardrail put the pre-revision text
        // back. Claiming `revised_answer_retained` here would name the wrong text.
        answerProvenance = preRevisionDraftRestored
          ? 'pre_revision_draft_restored'
          : draftReplacedByRevision
            ? 'revised_answer_retained'
            : 'validator_rejected_draft_retained';
        // Force the flag even when the validator's own judgment didn't request review: a kept
        // (non-hard-replaced) rejection must always surface for a human, never just silently ride
        // through as if nothing happened.
        validation = { ...validation, requires_human_review: true };
      }

      if (validation.requires_human_review) {
        // B0-368 — one discriminator for both the review_tasks row and the audit
        // row, so a reviewer opening a trace sees WHY without reading `issues`.
        const reviewReason = resolveReviewRequestReason({
          hasUngroundedRegulatedClaim,
          revisionPassRefused,
        });
        await insertReviewTask({
          workflowRunId: run.id,
          reason: reviewReason,
          payload: jsonContent({
            issues: validation.issues,
            draft: draftAnswer,
            ...(hasUngroundedRegulatedClaim
              ? { ungroundedRegulatedClaims: regulatedClaimGrounding.ungroundedDetails }
              : {}),
          }),
        });
        audit.enqueue(
          'review_requested',
          { reason: reviewReason, issues: validation.issues },
          wfCtx,
        );
        // B0-350 — a distinct stream event (not a text delta) so the UI can render a "flagged for
        // review" banner without touching the answer text that already streamed to the user. Fired
        // for every human-review escalation on this turn, not just the kept-draft case, so the
        // banner and the persisted `review_tasks` row/`requires_human_review` flag never disagree
        // about whether this turn needs review.
        input.onEvent?.({
          type: 'answer_flagged_for_review',
          reason: reviewReason,
          issues: validation.issues,
          // B0-886 — both `validator_rejected_draft_retained` and `revised_answer_retained` mean
          // "the streamed text was kept, not hard-replaced"; only which TEXT differs.
          // B0-923 — `pre_revision_draft_restored` is the same fact: the pre-revision draft (what
          // the user watched stream in) is what shipped, not canned decline copy.
          answerRetained:
            answerProvenance === 'validator_rejected_draft_retained' ||
            answerProvenance === 'revised_answer_retained' ||
            answerProvenance === 'pre_revision_draft_restored',
        });
      }
    }

    /**
     * B0-1002 — deterministic text-level patch, applied last, after every redaction/revision/decline
     * branch above has settled on `finalText`. See `dilution-dwell-backstop.ts`: a no-op unless this
     * turn is a dilution-system/employee-use how-to question whose served answer already discusses
     * disinfectant dwell/contact time without stating the visibly-wet-for-the-full-labeled-time rule
     * (so it never fires on decline/canned copy, which never mentions dwell at all). Appends the
     * canonical B0-978 sentence verbatim; never rewrites or removes existing text.
     */
    const dilutionDwellBackstopResult = applyDilutionDwellBackstop({
      userMessage: input.userMessage,
      draftAnswer: finalText,
    });
    if (dilutionDwellBackstopResult.applied) {
      finalText = dilutionDwellBackstopResult.answer;
      audit.enqueue(
        'dilution_dwell_backstop_applied',
        { userMessage: input.userMessage },
        wfCtx,
      );
    }

    /**
     * B0-1075 follow-up — deterministic text-level patch, applied last (after the dilution dwell
     * backstop above), attaching the derived betco.com product-page URL next to its `[doc:uuid]`
     * citation in the model's own text. The model was never told a cited source can carry a `url`
     * (see `product-page-url-citation-backstop.ts`), so it never surfaced one on its own — verified
     * live 2026-09-23. Never invents a URL; only attaches one already present on a `sources` entry.
     */
    const productPageUrlCitationResult = applyProductPageUrlCitationBackstop({
      draftAnswer: finalText,
      sources,
    });
    if (productPageUrlCitationResult.applied) {
      finalText = productPageUrlCitationResult.answer;
    }

    // B0-493 — run-level retrieval configuration rollup, computed from the FINAL resolved trace
    // (every forced/injected search call included), not just the model's own calls.
    const retrievalConfig = extractRetrievalConfigFromToolTrace(resolvedToolTrace);
    // B0-619 — rerank timing and product-line lock, rolled up the same way (see the two functions
    // above); both were previously buried in `workflow_steps`' per-call trace with no run-level
    // surface, which is what made B0-619's own investigation require a raw-SQL read.
    const rerankMsTotal = extractRerankMsFromToolTrace(resolvedToolTrace);
    const productLineLock = extractProductLineLockFromToolTrace(resolvedToolTrace);

    const finalOutput: ProductSupportFinalOutput = {
      answerText: finalText,
      sources,
      retrieved_document_chunks,
      retrieval_calls,
      confidence: validation.confidence,
      workflowRunId: run.id,
      latestOpenaiResponseId: finalResponseId,
      validation,
      // B0-886 — the first validator pass's own result, preserved even when a revision pass ran
      // and overwrote `validation` above with a second pass's result. Absent when no revision ran.
      ...(validationFirstPass ? { validationFirstPass } : {}),
      // B0-886 — the revision pass's raw output, before any later redaction/composition. Absent
      // when no revision pass ran, or it ran and was refused.
      ...(revisedAnswerRecord !== null ? { revisedAnswer: revisedAnswerRecord } : {}),
      routingDecision,
      timingBreakdown,
      usage: agentResult.usage,
      // B0-391 — which branch wrote the text the user saw (see the cursor above).
      answerProvenance,
      // B0-393 — stamps of the prompt that ran and of the whole prompt+tool bundle.
      promptVersion,
      promptBundleVersion: PROMPT_BUNDLE_VERSION,
      /**
       * B0-388 — chat context: the captured `instructions` are not the whole model input, so a
       * panel showing only them would imply the model saw less than it did.
       */
      priorMessageCount: input.priorMessages?.length ?? 0,
      // B0-519 — whether this turn's history exceeded the cap; see `capConversationHistory`.
      historyCapApplied,
      // B0-349 — the answer as composed before validator/revision/gate mutation; see the
      // `originalDraftAnswer` capture above.
      draftAnswer: originalDraftAnswer,
      // B0-357 — the one resolved competitor-identity tuple for this turn, when one was needed;
      // absent when the turn never touched the cross-reference path.
      ...(resolvedCompetitor
        ? {
            resolvedCompetitor: {
              brand: resolvedCompetitor.brand,
              product: resolvedCompetitor.product,
              otherCompetitorProduct: resolvedCompetitor.otherCompetitorProduct,
            },
          }
        : {}),
      // B0-490 — raw (pre-curation) vs. post-selection top retrieval similarity for this turn,
      // distinguishable so a chart stops conflating "what the ANN search returned" with "what
      // survived filtering". Absent-key detection lets consumers tell this run apart from one
      // written before this ticket.
      similaritySummary: {
        rawTopSimilarity: similarityRollup.rawTopSimilarity,
        selectedTopSimilarity: similarityRollup.selectedTopSimilarity,
        droppedByFilterCount: similarityRollup.droppedByFilterCount,
      },
      // B0-493 — the retrieval configuration this run actually used, or `mixed` per-field when
      // this turn's search calls disagreed.
      retrievalConfig,
      // B0-619 — rerank timing and product-line lock, surfaced at run level (see the extractors
      // above for why each is null vs. a real absent-value distinction).
      rerankMsTotal,
      productLineLock,
      // B0-491 — the answering agent's OWN self-reported confidence, distinct from `confidence`
      // (validator judgment / bypass heuristic / gate-capped value below).
      agentConfidence: agentSelfConfidence.agentConfidence,
      agentConfidenceBasis: agentSelfConfidence.agentConfidenceBasis,
      agentConfidenceReason: agentSelfConfidence.reason,
      // B0-492 — which of the (up to six) mechanisms produced `confidence` above, plus the
      // pre-cap value/provenance when a gate actually capped it.
      ...confidenceProvenanceFields(confidenceState),
      // B0-494 — the resolved value of every behavior switch this run observed, and which gates
      // ran / were skipped by flag / were bypassed by the B0-452 kill switch / never applied.
      runtimeConfig,
      activeGates: {
        /**
         * B0-358 — `useValidator` alone was not the whole story: the B0-546 high-similarity skip
         * also produces a run where no LLM pass happened. `validatorMode` is the authority; this
         * record now agrees with it instead of claiming `ran` for a skipped pass.
         */
        validator: !useValidator
          ? { state: 'skipped', reason: 'disabled_by_flag' }
          : canSkipValidatorForHighSimilarity
            ? { state: 'skipped', reason: VALIDATOR_SKIP_HIGH_SIMILARITY_REASON }
            : { state: 'ran', verdict: validation.approved ? 'approved' : 'rejected' },
        // B0-358 — this gate ran on every non-declined turn and, by definition, did not decline
        // (a decline short-circuits long before here).
        earlyDeclineGate: earlyDeclineGateEnabled
          ? { state: 'ran', verdict: 'passed' }
          : { state: 'skipped', reason: 'disabled_by_flag' },
        usageSafetyCoverage: usageSafetyCoverageActivation,
        regulatedClaimGuardrail: regulatedClaimGuardrailActivation,
        dilutionCitationGuardrail: dilutionCitationGuardrailActivation,
        recommendationConfidence: recommendationConfidenceActivation,
        // B0-356 — absent-vs-not_applicable matters here: a run predating the gate has no key.
        recommendationEngineVerdict:
          recommendationEngineVerdictActivation ?? { state: 'not_applicable' },
        // B0-751 — absent-vs-not_applicable matters here too: a run predating the check has no key.
        crossReferenceSelfReference: crossReferenceSelfReferenceActivation,
        // B0-948 — absent means the run predates the gate, not that nothing was required.
        factToolEnforcement: factToolEnforcementActivation,
      },
      // B0-358 — the run's actual verification level, first-class rather than a magic string.
      validatorMode,
    };

    audit.enqueue('workflow_completed', { workflow_run_id: run.id }, wfCtx);

    /**
     * B0-439 — three unrelated tables plus the audit flush, none of which reads another's result, so
     * they are issued together instead of one after the other. They are still AWAITED before this
     * function returns: on Vercel Fluid Compute a promise that has not settled when the response
     * finishes can be killed, and a lost terminal write would leave `workflow_runs.status = 'running'`
     * for `stalled-run-sweeper` to reap hours later. The answer text has already been streamed to the
     * caller by this point, so this cost is off TTFT either way.
     */
    await Promise.all([
      updateWorkflowRun(run.id, {
        status: 'completed',
        final_output: jsonContent(finalOutput),
        confidence: validation.confidence,
      }),
      updateConversation(input.conversationId, {
        latest_openai_response_id: finalResponseId,
        latest_model: model,
      }),
      insertMessage({
        conversation_id: input.conversationId,
        role: 'assistant',
        plain_text: finalText,
        openai_response_id: finalResponseId,
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
      }),
      audit.settle(),
    ]);

    // B0-324 — prompt-cache visibility per turn: `cachedPromptTokens` vs `promptTokens` across the
    // model calls in the tool loop (0 cached on a multi-round turn means the prefix isn't being reused).
    logInfo('workflow_completed', {
      ...wfCtx,
      model_calls: agentResult.usageByCall.length,
      prompt_tokens: agentResult.usage.promptTokens,
      cached_prompt_tokens: agentResult.usage.cachedPromptTokens,
    });
    input.onEvent?.({ type: 'status', stage: 'workflow_completed' });

    return finalOutput;
  } catch (err) {
    const message = getErrorMessage(err);
    logError('workflow_failed', { ...wfCtx, message });

    /**
     * B0-390 — a run that died mid-generation is the one most worth inspecting, so the calls that
     * did complete are written onto the agent step as it is failed. Only when the agent step is
     * still OPEN: once it has completed it already holds the full resolved trace, and B0-386's rule
     * is that a completed step is never rewritten (never re-failed, never nulled).
     */
    const partialStepOutputs = new Map<string, Json>();
    if (openStepIds.includes(agentStep.id) && resolvedToolTrace.length > 0) {
      partialStepOutputs.set(
        agentStep.id,
        jsonContent({
          partial: true,
          toolCalls: resolvedToolTrace.length,
          toolTrace: resolvedToolTrace,
        }),
      );
    }

    // B0-386 — blame the step that was actually open (and leave completed steps, with their
    // persisted tool trace, alone) rather than rewriting the agent step every time.
    await failOpenWorkflowSteps(openStepIds, message, partialStepOutputs);

    await updateWorkflowRun(run.id, {
      status: 'failed',
      // B0-428 — a run that streamed some text before dying still has a meaningful TTFT; keep the
      // same `timingBreakdown.ttftMs` shape the completed path writes so the reader stays uniform.
      final_output: jsonContent({ error: message, timingBreakdown: { ttftMs: ttftMs() } }),
    });

    audit.enqueue('workflow_failed', { message }, wfCtx);
    // B0-439 — everything recorded up to the throw (plus this row) is written before the failure
    // leaves this function, so a failed run's trace is as complete as it was when each row was
    // written inline.
    await audit.settle();

    throw err;
  }
}
