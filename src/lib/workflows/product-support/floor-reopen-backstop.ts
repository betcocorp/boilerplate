import type { FactToolRequirementDecision } from '~/lib/workflows/product-support/fact-tool-enforcement';

/**
 * B0-976 — deterministic backstop for floor reopening / walk-on / cure-time questions.
 *
 * VCT golden `339b3004` ("how soon can people walk on the VCT floor after the last coat?") scored
 * 36 and 22: the classifier's `suggestedTool` was `get_floor_asset`, the prompt says to call it for
 * dry and cure times, and the model still answered from a between-coats chunk or asked for the
 * finish name instead. Same finding as B0-948/B0-788: "call the right tool" as prompt guidance is
 * skipped often enough that a deterministic check plus a `tool_choice` pin is the remedy.
 *
 * This module is the floor-route sibling of `requireFactToolForDraft`: given the user's message,
 * the routed specialist, the finished draft and the tools called this turn, it names
 * `get_floor_asset` when (a) the route is a floor specialist, (b) the message asks about reopening
 * to traffic, (c) `get_floor_asset` was never called, and (d) the draft states no timing figure at
 * all. It is wired through the same `requireFactTool` closure the B0-948 enforcement uses, so the
 * B0-984 settings flag (`BEX_FACT_TOOL_ENFORCEMENT_ENABLED`) gates it identically and the runtimes
 * record it on the same `fact_tool_enforcement` gate.
 *
 * It lives in its own module on purpose: `fact-tool-enforcement.ts` is category-driven (what the
 * DRAFT asserts) and this is question-driven (what the USER asked), and the two are edited by
 * different tickets. Nothing here reads or restates a regulated value — the instruction tells the
 * model where the schedule lives and how to attribute it, never what the figures are.
 */

export const FLOOR_REOPEN_TOOL_NAME = 'get_floor_asset';
export const FLOOR_REOPEN_PROCEDURE_QUERY = 'reopening to traffic after final coat';
export const FLOOR_REOPEN_CATEGORY = 'floor_reopen_timing';

/** Reopening / return-to-service phrasings, matched against the user's message. */
const REOPEN_PATTERNS: readonly RegExp[] = [
  /\bre-?open(?:ing|ed)?\b/i,
  /\bwalk(?:ing|ed)?[\s-]*on\b/i,
  /\bwalk[\s-]*on\s+time\b/i,
  /\b(?:foot|rolling|cart|wheel(?:ed|chair)?|forklift|pallet[\s-]*jack)\s+traffic\b/i,
  /\bback\s+(?:in(?:to)?\s+service|to\s+(?:normal\s+)?(?:use|traffic|service))\b/i,
  /\b(?:put|move|roll|bring)\s+(?:the\s+)?(?:carts?|furniture|desks?|equipment|beds?|shelving|racks?)\s+back\b/i,
  /\breturn(?:ing)?\s+(?:to\s+)?(?:traffic|service|use)\b/i,
  /\bhow\s+(?:soon|long)\b[^.?!]{0,60}\b(?:after|before)\b[^.?!]{0,40}\b(?:coat|finish|traffic|walk|use)\b/i,
  /\b(?:cure|curing|cured)\s+(?:time|period)?\b[^.?!]{0,40}\b(?:traffic|walk|reopen|open|use)\b/i,
];

/** Floor-finish context words — keeps "reopen the store after the flood" from matching. */
const FLOOR_CONTEXT_PATTERN =
  /\b(?:floor|vct|tile|terrazzo|finish(?:es|ed|ing)?|coat(?:s|ed|ing)?|sealer|wax|strip(?:ped|ping)?|recoat(?:ed|ing)?|burnish(?:ed|ing)?)\b/i;

/**
 * Any duration expressed as a number (or a number range) followed by a time unit, plus the
 * unit-less phrasings a schedule might use. The check is "does the draft give ANY timing figure",
 * never "is the figure right" — correctness is the retrieved document's job.
 */
const TIMING_FIGURE_PATTERN =
  /\b\d+(?:\.\d+)?\s*(?:[-–—]|to)?\s*\d*(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?|days?|h)\b|\bovernight\b|\b(?:a|one|two|three|four|five|six|twelve|twenty-four|24|48|72)[\s-]+(?:hours?|days?)\b|\bnext\s+(?:day|morning)\b/i;

export function isFloorRouteId(effectivePromptId: string | null | undefined): boolean {
  return typeof effectivePromptId === 'string' && effectivePromptId.startsWith('floor');
}

/** True when the message asks when a coated floor can take traffic again. */
export function isFloorReopenQuestion(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;
  if (!FLOOR_CONTEXT_PATTERN.test(text)) return false;
  return REOPEN_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when the draft already states at least one dry / cure / reopen timing figure. */
export function draftStatesTimingFigure(draftAnswer: string): boolean {
  return TIMING_FIGURE_PATTERN.test(draftAnswer);
}

/** The B0-984-style additive instruction: keep the draft, add the schedule, never lead with a gap. */
export function buildFloorReopenInstruction(): string {
  return (
    `Before this answer can stand, call \`${FLOOR_REOPEN_TOOL_NAME}\` with procedure ` +
    `"${FLOOR_REOPEN_PROCEDURE_QUERY}" (and the floor surface the user named, if any). Then ` +
    'answer the reopening question directly from the floor-care knowledge document it returns: ' +
    'give every reopening tier that document prints (dry to the touch, light foot traffic, normal ' +
    'foot traffic, heavy or rolling loads) with each figure transcribed exactly as written and the ' +
    "conditions it says extend them, attributed to that document, and quote the document's own " +
    'caveat that the specific finish label governs if it states a different cure or burnish time. ' +
    'Offer — do not require — a label-specific check if the user names the finish. Do not ask a ' +
    'clarifying question in place of the schedule. If the tool returns nothing relevant to ' +
    'reopening, keep your draft and add one closing sentence that the documented reopening ' +
    'procedure is not on file — never estimate a time.'
  );
}

/**
 * Names `get_floor_asset` as the required call for a floor-route reopening question whose draft
 * gives no timing figure; null otherwise. Same return contract as `requireFactToolForDraft`.
 */
export function requireFloorReopenTool(input: {
  userMessage: string;
  effectivePromptId: string | null | undefined;
  draftAnswer: string;
  toolNames: readonly string[];
}): FactToolRequirementDecision | null {
  if (!isFloorRouteId(input.effectivePromptId)) return null;
  if (!isFloorReopenQuestion(input.userMessage)) return null;
  if (input.toolNames.includes(FLOOR_REOPEN_TOOL_NAME)) return null;
  const draft = input.draftAnswer.trim();
  if (!draft) return null;
  if (draftStatesTimingFigure(draft)) return null;
  return {
    toolName: FLOOR_REOPEN_TOOL_NAME,
    category: FLOOR_REOPEN_CATEGORY,
    instruction: buildFloorReopenInstruction(),
  };
}
