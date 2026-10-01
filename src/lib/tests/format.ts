import type { RetrievedDocumentChunkRef } from '~/lib/workflows/product-support/product-support-schemas';
import { formatDurationSeconds } from '~/lib/utils/time';
import {
  extractItemConfidenceProvenance,
  extractItemSimilarityScore,
  extractItemValidatorConfidence,
  extractTimingBreakdown,
} from '~/lib/tests/response-payload';

/** Formats a raw 0–1 similarity fraction as a percentage string, e.g. "87.3%". Returns "n/a" when unavailable. */
export function formatSimilarityValue(
  value: number | null | undefined,
): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : 'n/a';
}

/**
 * Same as `formatSimilarityValue` but uses an em-dash as the fallback,
 * matching the style used in aggregation/stats columns.
 */
export function formatSimilarityPercent(
  value: number | null | undefined,
): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : '—';
}

/** Formats a 0–100 percent value (already multiplied) with one decimal. Returns "—" when unavailable. */
export function formatPercent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(1)}%`
    : '—';
}

/**
 * Formats a `boolean | null` expectation flag as a human-readable label for UI badges and table
 * cells. B0-932 retired `expected_should_answer`, so `should_cite` is now its only subject.
 */
export function formatYesNoLabel(value: boolean | null): string {
  if (value === null) return 'Unset';
  return value ? 'Yes' : 'No';
}

/**
 * Formats a `boolean | null` expectation flag for CSV export. Returns lowercase "yes" / "no" / ""
 * (empty for unset) — the same vocabulary the importer in `~/lib/tests/csv` accepts, so exports
 * re-import unchanged.
 *
 * B0-932 retired `expected_should_answer`, so `should_cite` is now the only flag of this shape.
 */
export function formatYesNoExport(value: boolean | null): string {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return '';
}

/**
 * Formats a combined "max similarity / validator confidence (provenance)" label from a response
 * payload. Returns "n/a" when neither value is present.
 *
 * B0-492 — every rendered confidence number carries its provenance label (`unknown` for a
 * payload written before this ticket) so a decline-gate-constant, a bypass heuristic, and a real
 * validator judgment are never visually indistinguishable.
 */
export function formatItemSimilarityConfidenceLabel(
  responsePayload: unknown,
): string {
  const maxSimilarity = extractItemSimilarityScore(responsePayload);
  const confidence = extractItemValidatorConfidence(responsePayload);
  if (maxSimilarity == null && confidence == null) {
    return 'n/a';
  }
  const parts: string[] = [];
  if (maxSimilarity != null) {
    parts.push(`${(maxSimilarity * 100).toFixed(1)}%`);
  }
  if (confidence != null) {
    const provenance = extractItemConfidenceProvenance(responsePayload);
    parts.push(`${confidence.toFixed(2)} (${provenance})`);
  }
  return parts.join(' / ');
}

/**
 * Formats a human-readable timing breakdown label from a response payload.
 * Pattern: "toolRounds | cacheSource | searchMs avg"
 */
export function formatTimingBreakdownLabel(responsePayload: unknown): string {
  const timing = extractTimingBreakdown(responsePayload);
  if (!timing) {
    return 'n/a';
  }

  const searchMsLabel =
    typeof timing.searchMs === 'number'
      ? `${timing.searchMs.toFixed(1)} ms avg`
      : 'n/a';
  return `${timing.toolRounds} | ${timing.cacheSource || 'n/a'} | ${searchMsLabel}`;
}

/** Formats retrieved document chunks as a semicolon-separated CSV string: "docId|chunkId; ..." */
export function formatRetrievedChunksForCsv(
  chunks: RetrievedDocumentChunkRef[],
): string {
  if (chunks.length === 0) {
    return '';
  }
  return chunks.map((c) => `${c.document_id}|${c.chunk_id ?? ''}`).join('; ');
}

/** Formats an elapsed-ms value as a duration string, or "—" when unavailable. */
export function formatElapsed(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? formatDurationSeconds(value)
    : '—';
}

/** Formats an absolute percent delta (already in percent units) for trend displays. */
export function formatPercentDelta(absoluteDelta: number): string {
  return `${absoluteDelta.toFixed(1)}%`;
}

/** Formats an absolute similarity delta (0–1 fraction) as a percent string for trend displays. */
export function formatSimilarityDelta(absoluteDelta: number): string {
  return `${(absoluteDelta * 100).toFixed(1)}%`;
}

/** Formats an absolute report-score delta (0–100 points) for trend displays. */
export function formatScoreDelta(absoluteDelta: number): string {
  return `${absoluteDelta.toFixed(1)} pts`;
}

/** Formats an integer, abbreviating to a "k" suffix once it reaches 4+ digits, e.g. 1040 -> "1k", 1055 -> "1.1k", 1256 -> "1.3k". */
export function formatCompactInt(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) < 1000) return value.toLocaleString();
  const compact = (Math.round((value / 1000) * 10) / 10).toFixed(1);
  return `${compact.endsWith('.0') ? compact.slice(0, -2) : compact}k`;
}
