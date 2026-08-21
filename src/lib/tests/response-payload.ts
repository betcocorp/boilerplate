import { productLineLockSchema, type ProductLineLock } from '~/lib/audit/trace';
import type { RetrievedDocumentChunkRef } from '~/lib/workflows/product-support/product-support-schemas';
import {
  CONFIDENCE_PROVENANCES,
  resolveConfidenceProvenance,
  type ConfidenceProvenance,
} from '~/lib/workflows/product-support/confidence-provenance';
import {
  activeGatesSchema,
  runtimeConfigSchema,
  type ActiveGates,
  type RuntimeConfig,
} from '~/lib/workflows/product-support/product-support-schemas';

/**
 * Extracts the `workflowRunId` string from a response payload object.
 * Returns null when the field is absent or is not a non-empty string.
 */
export function extractWorkflowRunId(responsePayload: unknown): string | null {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const candidate = (responsePayload as Record<string, unknown>).workflowRunId;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

/**
 * Extracts the `modelTag` string from a workflow `user_input` object.
 * Returns undefined when absent or not a string.
 */
export function extractModelTag(userInput: unknown): string | undefined {
  if (!userInput || typeof userInput !== 'object' || Array.isArray(userInput)) {
    return undefined;
  }

  const candidate = (userInput as Record<string, unknown>).modelTag;
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Pulls every per-source `similarity` value off the response payload's `sources`
 * array and reduces it to {min, max, avg}. Returns null when nothing usable was
 * recorded (e.g. early-decline runs or older payload shapes).
 */
export function extractSimilarityStats(
  responsePayload: unknown,
): { min: number; max: number; avg: number } | null {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const sources = (responsePayload as Record<string, unknown>).sources;
  if (!Array.isArray(sources)) {
    return null;
  }

  const similarities = sources
    .map((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return null;
      }
      const value = (source as Record<string, unknown>).similarity;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    })
    .filter((value): value is number => typeof value === 'number');

  if (similarities.length === 0) {
    return null;
  }

  const min = Math.min(...similarities);
  const max = Math.max(...similarities);
  const avg =
    similarities.reduce((sum, value) => sum + value, 0) / similarities.length;
  return { min, max, avg };
}

/** Returns the max similarity value across all sources, or null if unavailable. */
export function extractItemSimilarityScore(
  responsePayload: unknown,
): number | null {
  const stats = extractSimilarityStats(responsePayload);
  return stats ? stats.max : null;
}

/** Pulls `timingBreakdown.searchMs` if recorded. */
export function extractRagSearchMs(responsePayload: unknown): number | null {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const timing = (responsePayload as Record<string, unknown>).timingBreakdown;
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) {
    return null;
  }

  const searchMs = (timing as Record<string, unknown>).searchMs;
  return typeof searchMs === 'number' && Number.isFinite(searchMs)
    ? searchMs
    : null;
}

/** Reads `confidence` from the top-level response payload. */
export function extractItemValidatorConfidence(
  responsePayload: unknown,
): number | null {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }
  const c = (responsePayload as Record<string, unknown>).confidence;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/**
 * B0-492 — which mechanism produced `confidence` on this item. `'unknown'` (never a judgment
 * class) for a payload written before this ticket, or any malformed value.
 */
export function extractItemConfidenceProvenance(responsePayload: unknown): ConfidenceProvenance {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return resolveConfidenceProvenance(undefined);
  }
  const value = (responsePayload as Record<string, unknown>).confidenceProvenance;
  const validated =
    typeof value === 'string' &&
    (CONFIDENCE_PROVENANCES as readonly string[]).includes(value)
      ? (value as ConfidenceProvenance)
      : undefined;
  return resolveConfidenceProvenance(validated);
}

