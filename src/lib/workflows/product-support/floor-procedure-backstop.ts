import { FLOOR_VCT_PROCEDURE_QUERIES } from '~/lib/agents/floor-specialist/floor-vct-specialist-system-prompt';
import type { FactToolRequirementDecision } from '~/lib/workflows/product-support/fact-tool-enforcement';
import {
  FLOOR_REOPEN_TOOL_NAME,
  isFloorRouteId,
  requireFloorReopenTool,
} from '~/lib/workflows/product-support/floor-reopen-backstop';

/**
 * B0-1031 — generalises the B0-976 floor-reopen backstop into a TABLE of floor question types that
 * each have a documented knowledge-corpus answer and each require `get_floor_asset` before the
 * draft may stand.
 *
 * VCT Top 20 run `844f8eb3-5f88-461f-a90b-7b35c8eb6622`, four failing items:
 *   - `7e06f995` "Why didn't all the finish come off when I stripped the VCT floor?" (59)
 *   - `b5421bf0` "How long should VCT stripper dwell before I start scrubbing?" (35)
 *   - `21274bea` "the VCT finish is turning to white powder and flaking off" (22)
 * Their `workflow_steps.output.toolTrace` shows ONE `search_product_docs` call and nothing else —
 * `get_floor_asset` was never invoked — and all three answers opened by asking which product was
 * used instead of giving the documented benchmark the golden expected. The fourth (`349a0c8f`, 47)
 * DID call `get_floor_asset`, but with a freeform paraphrase that concatenated several topics into
 * one `procedure` string, which is what `FLOOR_VCT_PROCEDURE_QUERIES` and the prompt's
 * "send the procedure verbatim" rule address.
 *
 * Root cause, prompt side: `floorToolUseMandatoryClause` was COUNT-driven ("call at least one
 * retrieval tool"), so the single `search_product_docs` call satisfied it and the per-question-type
 * bullets that say "Call `get_floor_asset` FIRST" had no enforcement behind them. That clause is now
 * explicit (B0-1031), and this module is the deterministic half — the same remedy B0-788, B0-889,
 * B0-948 and B0-976 all landed on: prompt guidance plus a deterministic check, not a re-wording.
 *
 * Shape and wiring are deliberately identical to `floor-reopen-backstop.ts`: one
 * `FactToolRequirementDecision | null`, consumed through the same `requireFactTool` closure in
 * `run-product-support-workflow.ts`, so the B0-984 settings flag (`BEX_FACT_TOOL_ENFORCEMENT_ENABLED`)
 * gates it identically and the runtimes record it on the same `fact_tool_enforcement` gate. The
 * reopen case stays in its own module and is consulted FIRST here, unchanged — its matcher and its
 * "draft already states a walk-on figure" guard were tuned twice (B0-976, then B0-999) and are not
 * re-litigated by this ticket.
 *
 * Nothing here states a regulated value. Each entry names WHICH documented procedure to look up and
 * HOW to attribute it — never a dwell time, dry time, cadence or dilution.
 */

/** The tool every entry in the table requires; shared with the reopen module. */
export const FLOOR_PROCEDURE_TOOL_NAME = FLOOR_REOPEN_TOOL_NAME;

/** Floor-finish / VCT context words — keeps a bare "how long does it sit" from matching. */
const FLOOR_CONTEXT_PATTERN =
  /\b(?:floor|vct|tile|terrazzo|finish(?:es|ed|ing)?|coat(?:s|ed|ing)?|sealer|wax|strip(?:per|ped|ping)?|recoat(?:ed|ing)?|burnish(?:ed|ing)?|scrub(?:bed|bing)?)\b/i;

/**
 * The draft DEFERS: it asks the user to identify the product before answering. This is the exact
 * failure shape of all three no-tool items above ("What exact stripper name or item number did you
 * use?", "Which Betco VCT stripper are you using?", "the exact Betco finish must be identified
 * before…"), and it is deliberately the ONLY trigger condition for the entries below.
 *
 * Narrow on purpose (B0-984): a draft that already answers the question with documented content is
 * never re-drafted by this backstop, because forcing a re-draft over a good answer is precisely what
 * put `BEX_FACT_TOOL_ENFORCEMENT_ENABLED` behind a lever in the first place.
 */
const PRODUCT_IDENTITY_DEFERRAL_PATTERN =
  /\b(?:product|stripper|finish|sealer|cleaner|chemical)\s+names?\b|\bitem\s+numbers?\b|\bmust\s+be\s+identified\b|\bwhich\s+(?:betco|exact)\b|\bwhat\s+(?:exact|specific)\s+(?:betco\s+)?(?:product|stripper|finish|sealer|cleaner)\b/i;

/** True when the draft defers behind a request for the product's identity instead of answering. */
export function draftDefersForProductIdentity(draftAnswer: string): boolean {
  if (!draftAnswer.includes('?')) return false;
  return PRODUCT_IDENTITY_DEFERRAL_PATTERN.test(draftAnswer);
}

