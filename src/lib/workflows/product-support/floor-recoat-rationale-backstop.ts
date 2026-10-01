import { isFloorRouteId } from '~/lib/workflows/product-support/floor-reopen-backstop';

/**
 * B0-1033 — deterministic backstop for the "finish dries top-down" RATIONALE on VCT
 * dry-between-coats / recoat-timing answers.
 *
 * VCT Top 20 run `844f8eb3-5f88-461f-a90b-7b35c8eb6622` row 6 (`workflow_run_id`
 * `e324a252-bff3-4091-9a16-012be23b75f9`, "How long should VCT finish dry between coats?", scored
 * 59): the answer gave the documented timing correctly and cited the right document, and dropped
 * the WHY the golden lists as a MANDATORY concept ("finish dries top-down so moisture is trapped
 * underneath").
 *
 * Three things were checked before writing this, and all three rule out the B0-884
 * "validator/revision pass stripped a grounded draft" pattern:
 *   - `final_output.answerProvenance` is `model_generated` — a real prompt ran; no canned decline,
 *     no template override.
 *   - `final_output.draftAnswer` and `final_output.answerText` are BYTE-IDENTICAL — nothing
 *     downstream of generation touched the text.
 *   - `activeGates.regulatedClaimGuardrail` is `{ state: 'ran', verdict: 'passed' }` and the
 *     validator was `skipped` — no redaction, no fallback.
 * And the rationale IS in the retrieved source (`rag.document` `1d904b83-6f7d-49ea-a568-1e5992f048bd`,
 * "02 VCT Finish Application Coats Drying Curing", which the answer itself cited). So the model was
 * handed the rationale and omitted it: a generation-compliance gap, not a data or pipeline gap.
 *
 * The VCT prompt has mandated this rationale since B0-746 ("Do not drop this rationale even when the
 * user only asked for the timing figures") and it was dropped anyway. This is the shape B0-1002
 * described for the disinfectant dwell rule: the missing content is not a per-product fact that a
 * tool owns, it is a fixed procedural RATIONALE, so forcing an extra tool call and a model re-draft
 * is the wrong remedy (nothing to look up, and the model can re-draft and omit it again). This is a
 * text-level check-and-patch instead — additive, no model round-trip, so it cannot be skipped.
 *
 * Regulated-data rule: the appended sentence states no dry time, no cure time, no dilution and no
 * contact time — only the top-down drying mechanism, which carries no figure. The numbers in the
 * answer stay exactly as the model transcribed them from the document.
 *
 * Related but deliberately separate from `floor-procedure-backstop.ts` (B0-1031): that module forces
 * a RETRIEVAL call before a deferring draft may stand and is gated by
 * `BEX_FACT_TOOL_ENFORCEMENT_ENABLED`; this one patches a finished, correct answer and is not.
 */

/** The user asked how long finish dries between coats / before the next coat. */
const RECOAT_TIMING_QUESTION_PATTERNS: readonly RegExp[] = [
  /\b(?:dry|drying|dries|wait|cure)\b[^.?!]{0,50}\bbetween\s+coats?\b/i,
  /\bbetween\s+coats?\b[^.?!]{0,50}\b(?:dry|drying|dries|wait)\b/i,
  /\bhow\s+long\b[^.?!]{0,60}\bbefore\b[^.?!]{0,40}\b(?:the\s+)?(?:next|second|another)\s+coat\b/i,
  /\brecoat\s+(?:window|time|interval)\b/i,
];

/** Floor-finish context, so "let the paint dry between coats" on another route cannot match. */
const FLOOR_FINISH_CONTEXT_PATTERN =
  /\b(?:vct|floor|tile|terrazzo|finish(?:es|ing)?|sealer|wax|coat(?:s|ing)?)\b/i;