/** Extracts `timingBreakdown` fields: toolRounds, cacheSource, searchMs. */
export function extractTimingBreakdown(responsePayload: unknown): {
  toolRounds: number;
  cacheSource: string | null;
  searchMs: number | null;
} | null {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const candidate = (responsePayload as Record<string, unknown>)
    .timingBreakdown;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }

  const timing = candidate as Record<string, unknown>;
  const toolRounds = timing.toolRounds;
  const cacheSource = timing.cacheSource;
  const searchMs = timing.searchMs;
  if (typeof toolRounds !== 'number') {
    return null;
  }

  return {
    toolRounds,
    cacheSource: typeof cacheSource === 'string' ? cacheSource : null,
    searchMs: typeof searchMs === 'number' ? searchMs : null,
  };
}

function parseRetrievedDocumentChunksArray(
  raw: unknown,
): RetrievedDocumentChunkRef[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: RetrievedDocumentChunkRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const o = item as Record<string, unknown>;
    const document_id = typeof o.document_id === 'string' ? o.document_id : '';
    if (!document_id) {
      continue;
    }
    const chunk_id = typeof o.chunk_id === 'string' ? o.chunk_id : null;
    const document_kind = typeof o.document_kind === 'string' ? o.document_kind : null;
    const document_title = typeof o.document_title === 'string' ? o.document_title : null;
    const product_line_key = typeof o.product_line_key === 'string' ? o.product_line_key : null;
    out.push({ document_id, chunk_id, document_kind, document_title, product_line_key });
  }
  return out;
}

/** Prefer workflow `retrieved_document_chunks`; fall back to legacy `sources` (camelCase). */
export function extractRetrievedDocumentChunks(
  responsePayload: unknown,
): RetrievedDocumentChunkRef[] {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return [];
  }
  const record = responsePayload as Record<string, unknown>;
  const fromPayload = parseRetrievedDocumentChunksArray(
    record.retrieved_document_chunks,
  );
  if (fromPayload.length > 0) {
    return fromPayload;
  }

  const sources = record.sources;
  if (!Array.isArray(sources)) {
    return [];
  }

  const map = new Map<string, RetrievedDocumentChunkRef>();
  for (const item of sources) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const s = item as Record<string, unknown>;
    const document_id = typeof s.documentId === 'string' ? s.documentId : '';
    if (!document_id) {
      continue;
    }
    const chunk_id = typeof s.chunkId === 'string' ? s.chunkId : null;
    const key = `${document_id}:${chunk_id ?? ''}`;
    if (!map.has(key)) {
      map.set(key, { document_id, chunk_id });
    }
  }
  return [...map.values()];
}

export type SearchRunMatch = {
  chunk_id: string;
  chunk_key: string;
  chunk_index: number;
  heading: string | null;
  chunk_text: string;
  document_id: string;
  document_key: string;
  document_title: string;
  document_kind: string;
  product_key: string | null;
  product_line_key: string | null;
  similarity: number;
};

/** Extracts the top-N matches from a search eval run's response_payload. */
export function extractSearchRunMatches(responsePayload: unknown): SearchRunMatch[] {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return [];
  }

  const raw = (responsePayload as Record<string, unknown>).matches;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      chunk_id: typeof item.chunk_id === 'string' ? item.chunk_id : '',
      chunk_key: typeof item.chunk_key === 'string' ? item.chunk_key : '',
      chunk_index: typeof item.chunk_index === 'number' ? item.chunk_index : 0,
      heading: typeof item.heading === 'string' ? item.heading : null,
      chunk_text: typeof item.chunk_text === 'string' ? item.chunk_text : '',
      document_id: typeof item.document_id === 'string' ? item.document_id : '',
      document_key: typeof item.document_key === 'string' ? item.document_key : '',
      document_title: typeof item.document_title === 'string' ? item.document_title : '',
      document_kind: typeof item.document_kind === 'string' ? item.document_kind : '',
      product_key: typeof item.product_key === 'string' ? item.product_key : null,
      product_line_key: typeof item.product_line_key === 'string' ? item.product_line_key : null,
      similarity: typeof item.similarity === 'number' ? item.similarity : 0,
    }));
}