/**
 * One floor question type: which routes it covers, how its question is recognised, the canonical
 * `procedure` string the model must send, and the additive re-draft instruction.
 */
export type FloorProcedureEntry = {
  /** Recorded on the `fact_tool_enforcement` gate; never sent to the model. */
  category: string;
  /** `effectivePromptId`s this entry applies to. */
  routes: readonly string[];
  /** Matched against the user's message; any one is enough. */
  patterns: readonly RegExp[];
  /** Verbatim from `FLOOR_VCT_PROCEDURE_QUERIES`, so prompt and backstop cannot drift. */
  procedureQuery: string;
  /** What the model must add; additive to its own draft, per B0-984. */
  instruction: string;
};

/**
 * The additive instruction, one wording for every entry so the table stays a table. It names the
 * tool, the exact `procedure` string, and the transcription + attribution rules — and, per the
 * regulated-data rule, no figure of any kind.
 */
export function buildFloorProcedureInstruction(input: {
  procedureQuery: string;
  subject: string;
}): string {
  return (
    `Before this answer can stand, call \`${FLOOR_PROCEDURE_TOOL_NAME}\` with procedure ` +
    `"${input.procedureQuery}" — send that phrase verbatim, on its own, with no extra topics or ` +
    'keywords appended (and the floor surface the user named, if any). Then lead your answer with ' +
    `the documented ${input.subject} from the floor-care knowledge document it returns, ` +
    'transcribing every figure exactly as that document prints it — never rounded, converted or ' +
    'averaged — and attributing it to that document. Do not open by asking which product was used ' +
    'and do not replace the documented guidance with a clarifying question: this question is ' +
    'answerable from the knowledge document alone. Keep the useful content of your draft and offer ' +
    '— do not require — a label-specific check once the documented guidance has been given. If the ' +
    'tool returns nothing relevant, keep your draft and add one closing sentence that the ' +
    'documented procedure is not on file — never estimate a value.'
  );
}

/**
 * B0-1031 — the table, evaluated in order. Scoped to `floor_vct` on purpose: these are the VCT
 * prompt's own recurring question types and the VCT corpus documents that answer them. The sibling
 * substrate prompts (`floor_wood_sport`, `floor_concrete`, `floor_stg`) have the same COUNT-driven
 * gap and are reported as follow-up tickets rather than silently enrolled here.
 */
