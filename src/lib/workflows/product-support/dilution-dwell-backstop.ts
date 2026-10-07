/**
 * B0-1002 — deterministic backstop for the "stay visibly wet the full labeled time" disinfectant
 * dwell rule on DILUTION-SYSTEM how-to / employee-use answers.
 *
 * Dilution golden `ce445e69` ("how do employees use the dilution system to prepare disinfectant")
 * scored 59: it is missing the mandatory visibly-wet-for-the-full-labeled-time guidance. The prompt
 * text for this already exists — the B0-978 block in `product-support-prompts.ts`
 * (`PRODUCT_SUPPORT_SHARED_INSTRUCTIONS`, "Disinfectant recommendations — the conditions that make
 * the claim valid") is a SHARED block that fires on "WHENEVER the answer mentions disinfectant dwell
 * or contact time, or describes using a disinfectant at all (a restroom procedure, a
 * dilution-control or employee-training answer …)" — deliberately broadened past its original
 * "recommend a disinfectant for a named pathogen" trigger for exactly this shape of question. It was
 * still omitted, and per the ticket this is a REPEAT (the same gap surfaced twice). B0-788/B0-889/
 * B0-976 all record the same finding for other rules: "call the right tool" / "state the right fact"
 * as prompt-only guidance is skipped often enough that a deterministic check is the more reliable
 * fix than a third re-wording of the same instruction.
 *
 * Unlike `floor-reopen-backstop.ts` and `fact-tool-enforcement.ts`, the missing content here is not
 * a fact that must be RETRIEVED (no tool "owns" it — it is a fixed, always-true procedural rule, not
 * a per-product label value), so forcing an extra tool call and a model re-draft is not the right
 * shape of fix: there is nothing for a tool to look up, and the model can re-draft and still omit
 * the same sentence. Instead this module is a text-level check-and-patch: `applyDilutionDwellBackstop`
 * detects a dilution-system/employee-use draft that discusses disinfectant dwell/contact time
 * without stating the visibly-wet-for-the-full-time rule, and appends the exact canonical sentence
 * from the B0-978 prompt block verbatim — no model round-trip, so it cannot be skipped by the model
 * a third time. It states no regulated value (no dilution ratio, no contact-time figure) — only the
 * fixed procedural rule already mandated by the prompt.
 *
 * NOT YET WIRED — see this ticket's report. Wiring requires calling `applyDilutionDwellBackstop` on
 * the finished draft in `run-product-support-workflow.ts` (recommended: alongside the other
 * post-generation passes, near where `strippedAssistantText` is assembled), which is owned by
 * another agent in this batch.
 */

/** Dilution-system / dispenser / employee-use "how-to" phrasings — the trigger shape for this ticket. */
const DILUTION_SYSTEM_HOWTO_PATTERN =
  /\b(dilution\s+system|dilution\s+control|dispenser|proportion(?:er|ing)|metering\s+tip|dispensing\s+system|FastDraw|Clario)\b/i;

/** "How do employees…" / training / procedure phrasing, so a bare product-name mention is not enough. */
const HOWTO_OR_TRAINING_PATTERN =
  /\b(how\s+(?:do|should|does)|how\s+to|proper(?:ly)?\s+use|train(?:ing)?|employees?|staff|set\s*up|calibrat\w*|prepare|mix(?:ing)?)\b/i;

/** True when the message is a dilution-system how-to / employee-use / training ask (not a bare pathogen-recommendation ask). */
export function isDilutionSystemHowToQuestion(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;
  return DILUTION_SYSTEM_HOWTO_PATTERN.test(text) && HOWTO_OR_TRAINING_PATTERN.test(text);
}

/** The draft discusses using/applying a disinfectant with a dwell or contact time at all. */
const DISINFECTANT_DWELL_MENTION_PATTERN =
  /\b(disinfect\w*|sanitiz\w*)\b[\s\S]{0,400}\b(dwell|contact\s*time)\b|\b(dwell|contact\s*time)\b[\s\S]{0,400}\b(disinfect\w*|sanitiz\w*)\b/i;

/** True when the draft discusses disinfectant dwell/contact time in any form. */
export function draftMentionsDisinfectantDwell(draftAnswer: string): boolean {
  return DISINFECTANT_DWELL_MENTION_PATTERN.test(draftAnswer);
}

/**
 * The specific rule this backstop exists for: the surface stays visibly wet for the FULL labeled
 * contact time. Matched loosely ("visibly wet" alone, or "remain/stay wet" paired with
 * "full"/"entire"/"labeled" nearby) so a draft that already states this in its own words is not
 * double-patched.
 */
const VISIBLY_WET_FULL_TIME_PATTERN =
  /\bvisibly\s+wet\b|\b(?:remain|stay|keep(?:ing)?)\b[\s\S]{0,30}\bwet\b[\s\S]{0,60}\b(?:full|entire|labeled|entirety)\b|\b(?:full|entire|labeled)\b[\s\S]{0,60}\b(?:remain|stay|keep(?:ing)?)\b[\s\S]{0,30}\bwet\b/i;

/** True when the draft already states the visibly-wet-for-the-full-labeled-time rule in some form. */
export function draftStatesVisiblyWetDwell(draftAnswer: string): boolean {
  return VISIBLY_WET_FULL_TIME_PATTERN.test(draftAnswer);
}

/**
 * The canonical sentence, verbatim from the B0-978 prompt block (`product-support-prompts.ts`,
 * "Disinfectant recommendations — the conditions that make the claim valid"). Kept as a single
 * exported constant so the prompt text and the backstop text can be diffed and never drift apart.
 */
export const DILUTION_DWELL_BACKSTOP_SENTENCE =
  'The surface must stay visibly wet for the entire labeled contact time; if it dries early, reapply rather than shortening the time. Use the contact time and dilution from that product\'s own current label, and say plainly when that value was not retrieved — never supply one from memory.';

export type DilutionDwellBackstopResult = {
  answer: string;
  /** True when the sentence was appended; false when the draft already covered it or the trigger conditions were not met. */
  applied: boolean;
};

/**
 * Deterministically patches a finished draft that discusses disinfectant dwell/contact time on a
 * dilution-system how-to / employee-use question but omits the visibly-wet-for-the-full-time rule.
 * Additive only: never removes or rewrites existing content, only appends the missing sentence as
 * its own paragraph. Returns the draft unchanged (`applied: false`) whenever the question is not
 * this shape, the draft never touches disinfectant dwell at all, or the rule is already present.
 */
export function applyDilutionDwellBackstop(input: {
  userMessage: string;
  draftAnswer: string;
}): DilutionDwellBackstopResult {
  const draft = input.draftAnswer.trim();
  if (!draft) return { answer: input.draftAnswer, applied: false };
  if (!isDilutionSystemHowToQuestion(input.userMessage)) return { answer: input.draftAnswer, applied: false };
  if (!draftMentionsDisinfectantDwell(draft)) return { answer: input.draftAnswer, applied: false };
  if (draftStatesVisiblyWetDwell(draft)) return { answer: input.draftAnswer, applied: false };

  return {
    answer: `${input.draftAnswer.replace(/\s+$/, '')}\n\n${DILUTION_DWELL_BACKSTOP_SENTENCE}`,
    applied: true,
  };
}
