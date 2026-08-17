/**
 * B0-382 — hard size budget on the MODEL-facing tool output string.
 *
 * Retrieval tools return up to 3 full document bodies serialized into one `function_call_output`
 * with no total cap (and the batch efficacy tool can return far more sources than that). This module
 * bounds what enters the model context at the shared tool boundary (`executeToolCall`), so both the
 * Responses and AI SDK runtimes are covered. It NEVER touches the full persisted `output` — the
 * validator and the regulated-claim guardrail keep reading the complete evidence (B0-437 split).
 *
 * Budgets deliberately mirror the validator's own (`VALIDATOR_EVIDENCE_CHAR_BUDGET` /
 * `VALIDATOR_PER_DOCUMENT_CHAR_BUDGET` in `run-product-support-workflow.ts`): if that much evidence
 * is enough to validate an answer, it is enough to write one.
 *
 * REGULATED-DATA RULE: every cut here removes whole TRAILING content only — a body tail, whole
 * trailing sources, or the serialized string's tail — and marks the cut with
 * `TOOL_OUTPUT_TRUNCATION_MARKER`. Retained text is byte-identical to what the tool returned:
 * dilution ratios, oz/gal, ppm, contact times, CAS numbers, and EPA reg numbers are never
 * reformatted, rounded, summarized, or re-flowed.
 */

/** Mirrors `VALIDATOR_EVIDENCE_CHAR_BUDGET`. Env override: `BEX_TOOL_OUTPUT_CHAR_BUDGET`. */
export const DEFAULT_TOOL_OUTPUT_CHAR_BUDGET = 60_000;

/** Mirrors `VALIDATOR_PER_DOCUMENT_CHAR_BUDGET`. Env override: `BEX_TOOL_DOCUMENT_CHAR_BUDGET`. */
export const DEFAULT_TOOL_DOCUMENT_CHAR_BUDGET = 24_000;

export const TOOL_OUTPUT_TRUNCATION_MARKER = '\n...[truncated]';

function parsePositiveIntEnv(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveToolOutputCharBudget(): number {
  return (
    parsePositiveIntEnv(process.env.BEX_TOOL_OUTPUT_CHAR_BUDGET) ?? DEFAULT_TOOL_OUTPUT_CHAR_BUDGET
  );
}

export function resolveToolDocumentCharBudget(): number {
  return (
    parsePositiveIntEnv(process.env.BEX_TOOL_DOCUMENT_CHAR_BUDGET) ??
    DEFAULT_TOOL_DOCUMENT_CHAR_BUDGET
  );
}

export type ToolOutputBudgetResult = {
  /** The (possibly capped) string to send to the model. */
  output: string;
  /** True when `output` differs from the input string. */
  applied: boolean;
  originalChars: number;
  /** Sources whose `documentBody` was tail-cut to the per-document budget. */
  truncatedDocuments: number;
  /** Whole trailing sources dropped to fit the per-output budget. */
  droppedSources: number;
};

function tailCut(serialized: string, maxChars: number): string {
  if (maxChars <= TOOL_OUTPUT_TRUNCATION_MARKER.length) {
    // The operator may deliberately set a very small emergency cap. Honour the hard cap even
    // when there is not enough room to carry the complete marker.
    return TOOL_OUTPUT_TRUNCATION_MARKER.slice(0, maxChars);
  }
  const keep = Math.max(0, maxChars - TOOL_OUTPUT_TRUNCATION_MARKER.length);
  return `${serialized.slice(0, keep)}${TOOL_OUTPUT_TRUNCATION_MARKER}`;
}

/**
 * Enforces both budgets on one serialized tool output, structurally when the payload is the
 * standard `{ sources: [...] }` shape and by raw tail cut otherwise:
 *
 * 1. per-document — each source's `documentBody` is tail-cut to the document budget, with
 *    `documentBodyTruncated: true` and `documentBodyChars` updated so the metadata stays honest;
 * 2. per-output — whole TRAILING sources are dropped (recorded as `sourcesDroppedForBudget`) until
 *    the serialized output fits;
 * 3. last resort (no sources array, or bulk outside `sources[]`) — the serialized string itself is
 *    tail-cut. The result may not parse as JSON, but the retained prefix is verbatim and the marker
 *    says outright that it was cut.
 */
export function enforceToolOutputBudget(serialized: string): ToolOutputBudgetResult {
  const outputBudget = resolveToolOutputCharBudget();
  const documentBudget = resolveToolDocumentCharBudget();
  const originalChars = serialized.length;

  const unchanged: ToolOutputBudgetResult = {
    output: serialized,
    applied: false,
    originalChars,
    truncatedDocuments: 0,
    droppedSources: 0,
  };

  // Fast path — nothing (total or any single body) can be over budget at this size.
  if (originalChars <= Math.min(outputBudget, documentBudget)) {
    return unchanged;
  }

  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON — raw tail cut below.
  }

  const sources = payload && Array.isArray(payload.sources) ? payload.sources : null;

  let truncatedDocuments = 0;
  let droppedSources = 0;
  let working = serialized;

  if (payload && sources) {
    const cappedSources = sources.map((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return source as unknown;
      }
      const record = source as Record<string, unknown>;
      const body = record.documentBody;
      if (typeof body !== 'string' || body.length <= documentBudget) {
        return source as unknown;
      }
      truncatedDocuments += 1;
      const cappedBody = tailCut(body, documentBudget);
      return {
        ...record,
        documentBody: cappedBody,
        documentBodyChars: cappedBody.length,
        documentBodyTruncated: true,
      };
    });

    let workingPayload: Record<string, unknown> = { ...payload, sources: cappedSources };
    working = truncatedDocuments > 0 ? JSON.stringify(workingPayload) : serialized;

    while (working.length > outputBudget && (workingPayload.sources as unknown[]).length > 0) {
      droppedSources += 1;
      workingPayload = {
        ...workingPayload,
        sources: (workingPayload.sources as unknown[]).slice(0, -1),
        sourcesDroppedForBudget: droppedSources,
      };
      working = JSON.stringify(workingPayload);
    }
  }

  if (working.length <= outputBudget) {
    return {
      output: working,
      applied: working !== serialized,
      originalChars,
      truncatedDocuments,
      droppedSources,
    };
  }

  return {
    output: tailCut(working, outputBudget),
    applied: true,
    originalChars,
    truncatedDocuments,
    droppedSources,
  };
}
