import { getErrorMessage } from '~/lib/utils';
import { writeAuditLog } from '~/lib/audit/audit-log';
import type { ToolTraceEntry } from '~/lib/audit/trace';
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
import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';
import { evaluateRecommendationGate } from '~/lib/recommendations/recommendation-gate';
import {
  lookupCrossReference,
  fetchRecommendationContext,
} from '~/lib/tools/cross-reference-lookup';
import { buildCompetitiveRecommendationAnswer } from '~/lib/recommendations/recommendation-answer';
import { productSupportTools } from '~/lib/tools/definitions';
import { executeToolCall } from '~/lib/tools/execute-tool-call';

import {
  buildProductSupportInstructions,
  buildProductSupportPromptCacheKey,
} from '~/lib/workflows/product-support/product-support-prompts';
import {
  type ProductSupportFinalOutput,
  type RetrievedDocumentChunkRef,
  type ValidatorResult,
} from '~/lib/workflows/product-support/product-support-schemas';
import {
  evaluateRegulatedClaimGrounding,
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

export type EarlyDeclineDecision = {
  reason:
    | 'chemical_mixing_or_safety'
    | 'legal_or_compliance'
    | 'storage_or_expiration'
    | 'broad_recommendation_without_context';
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
): Promise<void> {
  const mostRecentFirst = [...openStepIds].reverse();
  for (const [index, stepId] of mostRecentFirst.entries()) {
    await completeWorkflowStep(stepId, {
      status: 'failed',
      error: jsonContent(
        index === 0
          ? { message }
          : { message, reason: ABANDONED_WORKFLOW_STEP_REASON },
      ),
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

  const model = resolveResponsesModel(input.modelTag);
  const client = getOpenAIClient();

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
    input: jsonContent({ message: input.userMessage }),
    output: jsonContent({
      routing: {
        decision: routingDecision,
        scores: {
          product: route.productScore,
          bathroom: route.bathroomScore,
          dilution: route.dilutionScore,
          floor: route.floorScore,
          recommendations: route.recommendationScore,
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

  if (earlyDeclineDecision) {
    const declineResponseId = `decline_gate:${run.id}`;
    const finalText = earlyDeclineDecision.text;
    const validation: ValidatorResult = {
      approved: true,
      confidence: 0.92,
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
      }),
      completed_at: new Date().toISOString(),
    });

    await writeAuditLog(
      'step_completed',
      {
        step: 'early_decline_gate',
        step_id: policyGateStep.id,
        reason: earlyDeclineDecision.reason,
      },
      { ...wfCtx, stepId: policyGateStep.id },
    );

    await updateWorkflowRun(run.id, {
      status: 'completed',
      final_output: jsonContent(finalOutput),
      confidence: validation.confidence,
    });

    await updateConversation(input.conversationId, {
      latest_model: model,
    });

    await insertMessage({
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
    });

    await writeAuditLog(
      'workflow_completed',
      {
        workflow_run_id: run.id,
        early_decline_reason: earlyDeclineDecision.reason,
      },
      wfCtx,
    );
    logInfo('workflow_completed', {
      ...wfCtx,
      early_decline_reason: earlyDeclineDecision.reason,
    });
    input.onEvent?.({ type: 'status', stage: 'workflow_completed' });

    return finalOutput;
  }

  const agentStep = await insertWorkflowStep({
    workflow_run_id: run.id,
    step_name: 'openai_responses_agent',
    status: 'running',
    input: jsonContent({
      model,
      hasPreviousResponse: Boolean(input.previousOpenaiResponseId),
    }),
  });
  markStepOpen(agentStep.id);

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

    const executeTool = async ({
      name,
      argumentsJson,
      callId,
    }: {
      name: string;
      argumentsJson: string;
      callId: string;
    }) => {
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
        // B0-363: failures also carry `error_message` + a bounded `arguments_preview`
        // so the cause is recoverable from the audit row alone.
        buildToolCallAuditPayload(out.trace),
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
    };

    const toolChoice = shouldForceCrossReferenceLookup(input.userMessage)
      ? ({ type: 'function', name: 'lookup_cross_reference' } as const)
      : ('required' as const);

    // Generation runtime: AI SDK (`streamText`) when BEX_AI_SDK_GENERATION_ENABLED, else the
    // OpenAI Responses tool loop. Both return the same { assistantText, finalResponseId,
    // toolTrace, responseIds } shape consumed below.
    const agentResult = useAiSdkGeneration
      ? await runAiSdkWithToolLoop({
          modelTag: input.modelTag,
          instructions,
          history: input.priorMessages ?? [],
          userMessage: input.userMessage,
          toolChoice,
          promptCacheKey,
          onAssistantDelta: input.onAssistantDelta,
          observeAssistantDelta,
          executeTool,
        })
      : await runResponsesWithToolLoop({
          client,
          model,
          instructions,
          tools: productSupportTools,
          userMessage: input.userMessage,
          previousResponseId: input.previousOpenaiResponseId ?? null,
          toolChoice,
          promptCacheKey,
          onAssistantDelta: input.onAssistantDelta,
          observeAssistantDelta,
          executeTool,
        });

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

    const resolvedToolTrace = [...agentResult.toolTrace];
    const crossReferenceIntent = shouldForceCrossReferenceLookup(input.userMessage);
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
      const forced = await lookupCrossReference({
        brand: input.userMessage,
        productName: input.userMessage,
      });
      const top = forced.matches?.[0];
      if (top && !forced.fallbackRecommended) {
        crossReferenceResult = {
          fallbackRecommended: false,
          match: top as unknown as CrossReferenceMatch,
        };
        overrideFromSafetyNet = true;
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
    } else if (crossReferenceResult?.match.productUrl?.trim()) {
      draftAnswer = composeCrossReferenceUserFacingAnswer({
        match: crossReferenceResult.match,
        assistantText: agentResult.assistantText,
      });
    }

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

    await completeWorkflowStep(agentStep.id, {
      status: 'completed',
      output: jsonContent({
        responseIds: agentResult.responseIds,
        toolCalls: agentResult.toolTrace.length,
        // Full per-call trace (B0-331) so the observability timeline can render
        // arguments/output previews, ok flags and durations without a migration.
        toolTrace: agentResult.toolTrace,
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
      input: jsonContent({ modelTag: input.modelTag ?? 'preview' }),
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
        issues: ['validator_bypassed_for_testing'],
        requires_human_review: false,
      };
    }

    await writeAuditLog('validation_completed', validation, {
      ...wfCtx,
      stepId: validationStep.id,
    });

    if (useValidator && !validation.approved && validation.issues.length > 0) {
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
      if (revised && !revisionRefused) {
        draftAnswer = revised;
        if (crossReferenceResult?.match.productUrl?.trim()) {
          draftAnswer = composeCrossReferenceUserFacingAnswer({
            match: crossReferenceResult.match,
            assistantText: revised,
          });
        }
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
      } else {
        revisionPassRefused = true;
        validation = { ...validation, requires_human_review: true };
        await writeAuditLog(
          'revision_skipped_refusal',
          { issues: validation.issues },
          { ...wfCtx, stepId: validationStep.id },
        );
      }
    }

    if (
      needsUsageSafetyCoverage &&
      (!usageSafetyCoverage.hasUsageEvidence ||
        !usageSafetyCoverage.hasSafetyEvidence)
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
      await writeAuditLog(
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
    }

    // B0-257: regulated-claim guardrail -- runs unconditionally (independent of the
    // `useValidator` opt-in toggle above, which only gates the LLM semantic-judge pass).
    // EPA registration, dilution/contact-time, hazard, and first-aid claims must be
    // traceable to an exact quote in a retrieved source; anything that fails is a hard
    // rejection, never a soft warning, per the org's regulated-data rule.
    const regulatedClaimGrounding = evaluateRegulatedClaimGrounding({
      draftAnswer,
      sources: sourceMeta.map((s) => ({
        documentId: s.documentId,
        title: s.title,
        documentBody: s.documentBody,
      })),
    });

    if (regulatedClaimGrounding.ungroundedCategories.length > 0) {
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
      await writeAuditLog(
        'regulated_claim_guardrail_rejected',
        {
          categoriesDetected: regulatedClaimGrounding.categoriesDetected,
          ungroundedCategories: regulatedClaimGrounding.ungroundedCategories,
          ungroundedDetails: regulatedClaimGrounding.ungroundedDetails,
        },
        { ...wfCtx, stepId: validationStep.id },
      );
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
      const gate = evaluateRecommendationGate({
        baseConfidence: validation.confidence,
        topSimilarity: sources.length > 0 ? topSimilarity : null,
      });
      validation = {
        ...validation,
        approved: validation.approved && gate.approved,
        confidence: Math.min(validation.confidence, gate.confidence),
        issues: Array.from(new Set([...validation.issues, ...gate.issues])),
        requires_human_review:
          validation.requires_human_review || gate.requires_human_review,
      };
      await writeAuditLog(
        'recommendation_gate_applied',
        { ...gate, topSimilarity },
        { ...wfCtx, stepId: validationStep.id },
      );
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
        await writeAuditLog(
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
    };

    await updateWorkflowRun(run.id, {
      status: 'completed',
      final_output: jsonContent(finalOutput),
      confidence: validation.confidence,
    });

    await updateConversation(input.conversationId, {
      latest_openai_response_id: finalResponseId,
      latest_model: model,
    });

    await insertMessage({
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
    });

    await writeAuditLog(
      'workflow_completed',
      { workflow_run_id: run.id },
      wfCtx,
    );
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

    // B0-386 — blame the step that was actually open (and leave completed steps, with their
    // persisted tool trace, alone) rather than rewriting the agent step every time.
    await failOpenWorkflowSteps(openStepIds, message);

    await updateWorkflowRun(run.id, {
      status: 'failed',
      // B0-428 — a run that streamed some text before dying still has a meaningful TTFT; keep the
      // same `timingBreakdown.ttftMs` shape the completed path writes so the reader stays uniform.
      final_output: jsonContent({ error: message, timingBreakdown: { ttftMs: ttftMs() } }),
    });

    await writeAuditLog('workflow_failed', { message }, wfCtx);

    throw err;
  }
}