export function isRecoatTimingQuestion(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;
  if (!FLOOR_FINISH_CONTEXT_PATTERN.test(text)) return false;
  return RECOAT_TIMING_QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The draft actually ANSWERED the recoat-timing question: it talks about coats and states at least
 * one duration. The rationale is only appended to an answer that has the timing it explains —
 * never bolted onto a decline, a clarifying question, or an unrelated floor answer.
 */
const RECOAT_ANSWER_CONTEXT_PATTERN =
  /\b(?:between\s+coats?|next\s+coat|recoat\w*|dry\s+to\s+the\s+touch)\b/i;
const ANY_DURATION_PATTERN =
  /\b\d+(?:\.\d+)?\s*(?:[-–—]|to)?\s*\d*(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?)\b|\bovernight\b/i;

export function draftAnswersRecoatTiming(draftAnswer: string): boolean {
  return RECOAT_ANSWER_CONTEXT_PATTERN.test(draftAnswer) && ANY_DURATION_PATTERN.test(draftAnswer);
}

/**
 * The rationale itself, in any wording the model might already have used. Matched loosely so a
 * draft that DID include it — in its own words — is never double-patched.
 */
const TOP_DOWN_RATIONALE_PATTERN =
  /\b(?:top[\s-]down|from\s+the\s+top\s+down|surface\s+in(?:ward)?)\b|\b(?:moisture|solvent|water)\b[\s\S]{0,60}\b(?:trapped|underneath|below\s+the\s+surface|beneath)\b|\b(?:trapped|traps)\b[\s\S]{0,40}\b(?:moisture|solvent|water)\b/i;

export function draftStatesTopDownRationale(draftAnswer: string): boolean {
  return TOP_DOWN_RATIONALE_PATTERN.test(draftAnswer);
}

/**
 * The canonical rationale sentence, kept as a single exported constant so the prompt bullet
 * (`FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT`, "How long should finish dry between coats?") and this
 * backstop can be diffed and never drift apart — the same reason `DILUTION_DWELL_BACKSTOP_SENTENCE`
 * exists in `dilution-dwell-backstop.ts`.
 *
 * It paraphrases nothing numeric: every figure in the answer came from, and stays attributed to,
 * the retrieved document.
 */
export const FLOOR_RECOAT_RATIONALE_SENTENCE =
  'Why the extra wait matters: floor finish dries from the top down, so the surface can feel dry to the touch while moisture is still trapped underneath. The additional wait lets that trapped moisture escape and prevents defects in the next coat.';

/**
 * The VCT prompt's answer shape ends with a `Source:` line, so the rationale is spliced in ABOVE
 * that block rather than tacked on after it — appending below the citation would leave the answer
 * ending on an uncited-looking sentence. Pure string splice: every other character, including the
 * model's own paragraph spacing, is left exactly as written.
 */
const TRAILING_SOURCE_BLOCK_PATTERN = /\n\n[ \t]*\**\s*Sources?\b/gi;

function insertAboveSourceLine(answer: string, sentence: string): string {
  const trimmed = answer.replace(/\s+$/, '');
  let lastSourceBlockIndex = -1;
  for (const match of trimmed.matchAll(TRAILING_SOURCE_BLOCK_PATTERN)) {
    lastSourceBlockIndex = match.index ?? -1;
  }
  if (lastSourceBlockIndex < 0) return `${trimmed}\n\n${sentence}`;
  return `${trimmed.slice(0, lastSourceBlockIndex)}\n\n${sentence}${trimmed.slice(lastSourceBlockIndex)}`;
}

export type FloorRecoatRationaleResult = {
  answer: string;
  /** True when the sentence was appended; false when the draft already covered it or did not qualify. */
  applied: boolean;
};

/**
 * Appends the top-down rationale to a floor-route recoat-timing answer that states the timing but
 * omits the WHY. Additive only: never removes or rewrites existing content, never reorders it, and
 * never touches a draft that already carries the rationale in any wording.
 */
export function applyFloorRecoatRationaleBackstop(input: {
  userMessage: string;
  effectivePromptId: string | null | undefined;
  draftAnswer: string;
}): FloorRecoatRationaleResult {
  const draft = input.draftAnswer.trim();
  if (!draft) return { answer: input.draftAnswer, applied: false };
  if (!isFloorRouteId(input.effectivePromptId)) return { answer: input.draftAnswer, applied: false };
  if (!isRecoatTimingQuestion(input.userMessage)) {
    return { answer: input.draftAnswer, applied: false };
  }
  if (!draftAnswersRecoatTiming(draft)) return { answer: input.draftAnswer, applied: false };
  if (draftStatesTopDownRationale(draft)) return { answer: input.draftAnswer, applied: false };

  return {
    answer: insertAboveSourceLine(input.draftAnswer, FLOOR_RECOAT_RATIONALE_SENTENCE),
    applied: true,
  };
}
