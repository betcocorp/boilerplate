import { turnSignalsSchema, type TurnSignals } from '~/lib/orchestrator/signals/signals-schemas';

/**
 * B0-790 — signal-accuracy harness: scores the B0-786 `TurnSignals` extraction against the
 * ground truth carried on `test_items` (three new typed `expected_*` columns plus the existing
 * `input_payload.product_mention`).
 *
 * Mirrors `~/lib/tests/tool-routing.ts`'s split: this module is the pure (unit-testable) reducer.
 * The I/O half — fetching the `orchestration_planner` `workflow_steps` rows by `workflow_run_id`
 * — lives in `~/lib/tests/repository.ts` (see `listOrchestrationPlannerStepOutputsByWorkflowRunIds`),
 * matching the existing `listAgentStepOutputsByWorkflowRunIds` split for the tool-routing report.
 *
 * The signals gate is frequently absent: `BEX_SIGNALS_ANALYSIS_ENABLED` defaults `false`
 * (`20260901120000_add_signals_analysis_settings_b0786.sql`), so most historical runs — and any run
 * with the flag off — never wrote a `signals_analysis` gate at all. "No gate present" is excluded
 * from every denominator below, never counted as a miss (same treatment `routing-comparison.ts`
 * gives an item with no semantic-route data).
 */

/** The subset of `TurnSignals` this harness scores. Accepts the full object structurally. */
export type ExtractedSignalsForScoring = Pick<
  TurnSignals,
  'betcoProduct' | 'resolvedProductLineKey' | 'surfaceType' | 'brandFamily' | 'setting'
>;

/**
 * Reads one `test_items.expected_surface_type` / `expected_brand_family` / `expected_setting`
 * column value (or the `input_payload.product_mention` string) into ground truth. Same shape as
 * `extractExpectedTool` in `tool-routing.ts`: trims, and blank/non-string collapses to `null`
 * ("unlabeled" — excluded from scoring, never a miss).
 */
export function extractExpectedGroundTruthString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Reads `test_items.input_payload.product_mention` — see `~/lib/tests/csv.ts` (`INPUT_PAYLOAD_CSV_COLUMNS`). */
export function extractProductMentionFromInputPayload(inputPayload: unknown): string | null {
  if (!inputPayload || typeof inputPayload !== 'object' || Array.isArray(inputPayload)) {
    return null;
  }
  return extractExpectedGroundTruthString(
    (inputPayload as Record<string, unknown>).product_mention,
  );
}

/**
 * Parses one `workflow_steps.output` value (the `orchestration_planner` step) into the
 * `signals_analysis` gate's `TurnSignals` payload. Tolerant of every shape actually on file —
 * absent entirely (flag off, or a run that predates B0-786), a `gates` array with no
 * `signals_analysis` entry, or a malformed `inputs.signals` — all return `null` rather than
 * throwing, mirroring `parseAgentStepToolTrace`'s defensive style.
 */
export function parseSignalsAnalysisGate(output: unknown): TurnSignals | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return null;
  }
  const gates = (output as Record<string, unknown>).gates;
  if (!Array.isArray(gates)) {
    return null;
  }
  const gateRecord = gates.find(
    (candidate): candidate is Record<string, unknown> =>
      Boolean(candidate) &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).gate === 'signals_analysis',
  );
  if (!gateRecord) {
    return null;
  }
  const inputs = gateRecord.inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return null;
  }
  const parsed = turnSignalsSchema.safeParse((inputs as Record<string, unknown>).signals);
  return parsed.success ? parsed.data : null;
}

export type SignalAccuracyMismatch = {
  testItemId: string;
  rowIndex: number;
  prompt: string;
  expected: string;
  /** `null` = the model extracted nothing for this field on this run (gate WAS present). */
  actual: string | null;
};

export type SignalAccuracyMetric = {
  /** Items where ground truth is non-null AND a signals gate was present — the only gradeable set. */
  scoredItemCount: number;
  matchedItemCount: number;
  /**
   * Of `scoredItemCount` items where the model extracted a non-null value, the fraction that
   * matched ground truth. `null` when the model never extracted a non-null value for any scored
   * item (nothing to compute precision over).
   */
  precision: number | null;
  /**
   * Of `scoredItemCount` (every item with ground truth present), the fraction correctly matched —
   * including items where the model extracted nothing at all. `null` when `scoredItemCount` is 0.
   */
  recall: number | null;
  mismatches: SignalAccuracyMismatch[];
};

export type SignalAccuracyReport = {
  signals: {
    productMention: SignalAccuracyMetric;
    surfaceType: SignalAccuracyMetric;
    brandFamily: SignalAccuracyMetric;
    setting: SignalAccuracyMetric;
  };
};

export type SignalAccuracyItemInput = {
  testItemId: string;
  rowIndex: number;
  prompt: string;
  expectedProductMention: string | null;
  expectedSurfaceType: string | null;
  expectedBrandFamily: string | null;
  expectedSetting: string | null;
  /**
   * From `parseSignalsAnalysisGate(...)`, keyed by this item's `workflow_run_id`; `null` = no
   * `signals_analysis` gate found for this item's run — excluded from every signal's denominator
   * below, distinct from "gate present but this particular field came back null" (a real miss).
   */
  signals: ExtractedSignalsForScoring | null;
};

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * `surfaceType` / `brandFamily` / `setting` ground truth and extraction are both short, normalized
 * tokens (an enum value or a single surface noun), so exact case-insensitive equality is the right
 * bar — unlike `product_mention` below, there's no "informal vs. full name" gap to bridge.
 */
