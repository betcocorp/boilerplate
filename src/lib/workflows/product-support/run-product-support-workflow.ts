import { getErrorMessage } from '~/lib/utils';
import { createAuditLogQueue } from '~/lib/audit/audit-log-queue';
import type { ToolCallOrigin, ToolTraceEntry } from '~/lib/audit/trace';
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
import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { runResponsesWithToolLoop } from '~/lib/openai/responses-runtime';
import { runAiSdkWithToolLoop } from '~/lib/bex/ai-sdk-runtime';
import {
  routeUserMessageToSme,
  SME_ROUTE_MIN_HITS_TO_ROUTE,
  SME_ROUTE_TIE_BREAK_ORDER,
} from '~/lib/orchestrator/sme-routing';
import {
  CATEGORY_MISMATCH_CONFIDENCE_CAP,
  evaluateRecommendationGate,
  LOW_SIMILARITY_CONFIDENCE_CAP,
  LOW_SIMILARITY_THRESHOLD,
  MISSING_BRAND_CONFIDENCE_CAP,
} from '~/lib/recommendations/recommendation-gate';
import { isConfidenceGatingDisabled } from '~/lib/recommendations/confidence-scoring';
import { extractCompetitorProduct } from '~/lib/recommendations/extract-competitor-product';
import { runCrossReferenceRecommendation } from '~/lib/recommendations/persist-recommendation';
import { buildWebFallbackAnswer } from '~/lib/recommendations/web-fallback-answer';
import {
  lookupCrossReference,
  fetchRecommendationContext,
} from '~/lib/tools/cross-reference-lookup';
import { buildCompetitiveRecommendationAnswer } from '~/lib/recommendations/recommendation-answer';
import { productSupportToolsForRoute } from '~/lib/tools/definitions';
import { buildToolTraceEntry, executeToolCall } from '~/lib/tools/execute-tool-call';

import type { Json } from '~/types/supabase.public';

import {
  buildProductSupportInstructions,
  buildProductSupportPromptCacheKey,
  effectivePromptIdForDecision,
  VALIDATOR_SYSTEM_PROMPT,
} from '~/lib/workflows/product-support/product-support-prompts';
import {
  buildPreloadedEvidence,
  buildSpeculativeCallId,
  createSpeculativeReuseExecutor,
  runSpeculativeRetrieval,
} from '~/lib/workflows/product-support/speculative-retrieval';
import {
  gateRecordSchema,
  promptRecordSchema,
  type AnswerProvenance,
  type GateRecord,
  type PromptRecord,
  type ProductSupportFinalOutput,
  type RetrievedDocumentChunkRef,
  type ValidatorResult,
} from '~/lib/workflows/product-support/product-support-schemas';
import {
  computePromptVersion,
  PROMPT_BUNDLE_VERSION,
} from '~/lib/workflows/product-support/prompt-version';
import {
  evaluateRegulatedClaimGrounding,
  resolveRevisionModel,
  resolveValidatorModel,
  REVISION_SYSTEM_PROMPT,
  runRevisionPass,
  runValidatorPass,
} from '~/lib/workflows/product-support/validator';

import type { RunSource } from '~/types/observability';

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
 * The validator now sees the full document body for each source (capped per
 * document) so it can verify claims against the entire approved document
 * rather than a single fragmented chunk.
 */