export const FLOOR_PROCEDURE_ENTRIES: readonly FloorProcedureEntry[] = [
  {
    category: 'floor_stripper_dwell',
    routes: ['floor_vct'],
    patterns: [
      /\b(?:dwell|sit|soak|stand|wait)\b[^.?!]{0,60}\bbefore\b[^.?!]{0,40}\b(?:scrub|agitat\w*|machine|pad|pick\s*up)\b/i,
      /\bdwell\s*time\b/i,
      /\bhow\s+long\b[^.?!]{0,60}\b(?:stripper|stripping\s+solution)\b[^.?!]{0,40}\b(?:dwell|sit|soak|stand|stay)\b/i,
      /\b(?:stripper|stripping\s+solution)\b[^.?!]{0,40}\b(?:dwell|sit|soak)\b/i,
    ],
    procedureQuery: FLOOR_VCT_PROCEDURE_QUERIES.stripperDwell,
    instruction: buildFloorProcedureInstruction({
      procedureQuery: FLOOR_VCT_PROCEDURE_QUERIES.stripperDwell,
      subject:
        'dwell window and the rule that document states about keeping the stripper wet for the whole dwell',
    }),
  },
  {
    category: 'floor_stripping_failure',
    routes: ['floor_vct'],
    patterns: [
      /\b(?:didn'?t|did\s+not|won'?t|wouldn'?t|not)\b[^.?!]{0,60}\b(?:come|coming)\s+off\b/i,
      /\b(?:finish|wax|coating)\b[^.?!]{0,60}\b(?:left\s+behind|still\s+(?:there|on)|remain(?:s|ing|ed)?)\b[^.?!]{0,60}\b(?:strip\w*)\b/i,
      /\bstrip\w*\b[^.?!]{0,60}\b(?:didn'?t|did\s+not|failed|not)\s+(?:work|remove|come)\b/i,
      /\b(?:patchy|streaky|uneven|spotty)\b[^.?!]{0,60}\bafter\b[^.?!]{0,30}\bstrip\w*/i,
      /\bwhy\b[^.?!]{0,80}\bstrip(?:ped|ping)\b[^.?!]{0,60}\b(?:finish|floor|wax)\b/i,
    ],
    procedureQuery: FLOOR_VCT_PROCEDURE_QUERIES.strippingFailure,
    instruction: buildFloorProcedureInstruction({
      procedureQuery: FLOOR_VCT_PROCEDURE_QUERIES.strippingFailure,
      subject: 'process causes of incomplete stripping and the correction that document prescribes',
    }),
  },
  {
    category: 'floor_finish_appearance_problem',
    routes: ['floor_vct'],
    patterns: [
      /\b(?:powder(?:y|ing|s|ed)?|chalk(?:y|ing)?|flak(?:e|es|ing|y)|peel(?:s|ing)?|delaminat\w*)\b/i,
      /\b(?:hazy|haze|yellow(?:ing|ed)?|streak(?:s|ing|y)?|cloudy|dull(?:ing)?|scuff(?:s|ing|ed)?\s+badly)\b[^.?!]{0,60}\b(?:finish|floor|coat\w*)\b/i,
      /\b(?:finish|coating)\b[^.?!]{0,60}\b(?:not\s+adhering|won'?t\s+(?:stick|bond|adhere)|lifting|coming\s+up)\b/i,
    ],
    procedureQuery: FLOOR_VCT_PROCEDURE_QUERIES.finishAppearanceProblem,
    instruction: buildFloorProcedureInstruction({
      procedureQuery: FLOOR_VCT_PROCEDURE_QUERIES.finishAppearanceProblem,
      subject:
        'failure mode, the drivers that document ranks under it, and the correction it prescribes',
    }),
  },
  {
    category: 'floor_maintenance_frequency',
    routes: ['floor_vct'],
    patterns: [
      /\bhow\s+often\b[^.?!]{0,80}\b(?:top[\s-]?scrub|scrub|strip|recoat|refinish|burnish)\w*/i,
      /\b(?:top[\s-]?scrub|strip(?:ping)?|recoat(?:ing)?|refinish(?:ing)?)\b[^.?!]{0,40}\b(?:frequency|interval|cadence|schedule)\b/i,
      /\bwhen\s+do\s+we\s+need\b[^.?!]{0,60}\b(?:full\s+strip|strip|recoat)\b/i,
    ],
    procedureQuery: FLOOR_VCT_PROCEDURE_QUERIES.maintenanceFrequency,
    instruction: buildFloorProcedureInstruction({
      procedureQuery: FLOOR_VCT_PROCEDURE_QUERIES.maintenanceFrequency,
      subject: 'Betco maintenance cadence',
    }),
  },
  {
    category: 'floor_dry_between_coats',
    routes: ['floor_vct'],
    patterns: [
      /\b(?:dry|drying|wait|cure)\b[^.?!]{0,50}\bbetween\s+coats?\b/i,
      /\bbetween\s+coats?\b[^.?!]{0,50}\b(?:dry|drying|wait)\b/i,
      /\bhow\s+long\b[^.?!]{0,60}\bbefore\b[^.?!]{0,40}\b(?:the\s+)?next\s+coat\b/i,
    ],
    procedureQuery: FLOOR_VCT_PROCEDURE_QUERIES.dryBetweenCoats,
    instruction: buildFloorProcedureInstruction({
      procedureQuery: FLOOR_VCT_PROCEDURE_QUERIES.dryBetweenCoats,
      subject:
        'recoat window, including the document\'s own reason for the extra wait after the surface is dry to the touch',
    }),
  },
];

/** The first table entry whose route and question shape match the turn, or null. */
export function matchFloorProcedureEntry(input: {
  userMessage: string;
  effectivePromptId: string | null | undefined;
}): FloorProcedureEntry | null {
  const message = input.userMessage.trim();
  if (!message) return null;
  if (!isFloorRouteId(input.effectivePromptId)) return null;
  if (!FLOOR_CONTEXT_PATTERN.test(message)) return null;
  const route = input.effectivePromptId ?? '';
  return (
    FLOOR_PROCEDURE_ENTRIES.find(
      (entry) =>
        entry.routes.includes(route) && entry.patterns.some((pattern) => pattern.test(message)),
    ) ?? null
  );
}

/**
 * Names `get_floor_asset` as the required call for a floor question type that has a documented
 * knowledge-corpus answer; null otherwise. Same return contract as `requireFactToolForDraft`.
 *
 * The B0-976 reopen check runs FIRST and unchanged; the table below is consulted only when it
 * declines. Both share the "`get_floor_asset` was already called this turn ⇒ satisfied" rule, so at
 * most one extra call is ever demanded per turn.
 */
export function requireFloorProcedureTool(input: {
  userMessage: string;
  effectivePromptId: string | null | undefined;
  draftAnswer: string;
  toolNames: readonly string[];
}): FactToolRequirementDecision | null {
  const reopen = requireFloorReopenTool(input);
  if (reopen) return reopen;

  if (input.toolNames.includes(FLOOR_PROCEDURE_TOOL_NAME)) return null;
  const draft = input.draftAnswer.trim();
  if (!draft) return null;
  if (!draftDefersForProductIdentity(draft)) return null;

  const entry = matchFloorProcedureEntry(input);
  if (!entry) return null;

  return {
    toolName: FLOOR_PROCEDURE_TOOL_NAME,
    category: entry.category,
    instruction: entry.instruction,
  };
}
