/**
 * B0-418 — one reader for everything the single-run trace page shows out of a
 * `workflow_runs` row's own `final_output` / `user_input`.
 *
 * `final_output` is untyped `Json` and coverage is partial by row: `usage` and
 * `retrieved_document_chunks` were added later, a handful of failed runs carry an
 * `error` string instead of an answer, and an in-flight run has no `final_output`
 * at all. So every field is read defensively and reported as *absent* rather than
 * as zero — the UI must be able to say "n/a" instead of implying a real 0.
 *
 * Parsing is delegated, never re-implemented. `workflow_runs.final_output` is the
 * same shape as `test_result_items.response_payload`, so the `sources[].similarity`,
 * `timingBreakdown` and retrieved-chunk readers are the very extractors the
 * `/admin/tests` pages use (`~/lib/tests/response-payload`); `validation` and
 * `usage` are parsed with the workflow's own Zod schemas.
 */

import {
  extractActiveGates,
  extractModelTag,
  extractRetrievedDocumentChunks,
  extractSimilarityStats,
  extractTimingBreakdown,
} from '~/lib/tests/response-payload';
import { productSupportFinalOutputSchema } from '~/lib/workflows/product-support/product-support-schemas';

import type {
  ActiveGates,
  ProductSupportFinalOutput,
  RetrievedDocumentChunkRef,
  ValidatorMode,
  ValidatorResult,
} from '~/lib/workflows/product-support/product-support-schemas';

/** LLM token usage as recorded on `final_output.usage` (B0-117 / B0-324). */
export type RunTokenUsage = NonNullable<ProductSupportFinalOutput['usage']>;

/** `final_output.timingBreakdown`, as narrowed by `extractTimingBreakdown`. */
export type RunTimingBreakdown = NonNullable<
  ReturnType<typeof extractTimingBreakdown>
>;

export type RunPayloadView = {
  /** `final_output.answerText` — the answer the user actually saw. */
  answerText: string | null;
  /** `final_output.error` — set instead of an answer when the run threw. */
  error: string | null;
  validation: ValidatorResult | null;
  usage: RunTokenUsage | null;
  timing: RunTimingBreakdown | null;
  similarity: { min: number; max: number; avg: number } | null;
  chunks: RetrievedDocumentChunkRef[];
  /** `user_input.modelTag` — which model tag the run was executed against. */
  modelTag: string | null;
  /**
   * B0-358 — the verification level this run's validator step actually reached. Null on runs
   * written before that ticket: absent means UNKNOWN, and must never be rendered as `'llm'`.
   */
  validatorMode: ValidatorMode | null;
  /**
   * B0-494/B0-358 — which deterministic guardrails ran, were skipped/bypassed, or never applied,
   * plus (post-B0-358) the verdict of the ones that ran. Null on runs written before B0-494.
   */
  activeGates: ActiveGates | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Reads a run's own payload into the shape the trace page renders. Never throws:
 * a null/absent/malformed `final_output` yields a view whose every field is
 * empty, which the UI renders as explicit "n/a" states.
 */
export function readRunPayloadView(
  finalOutput: unknown,
  userInput: unknown,
): RunPayloadView {
  const record = asRecord(finalOutput);
  const validation = productSupportFinalOutputSchema.shape.validation.safeParse(
    record?.validation,
  );
  const usage = productSupportFinalOutputSchema.shape.usage.safeParse(
    record?.usage,
  );
  const modelTag = extractModelTag(userInput)?.trim();
  // B0-358 — parsed with the workflow's own schema, so an unknown/legacy value reads as absent
  // rather than being coerced into a verification level the run never had.
  const validatorMode = productSupportFinalOutputSchema.shape.validatorMode.safeParse(
    record?.validatorMode,
  );

  return {
    answerText: readNonEmptyString(record, 'answerText'),
    error: readNonEmptyString(record, 'error'),
    validation: validation.success ? validation.data : null,
    usage: usage.success ? (usage.data ?? null) : null,
    timing: extractTimingBreakdown(finalOutput),
    similarity: extractSimilarityStats(finalOutput),
    chunks: extractRetrievedDocumentChunks(finalOutput),
    modelTag: modelTag ? modelTag : null,
    validatorMode: validatorMode.success ? (validatorMode.data ?? null) : null,
    activeGates: extractActiveGates(finalOutput),
  };
}