function buildEvidenceSummary(sources: RetrievedSourceMeta[]): string {
  if (sources.length === 0) {
    return '(no retrieved documents)';
  }

  const segments: string[] = [];
  let total = 0;

  for (const source of sources) {
    const body =
      (source.documentBody && source.documentBody.length > 0
        ? source.documentBody
        : source.snippet) ?? '';
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

export function shouldForceCrossReferenceLookup(userMessage: string) {
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

function isEarlyDeclineGateEnabled() {
  return process.env.BEX_EARLY_DECLINE_GATE_ENABLED !== 'false';
}

/**
 * B0-459 — hard backstop on assistant output length, independent of the prompt's own brevity
 * directive (see `PRODUCT_SUPPORT_SHARED_INSTRUCTIONS`). Decode time scales linearly with output
 * tokens and was measured at ~85% of total turn time at the pre-existing ~551-token average answer.
 *
 * Deliberately generous — this is NOT the ~250-token target the prompt asks for on a simple
 * question, it is a ceiling that only a runaway generation should ever hit, so a legitimate
 * multi-section answer (full maintenance program, stripping/finishing procedure) is never cut off
 * mid-sentence or, worse, mid regulated-value. Configurable via `BEX_MAX_OUTPUT_TOKENS` without a
 * redeploy; falls back to the default on anything that is not a positive finite number.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1200;

export function resolveMaxOutputTokens(): number {
  const raw = process.env.BEX_MAX_OUTPUT_TOKENS;
  if (!raw) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_OUTPUT_TOKENS;
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

export function classifyEarlyDecline(userMessage: string): EarlyDeclineDecision | null {
  if (!isEarlyDeclineGateEnabled()) {
    return null;
  }

  const text = userMessage.toLowerCase();
  const asksChemicalMixing =
    /(mix|mixing|combine|adding|add)\b/.test(text) &&
    /(bleach|ammonia|acid|chlorine|cleaner|concentrate|chemical)/.test(text);
  if (asksChemicalMixing) {
    return {
      reason: 'chemical_mixing_or_safety',
      text: "I'm not able to advise on chemical mixing. Follow the product label and SDS, and involve your EHS lead.",
    };
  }

  if (/(legal|osha|compliant|compliance|regulation|regulatory)/.test(text)) {
    return {
      reason: 'legal_or_compliance',
      text: "I'm not able to provide legal or compliance guidance. Please use your official compliance process.",
    };
  }

  if (
    /(expired|expiration|expire|shelf life|still good after|past expiration|past expiry)/.test(
      text,
    )
  ) {
    return {
      reason: 'storage_or_expiration',
      text: "I'm not able to verify safety for expired or stored products. Follow the product label and SDS before use.",
    };
  }

  if (
    /(what should i use|what do you recommend|what'?s the best|which .* should we use)/.test(
      text,
    ) &&
    // B0-300: a message that already names a competitor product and asks for a
    // Betco cross-reference (e.g. "...alternative to X. What do you recommend?")
    // isn't a broad, context-free request — let it reach the cross-reference /
    // recommendations flow that knows how to answer (or correctly decline) it.
    !shouldForceCrossReferenceLookup(userMessage)
  ) {
    return {
      reason: 'broad_recommendation_without_context',
      text: "I need more details to make a specific recommendation. Please share your surface, soil type, and application method.",
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

type RetrievedSourceMeta = {
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
          s3Key?: string | null;
          sourceUri?: string | null;
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
          // B0-257: thread the source PDF/markdown's S3 location through to the persisted
          // citation object so label/SDS-derived directions/hazards/first-aid answers carry it.
          s3Key: s.s3Key ?? undefined,
          sourceUri: s.sourceUri ?? undefined,
        });
      }
    } catch {
      // Ignore malformed output and continue scanning.
    }
  }

  return [...map.values()].slice(0, 16);
}

/** Every semantic-search hit from tool outputs (deduped), using `rag.document` / `rag.document_chunk` ids. */
function collectRetrievedDocumentChunksFromToolOutputs(
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

function collectSourceMetaFromToolOutputs(
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

function queryNeedsUsageAndSafetyCoverage(userMessage: string) {
  const text = userMessage.toLowerCase();
  return (
    /\b(how do i use|how to use|how should i use|directions|procedure|application|dilution|safe|safety|hazard|ppe|precaution|first aid)\b/.test(
      text,
    ) || /\b(can i use|is it safe)\b/.test(text)
  );
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
 * Decline/refusal markers. When the model declines (e.g. the recommendations agent's
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
 * B0-389 — the single spelling for "the validator pass did not run". The bypassed path used to say
 * `reason: 'temporary_test_bypass'` on the step while putting `validator_bypassed_for_testing` in
 * `validation.issues`, so the same state had two names. The issues token is load-bearing (the
 * observability timeline's `validator_bypass` gate keys off it), so it is the one that survives.
 */
export const VALIDATOR_BYPASS_REASON = 'validator_bypassed_for_testing';

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
  previousOpenaiResponseId?: string | null;
  priorMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  onEvent?: (event: ProductSupportWorkflowEvent) => void;
  onAssistantDelta?: (delta: string) => void;
}): Promise<ProductSupportFinalOutput> {
  const useAiSdkGeneration = process.env.BEX_AI_SDK_GENERATION_ENABLED === 'true';
  const agentMode = input.agentMode ?? DEFAULT_BEX_CHAT_AGENT_MODE;
  const route = routeUserMessageToSme(input.userMessage);
  // B0-389 — read once so the flag recorded as run config is the same value the gate below used.
  const earlyDeclineGateEnabled = isEarlyDeclineGateEnabled();
  const earlyDeclineDecision = classifyEarlyDecline(input.userMessage);
  const routingDecision =
    agentMode === 'orchestrator'
      ? (route.agent ?? 'ambiguous')
      : agentMode;
  // REC-4: the claims-validator requires RAG evidence for every assertion, which a competitive
  // recommendation (grounded by its cross-reference match, not by retrieved chunks) can't satisfy —
  // forcing it on made the validator reject the recommendation as "unsupported" and the not-approved
  // fallback overwrote it with "I could not fully verify…". Chemistry-consistency + confidence
  // calibration for recommendations is instead enforced by evaluateRecommendationGate (below), which
  // runs regardless of this flag. So the validator stays opt-in on every route.
  const useValidator = input.useValidator ?? false;
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
      recommendationScore: route.recommendationScore,
    },
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
   * B0-391 — the keyword-routing gate: five scores, the phrases behind them, and which branch
   * decided. In `orchestrator` mode the verdict IS the branch taken (`no_signal` is the state the
   * workflow relabels `ambiguous`); in a forced direct mode the scores were computed but did not
   * decide, and saying so is the point of recording the gate at all.
   */
  const keywordRoutingGate: GateRecord = {
    gate: 'keyword_routing',
    inputs: {
      agentMode,
      scores: {
        product: route.productScore,
        bathroom: route.bathroomScore,
        dilution: route.dilutionScore,
        floor: route.floorScore,
        recommendations: route.recommendationScore,
      },
      // B0-392 — the counts are not comparable across categories (the lists overlap internally),
      // so the phrases are what make a score reviewable.
      matchedPhrases: route.matchedPhrases,
      decisiveRecommendationPhrases: route.decisiveRecommendationPhrases,
      routedAgent: route.agent,
      decisionPath: route.decisionPath,
      tiedCategories: route.tiedCategories,
      rationale: route.rationale,
    },
    thresholds: {
      minHitsToRoute: SME_ROUTE_MIN_HITS_TO_ROUTE,
      tieBreakOrder: [...SME_ROUTE_TIE_BREAK_ORDER],
      decisiveRecommendationSignalWinsOutright: true,
    },
    verdict: agentMode === 'orchestrator' ? route.decisionPath : 'overridden_by_direct_mode',
    effect:
      agentMode === 'orchestrator'
        ? route.agent
          ? `Routed to the ${route.agent} specialist; ran the ${effectivePromptId} prompt.`
          : `No keyword signal fired, so routingDecision is "ambiguous" — the ${effectivePromptId} specialist prompt ran by fallthrough, while the model was told "No specialist keywords matched".`
        : `Admin forced direct \`${agentMode}\` routing, so the keyword scores did not decide; ran the ${effectivePromptId} prompt.`,
  };

  const model = resolveResponsesModel(input.modelTag);
  const client = getOpenAIClient();
  /** B0-389 — which generation runtime the agent prompt ran on; same flag that picks the branch. */
  const agentRuntime: PromptRecord['runtime'] = useAiSdkGeneration ? 'ai-sdk' : 'responses';

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
    user_input: jsonContent({
      message: input.userMessage,
      modelTag: input.modelTag ?? 'preview',
    }),
  });

  const wfCtx = { ...ctx, workflowRunId: run.id };

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
          floor: route.floorScore,
          recommendations: route.recommendationScore,
        },
        rationale: routingRationale,
      },
      // B0-391 — the same routing decision as a structured gate record (phrases + thresholds).
      ...recordGates([keywordRoutingGate]),
    }),
    completed_at: new Date().toISOString(),
  });

  audit.enqueue(
    'step_started',
    { step: 'orchestration_planner', step_id: plannerStep.id },
    { ...wfCtx, stepId: plannerStep.id },
  );

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
      previousResponseId: input.previousOpenaiResponseId ?? null,
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
              crossReferenceIntent: shouldForceCrossReferenceLookup(input.userMessage),
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
      hasPreviousResponse: Boolean(input.previousOpenaiResponseId),
      /**
       * B0-389 — captured here, ABOVE the `useAiSdkGeneration` fork below, so both generation
       * runtimes inherit the same record. `runtime` is derived from the very flag that picks the
       * branch: the same prompt on a different runtime is a different experiment, because the two
       * runtimes assemble the model input differently (replayed `priorMessages` vs. a server-side
       * `previous_response_id` chain).
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
    const forcedToolChoiceName = shouldForceCrossReferenceLookup(input.userMessage)
      ? 'lookup_cross_reference'
      : null;
    let forcedToolChoiceConsumed = false;

    const executeTool = async ({
      name,
      argumentsJson,
      callId,
      speculative,
    }: {
      name: string;
      argumentsJson: string;
      callId: string;
      /** B0-436 — this call was fired before the first model call, not requested by the model. */
      speculative?: boolean;
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

      const out = await executeToolCall({ name, argumentsJson, callId, origin });
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

    const forcedCrossReference = shouldForceCrossReferenceLookup(input.userMessage);

    /**
     * B0-461 — the forced-cross-reference path still pins `tool_choice` to the named
     * `lookup_cross_reference` function (a full single-call collapse was judged too risky here: the
     * pinned-tool attribution, the safety-net override, and the persisted-trace ordering asserted by
     * `workflow-instrumentation.test.ts` all assume the model's own call is what resolves a match).
     * Ticket's fallback instead applies to the piece of this path that is actually slow and
     * sequential today: the curated-override safety net further down only starts its lookup AFTER
     * the full two-round model loop completes and comes up empty. Kicking it off here, concurrently
     * with that loop, overlaps its DB round trip with the model's forced tool-call round instead of
     * stacking after it — exactly the case the ticket's BNC-15 -> Triforce example exercises. Uses
     * the same lenient full-message args as the safety net below (`{ brand: message, productName:
     * message }`); `.catch` only suppresses an unhandled-rejection warning when the model's own call
     * already resolves a match and this prefetch is never awaited — the real await below still sees
     * a genuine rejection.
     */
    const safetyNetLookupPrefetch = forcedCrossReference
      ? (() => {
          const promise = lookupCrossReference({
            brand: input.userMessage,
            productName: input.userMessage,
          });
          promise.catch(() => undefined);
          return promise;
        })()
      : null;

    // B0-439 — the rows recorded so far go out DURING the retrieval below, not before it.
    audit.flushDetached();

    /**
     * B0-436 — speculative retrieval. Runs the obvious `search_product_docs` call ourselves so the
     * first model call can be the answering call. Placed after the early-decline gate (which returns
     * long before here) so no run ever pays for a search whose result is discarded.
     */
    const speculation = await runSpeculativeRetrieval({
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

    const toolChoice = forcedCrossReference
      ? ({ type: 'function', name: 'lookup_cross_reference' } as const)
      : usableSpeculation
        ? // Round 1 already holds retrieved evidence, so forcing another tool call would re-create
          // the wasted round this ticket removes.
          ('auto' as const)
        : ('required' as const);

    const preloadedEvidence = usableSpeculation
      ? buildPreloadedEvidence({
          userMessage: input.userMessage,
          // B0-437 — the model gets the slimmed variant when the tool produced one; the FULL
          // payload is what `toolOutputLog` (validator + regulated-claim guardrail) already holds.
          output: usableSpeculation.modelOutput ?? usableSpeculation.output,
        })
      : undefined;

    // B0-439 — the speculative call's rows go out DURING the model call, not before it: nothing
    // between here and the first token waits on `audit_logs` any more.
    audit.flushDetached();

    // B0-459 — same ceiling on both runtimes; see `resolveMaxOutputTokens`.
    const maxOutputTokens = resolveMaxOutputTokens();

    // Generation runtime: AI SDK (`streamText`) when BEX_AI_SDK_GENERATION_ENABLED, else the
    // OpenAI Responses tool loop. Both return the same { assistantText, finalResponseId,
    // toolTrace, responseIds } shape consumed below.
    const agentResult = useAiSdkGeneration
      ? await runAiSdkWithToolLoop({
          modelTag: input.modelTag,
          instructions,
          history: input.priorMessages ?? [],
          userMessage: input.userMessage,
          tools: routeTools,
          toolChoice,
          promptCacheKey,
          preloadedEvidence,
          maxOutputTokens,
          onAssistantDelta: input.onAssistantDelta,
          observeAssistantDelta,
          executeTool: executeToolForGeneration,
        })
      : await runResponsesWithToolLoop({
          client,
          model,
          instructions,
          tools: routeTools,
          userMessage: input.userMessage,
          previousResponseId: input.previousOpenaiResponseId ?? null,
          toolChoice,
          promptCacheKey,
          preloadedEvidence,
          maxOutputTokens,
          onAssistantDelta: input.onAssistantDelta,
          observeAssistantDelta,
          executeTool: executeToolForGeneration,
        });

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
     * is treated as equivalent to the recommendations route so the override always wins.
     */
    const useCrossReferencePostProcessing =
      routingDecision === 'recommendations' || crossReferenceIntent;
    let crossReferenceResult =
      extractTopCrossReferenceMatchFromToolOutputs(toolOutputLog) ??
      extractTopCrossReferenceMatch(resolvedToolTrace);

    // Deterministic override safety-net: don't depend on the model to call lookup_cross_reference
    // with the competitor's exact name. On the recommendations route, if no cross-reference surfaced,
    // consult the curated override directly with the raw user message — the lenient matcher finds the
    // competitor mention inside it — so a curated equivalence (e.g. BNC-15 → Triforce) always wins.
    let overrideFromSafetyNet = false;
    if (useCrossReferencePostProcessing && !crossReferenceResult) {
      const safetyNetArgs = {
        brand: input.userMessage,
        productName: input.userMessage,
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

    // B0-183 — deterministic web-search fallback. When neither the model's forced lookup_cross_reference
    // nor the curated-override safety-net surfaced a match on the recommendations route, this is a genuine
    // "no 1-1 match" case. Don't depend on the model to voluntarily call recommend_cross_reference: run the
    // budgeted web-grounded engine directly (identify competitor → web search → semantic Betco match →
    // confidence gate). Every outcome (answered/declined/pending) is persisted for HITL 1-1 review inside
    // runCrossReferenceRecommendation.
    let webFallback: Awaited<ReturnType<typeof runCrossReferenceRecommendation>> | null = null;
    let webFallbackCompetitorLabel = '';
    if (routingDecision === 'recommendations' && !crossReferenceResult) {
      const competitor = await extractCompetitorProduct(input.userMessage);
      if (competitor.product.trim()) {
        webFallbackCompetitorLabel = [competitor.brand, competitor.product]
          .filter(Boolean)
          .join(' ')
          .trim();
        webFallback = await runCrossReferenceRecommendation(
          { competitorProduct: competitor.product, competitorBrand: competitor.brand },
          { traceId: run.id },
        );
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

    let draftAnswer = agentResult.assistantText;
    /**
     * B0-391 — the single mutable answer-provenance cursor. Several branches below overwrite the
     * answer, so the rule is LAST WRITER THAT ACTUALLY CHANGED THE TEXT WINS: whatever survives here
     * must describe what the user really saw, not the first branch that touched the draft. A
     * composition that returns the text unchanged deliberately does NOT claim provenance.
     */
    let answerProvenance: AnswerProvenance = 'model_generated';
    // A curated-override match (carries analysis facts) is authoritative on the recommendations
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
        assistantText: agentResult.assistantText,
      });
      // The composer is a no-op on a declined answer, or one that already leads with the comparable
      // link — claiming composition there would overstate what the workflow did to the text.
      if (draftAnswer.trim() !== agentResult.assistantText.trim()) {
        answerProvenance = 'cross_reference_composed';
      }
    } else if (webFallback) {
      // B0-183 — surface the web-grounded fallback outcome. An answered result is authoritative on the
      // recommendations route (it already passed the engine's grounding + validator gate); a declined /
      // pending result becomes a decline the user sees and is already queued for human 1-1 review.
      draftAnswer = buildWebFallbackAnswer({
        result: webFallback,
        competitorLabel: webFallbackCompetitorLabel,
      }).answerText;
    }

    // B0-349 — frozen snapshot of the fully-composed answer before the validator, revision pass,
    // or any downstream gate can touch it.
    const originalDraftAnswer = draftAnswer;

    const sources = collectSourcesFromToolOutputs(toolOutputLog);
    const retrieved_document_chunks =
      collectRetrievedDocumentChunksFromToolOutputs(toolOutputLog);
    const sourceMeta = collectSourceMetaFromToolOutputs(toolOutputLog);
    const usageSafetyCoverage = evaluateUsageSafetyCoverage(sourceMeta);
    const needsUsageSafetyCoverage = queryNeedsUsageAndSafetyCoverage(
      input.userMessage,
    );
    let evidenceSummary = buildEvidenceSummary(sourceMeta);
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
    if (routingDecision === 'recommendations' && webFallback?.answered) {
      const top = webFallback.candidates[0];
      const xref = [
        `Web-grounded cross-reference (confidence ${webFallback.overallConfidence.toFixed(2)}):`,
        `competitor "${webFallbackCompetitorLabel}" maps to Betco "${top?.betcoTitle ?? ''}".`,
        "This web-grounded recommendation already passed the recommendation engine's grounding and validator gate; it is the support for the equivalence claim.",
      ].join(' ');
      evidenceSummary = evidenceSummary ? `${xref}\n\n${evidenceSummary}` : xref;
    }

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
        usage: agentResult.usage,
        usageByCall: agentResult.usageByCall,
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
         */
        ...(useValidator
          ? recordPrompt({
              stage: 'validator',
              instructions: VALIDATOR_SYSTEM_PROMPT,
              model: resolveValidatorModel(input.modelTag),
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
        issues: [VALIDATOR_BYPASS_REASON],
        requires_human_review: false,
      };
    }

    audit.enqueue('validation_completed', validation, {
      ...wfCtx,
      stepId: validationStep.id,
    });

    if (useValidator && !validation.approved && validation.issues.length > 0) {
      /**
       * B0-389 — the revision pass is its own model call, with its own prompt, model and output, so
       * it gets its own step. Filing it under the validator step (as it was) made a rewritten answer
       * look like the validator had produced it.
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
            model: resolveRevisionModel(input.modelTag),
            runtime: 'responses',
          }),
        }),
      });
      markStepOpen(revisionStep.id);

      const revised = (
        await runRevisionPass({
          draftAnswer,
          validatorIssues: validation.issues,
          evidenceSummary,
          modelTag: input.modelTag,
        })
      ).trim();
      // The revision pass is told to refuse / ask for docs when it can't ground the flagged
      // claims. Never let such a refusal OVERWRITE a substantive answer the user already saw —
      // keep the draft and flag it for review instead. This matters most for recommendations,
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
       * taken: a refusal deliberately keeps the original draft, so `outcome` records that the answer
       * the user saw is still the draft.
       */
      await completeWorkflowStep(revisionStep.id, {
        status: 'completed',
        output: jsonContent({
          refused: revisionRefused,
          outcome: revisionRefused ? 'refused_draft_retained' : 'draft_replaced',
          revisedAnswer: revised,
        }),
      });
      markStepClosed(revisionStep.id);

      if (revised && !revisionRefused) {
        draftAnswer = revised;
        // B0-391 — the revision model wrote this text, replacing whatever the earlier branches had.
        answerProvenance = 'revision_pass';
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
        validation = await runValidatorPass({
          draftAnswer,
          evidenceSummary,
          modelTag: input.modelTag,
        });
        audit.enqueue(
          'validation_completed',
          { pass: 'second', ...validation },
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
      hasUsageEvidence: usageSafetyCoverage.hasUsageEvidence,
      hasSafetyEvidence: usageSafetyCoverage.hasSafetyEvidence,
      retrievedSourceCount: sourceMeta.length,
    };

    if (
      needsUsageSafetyCoverage &&
      (!usageSafetyCoverage.hasUsageEvidence ||
        !usageSafetyCoverage.hasSafetyEvidence) &&
      !isConfidenceGatingDisabled()
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
    const regulatedClaimGrounding = evaluateRegulatedClaimGrounding({
      draftAnswer,
      sources: sourceMeta.map((s) => ({
        documentId: s.documentId,
        title: s.title,
        documentBody: s.documentBody,
      })),
    });

    if (regulatedClaimGrounding.ungroundedCategories.length > 0) {
      if (isConfidenceGatingDisabled()) {
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
      } else {
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
        audit.enqueue(
          'regulated_claim_guardrail_rejected',
          {
            categoriesDetected: regulatedClaimGrounding.categoriesDetected,
            ungroundedCategories: regulatedClaimGrounding.ungroundedCategories,
            ungroundedDetails: regulatedClaimGrounding.ungroundedDetails,
          },
          { ...wfCtx, stepId: validationStep.id },
        );
      }
    }

    // REC-4: on the competitive-recommendation route, calibrate confidence to retrieval
    // strength (top-hit similarity < 60% cannot exceed 0.75) and enforce chemistry-class
    // consistency once REC-1 grounding + REC-2/3 structured fields are wired (dormant until then).
    //
    // B0-339 widened this past `routingDecision` alongside the branches above. Keeping it on the
    // label alone would have left the same question reporting a higher confidence when it happened
    // to route `product` than when it routed `recommendations` — and this gate only ever tightens
    // confidence, so the conservative direction for an equivalence claim about an EPA-registered
    // product is to apply it whenever the cross-reference post-processing ran.
    if (useCrossReferencePostProcessing) {
      const topSimilarity = sources.reduce(
        (max, s) =>
          typeof s.similarity === 'number' && s.similarity > max
            ? s.similarity
            : max,
        0,
      );
      const gateInput = {
        baseConfidence: validation.confidence,
        topSimilarity: sources.length > 0 ? topSimilarity : null,
      };
      const gate = evaluateRecommendationGate(gateInput);
      const confidenceBeforeGate = validation.confidence;
      validation = {
        ...validation,
        approved: validation.approved && gate.approved,
        confidence: Math.min(validation.confidence, gate.confidence),
        issues: Array.from(new Set([...validation.issues, ...gate.issues])),
        requires_human_review:
          validation.requires_human_review || gate.requires_human_review,
      };
      audit.enqueue(
        'recommendation_gate_applied',
        { ...gate, topSimilarity },
        { ...wfCtx, stepId: validationStep.id },
      );
      /**
       * B0-391 — the same calibration as a structured record. The audit row above is kept: it is
       * the ONLY record for every run predating this step, and the timeline still reads it.
       *
       * `inputs` lists exactly what the call site passes. `evaluateRecommendationGate` also accepts
       * `competitorChemistryClass`, `recommendedChemistryClass` and `brandKnown`, but this workflow
       * passes none of them, so the category-mismatch and missing-brand caps cannot fire here —
       * recording them as if they had been evaluated would be a false claim.
       */
      validatorStepGates.push({
        gate: 'recommendation_confidence',
        inputs: {
          ...gateInput,
          retrievedSourceCount: sources.length,
          unwiredInputs: [
            'competitorChemistryClass',
            'recommendedChemistryClass',
            'brandKnown',
          ],
          trigger:
            routingDecision === 'recommendations'
              ? 'recommendations_route'
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
            ? `BEX_DISABLE_CONFIDENCE_GATING is set: ${gate.bypassedChecks.join(', ')} detected but not enforced. ${
                gate.issues.length > 0 ? `Issues: ${gate.issues.join(' | ')}` : ''
              }`
            : validation.confidence < confidenceBeforeGate
              ? `Confidence ${confidenceBeforeGate} → ${validation.confidence}${
                  gate.issues.length > 0 ? `; issues added: ${gate.issues.join(' | ')}` : ''
                }.`
              : `No change; confidence stayed at ${validation.confidence}.`,
      });
    }

    await completeWorkflowStep(validationStep.id, {
      status: 'completed',
      output: jsonContent({
        ...validation,
        ...(useValidator
          ? {}
          : {
              // B0-389 — one unambiguous marker for a step that never called a model, using the
              // same token `validation.issues` already carries (see VALIDATOR_BYPASS_REASON).
              skipped: true,
              reason: VALIDATOR_BYPASS_REASON,
            }),
        /**
         * B0-391 — the deterministic gates that mutated `validation` on this step. Both run after
         * the validator pass (or its bypass), so they belong on this row; the key is absent when
         * neither gate ran.
         */
        ...recordGates(validatorStepGates),
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

    if (!validation.approved) {
      if (hasUngroundedRegulatedClaim) {
        // B0-257: dedicated fallback for the regulated-claim guardrail -- distinct from the
        // generic "could not verify" message so it's clear the specific blocker is a missing
        // exact citation for a regulated value/statement, not general low retrieval coverage.
        const categoryLabels: Record<string, string> = {
          epa_registration: 'EPA registration number',
          dilution_ratio: 'dilution ratio',
          contact_time: 'contact/dwell time',
          hazard: 'hazard statement',
          first_aid: 'first-aid instruction',
        };
        const flagged = regulatedClaimGrounding.ungroundedCategories
          .map((c) => categoryLabels[c] ?? c)
          .join(', ');
        finalText = [
          `I can't verify the ${flagged} in this answer against an exact quote from a retrieved label or SDS, so I won't state it.`,
          '',
          'Please consult the product label or SDS directly for the exact regulated value, or contact Betco Product Support / EHS to confirm.',
        ].join('\n');
        /**
         * B0-391 — recorded as `validator_fallback`. The regulated-claim guardrail is a
         * validation-time rejection that replaces the answer with canned copy, exactly like the
         * generic fallback below; it differs only in wording. It is NOT a new provenance value:
         * the specific cause is already unambiguous elsewhere on the run (the
         * `regulated_claim_guardrail_rejected` audit row, the `regulated_claim_unverified:*`
         * validation issues, and the `regulated_claim_unverified` review task), so minting an
         * eighth enum member would add a second spelling for "the answer was withheld at
         * validation" without adding information.
         */
        answerProvenance = 'validator_fallback';
      } else if (
        needsUsageSafetyCoverage &&
        (!usageSafetyCoverage.hasUsageEvidence ||
          !usageSafetyCoverage.hasSafetyEvidence)
      ) {
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
      } else {
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
      }
    }

    const finalOutput: ProductSupportFinalOutput = {
      answerText: finalText,
      sources,
      retrieved_document_chunks,
      confidence: validation.confidence,
      workflowRunId: run.id,
      latestOpenaiResponseId: finalResponseId,
      validation,
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
      previousResponseId: input.previousOpenaiResponseId ?? null,
      // B0-349 — the answer as composed before validator/revision/gate mutation; see the
      // `originalDraftAnswer` capture above.
      draftAnswer: originalDraftAnswer,
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
