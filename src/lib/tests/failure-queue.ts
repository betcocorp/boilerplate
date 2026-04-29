type FailureRowHints = {
  status: string | null;
  elapsed_ms: number | null;
  error_message: string | null;
  response_text: string | null;
  response_payload: unknown;
};

/**
 * Heuristic classifier that returns a human-readable resolution suggestion
 * for a failed test result item. Inspects error message, response text, and
 * status to bucket the failure into the most actionable category.
 */
export function suggestResolution(row: FailureRowHints): string {
  const error = (row.error_message || '').toLowerCase();
  const responseText = (row.response_text || '').toLowerCase();
  const status = (row.status || '').toLowerCase();

  const looksLikeRefusal =
    responseText.includes("i can't") ||
    responseText.includes('i cannot') ||
    responseText.includes('unable to') ||
    responseText.includes("can't verify") ||
    responseText.includes('cannot verify') ||
    responseText.includes("don't have access") ||
    responseText.includes("i don't have access") ||
    responseText.includes("i don't know") ||
    responseText.includes('i can\u2019t') ||
    responseText.includes('cannot provide') ||
    responseText.includes("can't provide") ||
    responseText.includes('i am not able to') ||
    responseText.includes('as an ai') ||
    responseText.includes('i\u2019m unable to') ||
    responseText.includes("i'm unable to");

  const looksLikeTimeout =
    status.includes('timeout') ||
    error.includes('timeout') ||
    error.includes('timed out') ||
    error.includes('deadline') ||
    error.includes('cancelled') ||
    error.includes('canceled') ||
    error.includes('rate limit') ||
    error.includes('429');

  const looksLikeEvaluationMismatch =
    error.includes('assert') ||
    error.includes('expected') ||
    error.includes('mismatch') ||
    error.includes('validation') ||
    error.includes('zod') ||
    error.includes('schema');

  const looksLikeGroundingGap =
    responseText.includes("i couldn't find") ||
    responseText.includes("i can't find") ||
    responseText.includes('no relevant') ||
    responseText.includes('no sources') ||
    responseText.includes('not in the provided') ||
    responseText.includes('not provided') ||
    responseText.includes('no information') ||
    responseText.includes('insufficient information');

  if (looksLikeTimeout) {
    return 'Timeout / infra: retry run; check model latency + rate limits; consider lowering context or splitting prompt.';
  }

  if (looksLikeRefusal) {
    return 'Refusal: tighten instructions + grounding; ensure allowed safe-completion; add required fields/checklist for hazard specifics.';
  }

  if (looksLikeGroundingGap) {
    return 'Grounding gap: verify SDS/docs exist; adjust retrieval/source selection; expand query terms; ensure citations/sources are returned.';
  }

  if (looksLikeEvaluationMismatch) {
    return 'Eval/expectation mismatch: inspect expected fields vs actual; update test expectations or adjust evaluator rules.';
  }

  if (row.response_payload) {
    return 'Inspect payload: check tool output / retrieved sources; confirm response schema + required fields.';
  }

  return 'Open Item history + Run to inspect; determine if prompt, retrieval, or evaluator needs adjustment.';
}