/** Returns the top similarity score from a search eval payload, or null. */
export function extractSearchRunMaxSimilarity(responsePayload: unknown): number | null {
  const matches = extractSearchRunMatches(responsePayload);
  if (matches.length === 0) return null;
  return Math.max(...matches.map((m) => m.similarity));
}

/** Returns the embedding source label from a search eval payload. */
export function extractSearchRunEmbeddingSource(responsePayload: unknown): string | null {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return null;
  }
  const src = (responsePayload as Record<string, unknown>).embeddingSource;
  return typeof src === 'string' ? src : null;
}

/** Returns the passReason string recorded by the search executor, or null. */
export function extractSearchRunPassReason(responsePayload: unknown): string | null {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return null;
  }
  const reason = (responsePayload as Record<string, unknown>).passReason;
  return typeof reason === 'string' ? reason : null;
}

/** Returns the search timing from a search eval payload (totalMs). */
export function extractSearchRunTotalMs(responsePayload: unknown): number | null {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return null;
  }
  const timings = (responsePayload as Record<string, unknown>).timings;
  if (!timings || typeof timings !== 'object' || Array.isArray(timings)) return null;
  const ms = (timings as Record<string, unknown>).totalMs;
  return typeof ms === 'number' ? ms : null;
}

/**
 * Extracts the `routingDecision` string from a product-support response payload.
 * Returns null when absent or not a non-empty string.
 */
export function extractRoutingDecision(responsePayload: unknown): string | null {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const candidate = (responsePayload as Record<string, unknown>).routingDecision;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

/**
 * B0-349 — extracts the pre-validation `draftAnswer` from a product-support response payload:
 * the answer as composed before the validator, revision pass, or any downstream gate could
 * rewrite it. Returns null when absent (historical payloads, or payloads where it equals the
 * final answer and callers may choose not to render it separately).
 */
export function extractDraftAnswer(responsePayload: unknown): string | null {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return null;
  }
  const candidate = (responsePayload as Record<string, unknown>).draftAnswer;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

/**
 * B0-398 — extracts the per-item `promptVersion` hash (B0-393) stamped onto
 * `response_payload`. Returns null for pre-capture items (the field never existed) and any
 * malformed payload. Store/compare the full hash; use `shortHash` (from
 * `~/lib/workflows/product-support/prompt-version`) only for display.
 */
export function extractPromptVersion(responsePayload: unknown): string | null {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const candidate = (responsePayload as Record<string, unknown>).promptVersion;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

/**
 * B0-398 — extracts the run-level `promptBundleVersion` hash (B0-393) stamped onto every item's
 * `response_payload` for a given run (it is a build-time constant, identical across every item in
 * the same run). Returns null for pre-capture items.
 */
export function extractPromptBundleVersion(responsePayload: unknown): string | null {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const candidate = (responsePayload as Record<string, unknown>).promptBundleVersion;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

export type PromptBundleVersionSummary =
  | { kind: 'none' }
  | { kind: 'single'; value: string }
  | { kind: 'multiple'; count: number };

/**
 * B0-398 — summarizes the `promptBundleVersion` values across a run's items into a single
 * displayable shape. Since the field is a build-time constant, a normal run has exactly one
 * distinct non-null value; more than one (e.g. a deploy mid-run) must render as a count rather
 * than silently picking one value to show as if it applied to the whole run.
 */
export function summarizePromptBundleVersions(
  responsePayloads: readonly unknown[],
): PromptBundleVersionSummary {
  const values = new Set(
    responsePayloads
      .map((payload) => extractPromptBundleVersion(payload))
      .filter((value): value is string => value !== null),
  );
  if (values.size === 0) {
    return { kind: 'none' };
  }
  if (values.size === 1) {
    return { kind: 'single', value: [...values][0]! };
  }
  return { kind: 'multiple', count: values.size };
}

/**
 * B0-399 — extracts the search-eval `query` string (the query sent to vector search before any
 * rewrite) from a search-run `response_payload`.
 */
export function extractSearchRunQuery(responsePayload: unknown): string | null {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return null;
  }
  const value = (responsePayload as Record<string, unknown>).query;
  return typeof value === 'string' ? value : null;
}

/**
 * B0-399 — extracts the search-eval `queryRewritten` string, when the executor rewrote the query
 * before search. Null when no rewrite happened or the field is absent.
 */
export function extractSearchRunQueryRewritten(responsePayload: unknown): string | null {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return null;
  }
  const value = (responsePayload as Record<string, unknown>).queryRewritten;
  return typeof value === 'string' ? value : null;
}

/**
 * B0-494 — the resolved runtime-switch snapshot for the run behind this item, when present.
 * Returns null for a historical payload written before this ticket (readers must render that as
 * unknown, never as "fully enabled" — never default any field to `true`/`false` here).
 */
export function extractRuntimeConfig(responsePayload: unknown): RuntimeConfig | null {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return null;
  }
  const parsed = runtimeConfigSchema.safeParse(
    (responsePayload as Record<string, unknown>).runtimeConfig,
  );
  return parsed.success ? parsed.data : null;
}