function isExactCaseInsensitiveMatch(expected: string, actual: string): boolean {
  return normalizeForMatch(expected) === normalizeForMatch(actual);
}

/**
 * `product_mention` ground truth is what a real user typed (often informal/misspelled, e.g.
 * "pH7Q"), while `betcoProduct` may be a fuller model paraphrase (e.g. "pH7Q Neutral Disinfectant")
 * and `resolvedProductLineKey` is a normalized catalog key — so a case-insensitive substring match
 * in either direction counts, not just exact equality.
 */
function isProductMentionMatch(expected: string, actual: string): boolean {
  const normalizedExpected = normalizeForMatch(expected);
  const normalizedActual = normalizeForMatch(actual);
  if (!normalizedExpected || !normalizedActual) {
    return false;
  }
  return (
    normalizedExpected === normalizedActual ||
    normalizedExpected.includes(normalizedActual) ||
    normalizedActual.includes(normalizedExpected)
  );
}

function buildMetric(params: {
  items: readonly SignalAccuracyItemInput[];
  getExpected: (item: SignalAccuracyItemInput) => string | null;
  getActual: (signals: ExtractedSignalsForScoring) => string | null;
  isMatch: (expected: string, actual: string) => boolean;
}): SignalAccuracyMetric {
  const { items, getExpected, getActual, isMatch } = params;
  let scoredItemCount = 0;
  let matchedItemCount = 0;
  let extractedItemCount = 0;
  const mismatches: SignalAccuracyMismatch[] = [];

  for (const item of items) {
    const expected = getExpected(item);
    if (expected === null || item.signals === null) {
      continue; // no ground truth, or no signals_analysis gate for this run — not gradeable
    }

    scoredItemCount += 1;
    const actual = getActual(item.signals);
    if (actual !== null) {
      extractedItemCount += 1;
    }

    const matched = actual !== null && isMatch(expected, actual);
    if (matched) {
      matchedItemCount += 1;
    } else {
      mismatches.push({
        testItemId: item.testItemId,
        rowIndex: item.rowIndex,
        prompt: item.prompt,
        expected,
        actual,
      });
    }
  }

  return {
    scoredItemCount,
    matchedItemCount,
    precision: extractedItemCount > 0 ? matchedItemCount / extractedItemCount : null,
    recall: scoredItemCount > 0 ? matchedItemCount / scoredItemCount : null,
    mismatches: mismatches.sort((a, b) => a.rowIndex - b.rowIndex),
  };
}

/**
 * `product_mention` needs its own reducer (rather than `buildMetric`) because a match can come
 * from EITHER `betcoProduct` OR `resolvedProductLineKey` independently — see the dual-match note
 * on `SignalAccuracyItemInput.signals` / the module doc comment.
 */
function buildProductMentionMetric(
  items: readonly SignalAccuracyItemInput[],
): SignalAccuracyMetric {
  let scoredItemCount = 0;
  let matchedItemCount = 0;
  let extractedItemCount = 0;
  const mismatches: SignalAccuracyMismatch[] = [];

  for (const item of items) {
    const expected = item.expectedProductMention;
    if (expected === null || item.signals === null) {
      continue;
    }

    scoredItemCount += 1;
    const { betcoProduct, resolvedProductLineKey } = item.signals;
    const attempted = betcoProduct !== null || resolvedProductLineKey !== null;
    if (attempted) {
      extractedItemCount += 1;
    }

    const matched =
      (betcoProduct !== null && isProductMentionMatch(expected, betcoProduct)) ||
      (resolvedProductLineKey !== null &&
        isProductMentionMatch(expected, resolvedProductLineKey));

    if (matched) {
      matchedItemCount += 1;
    } else {
      mismatches.push({
        testItemId: item.testItemId,
        rowIndex: item.rowIndex,
        prompt: item.prompt,
        expected,
        // Prefer the raw model string over the resolved key for debugging visibility; both null
        // when the model extracted nothing at all for this turn.
        actual: betcoProduct ?? resolvedProductLineKey ?? null,
      });
    }
  }

  return {
    scoredItemCount,
    matchedItemCount,
    precision: extractedItemCount > 0 ? matchedItemCount / extractedItemCount : null,
    recall: scoredItemCount > 0 ? matchedItemCount / scoredItemCount : null,
    mismatches: mismatches.sort((a, b) => a.rowIndex - b.rowIndex),
  };
}

/**
 * Pure reducer: one run's worth of `{ ground truth, extracted signals }` per item → per-signal
 * precision/recall + mismatch lists (AC1/AC2 of B0-790). An item with no ground truth for a given
 * signal, or no `signals_analysis` gate at all, never contributes to that signal's counts.
 */
export function computeSignalAccuracyReport(
  items: readonly SignalAccuracyItemInput[],
): SignalAccuracyReport {
  return {
    signals: {
      productMention: buildProductMentionMetric(items),
      surfaceType: buildMetric({
        items,
        getExpected: (item) => item.expectedSurfaceType,
        getActual: (signals) => signals.surfaceType,
        isMatch: isExactCaseInsensitiveMatch,
      }),
      brandFamily: buildMetric({
        items,
        getExpected: (item) => item.expectedBrandFamily,
        getActual: (signals) => signals.brandFamily,
        isMatch: isExactCaseInsensitiveMatch,
      }),
      setting: buildMetric({
        items,
        getExpected: (item) => item.expectedSetting,
        getActual: (signals) => signals.setting,
        isMatch: isExactCaseInsensitiveMatch,
      }),
    },
  };
}
