import type { RetrievedDocumentChunkRef } from '~/lib/workflows/product-support/product-support-schemas';

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
    out.push({ document_id, chunk_id });
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