/** B0-494 — per-gate activation state for the run behind this item, when present. */
export function extractActiveGates(responsePayload: unknown): ActiveGates | null {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return null;
  }
  const parsed = activeGatesSchema.safeParse(
    (responsePayload as Record<string, unknown>).activeGates,
  );
  return parsed.success ? parsed.data : null;
}

/**
 * B0-619 — the run-level retrieval strategy ('vector'|'hybrid'|'vector+reranked'|'hybrid+reranked'),
 * rolled up from every search-backed tool call this turn (`retrievalConfig.retrievalStrategy`,
 * B0-493 — see `extractRetrievalConfigFromToolTrace`). Null when this turn's search calls
 * disagreed (see `retrievalConfig.mixed`), no search tool ran, or on a payload written before
 * B0-493.
 */
export function extractRetrievalStrategy(responsePayload: unknown): string | null {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return null;
  }
  const retrievalConfig = (responsePayload as Record<string, unknown>).retrievalConfig;
  if (!retrievalConfig || typeof retrievalConfig !== 'object' || Array.isArray(retrievalConfig)) {
    return null;
  }
  const value = (retrievalConfig as Record<string, unknown>).retrievalStrategy;
  return typeof value === 'string' ? value : null;
}

/**
 * B0-619 — sum of `rerankMs` across every search-backed tool call this turn (`rerankMsTotal`).
 * Null when no search tool ran this turn, or on a payload written before this ticket.
 */
export function extractRerankMsTotal(responsePayload: unknown): number | null {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return null;
  }
  const value = (responsePayload as Record<string, unknown>).rerankMsTotal;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * B0-619 — the product-line lock decision behind this turn's retrieval (`productLineLock`), the
 * signal that used to require reading raw `workflow_steps` JSON to see whether retrieval actually
 * locked onto a single product line or backed off as ambiguous. Null when no search tool ran this
 * turn, or on a payload written before this ticket.
 */
export function extractProductLineLock(responsePayload: unknown): ProductLineLock | null {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return null;
  }
  const parsed = productLineLockSchema.safeParse(
    (responsePayload as Record<string, unknown>).productLineLock,
  );
  return parsed.success ? parsed.data : null;
}

/** Extracts completed/total progress from a run summary object. */
export function extractProgress(
  summary: unknown,
  totalItems: number,
): { completedItems: number; totalItems: number } {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return { completedItems: 0, totalItems };
  }

  const data = summary as Record<string, unknown>;
  return {
    completedItems:
      typeof data.completed_items === 'number' ? data.completed_items : 0,
    totalItems:
      typeof data.total_items === 'number' ? data.total_items : totalItems,
  };
}
