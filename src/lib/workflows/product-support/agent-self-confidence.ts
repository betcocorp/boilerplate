/**
 * B0-491 — the answering agent already gets told (in every specialist prompt) to "internally score"
 * its own confidence, but that score never left the model's head: only free-form answer text came
 * back, so nothing downstream could read it. This module defines the one machine-parseable channel
 * the model uses to report that score, and the pure functions that extract it and strip it back out
 * of the visible answer.
 *
 * Design constraint: the answering call streams tokens live to the Bex chat UI
 * (`onAssistantDelta` in `run-product-support-workflow.ts` — "whatever is written here has been
 * shown to someone and cannot be retracted"). A structured (JSON-schema) response format would lose
 * that streaming UX; a plain trailing sentence would be indistinguishable from prose. Instead the
 * model appends one exact HTML-comment line — invisible in rendered markdown, and never a real tool
 * call, so it costs no extra model round-trip. `createAgentConfidenceStreamFilter` (below) is the
 * companion piece that keeps it from ever reaching the live stream in the first place.
 */

/** The exact marker name, so a search for it in prompts/tests/logs finds every reference. */
export const AGENT_CONFIDENCE_MARKER_NAME = 'BEX_AGENT_CONFIDENCE';

const MARKER_OPEN = `<!--${AGENT_CONFIDENCE_MARKER_NAME}`;
const MARKER_CLOSE = '-->';

/**
 * The trailer instruction block, appended to `PRODUCT_SUPPORT_SHARED_INSTRUCTIONS` so it reaches
 * every specialist (all five share that suffix — see `buildProductSupportInstructions`). Kept as
 * its own exported constant (rather than inlined) so a unit test can assert the exact marker syntax
 * documented here matches what `extractAgentSelfConfidence` actually parses.
 */
export const AGENT_CONFIDENCE_TRAILER_INSTRUCTIONS = [
  '## Self-reported confidence (required, machine-only)',
  '',
  'After your visible reply text, on a new line, append EXACTLY one line in this exact form (replace the two placeholder values, keep the braces and prefix/suffix character-for-character):',
  '',
  `${MARKER_OPEN} {"agentConfidence":0.0,"agentConfidenceBasis":"short reason"}${MARKER_CLOSE}`,
  '',
  '- `agentConfidence` is your own 0–1 confidence that this reply is fully correct, complete, and properly grounded in the retrieved evidence (or, if you declined, your confidence that declining was the right call).',
  '- `agentConfidenceBasis` is one short, specific phrase (a few words) explaining why, e.g. "exact label dilution ratio cited" or "no retrieved source stated the value".',
  '- Always include this line, even when your reply is a decline or one of the exact-phrase responses required elsewhere in this prompt — this marker is stripped before anyone sees your reply, so appending it never counts as extra visible text and never violates an "exact phrase" instruction.',
  '- Do not explain it, wrap it in a code block, or add anything else around it — it must be machine-parseable exactly as shown, once, at the very end.',
].join('\n');

/** Closed set of outcomes for `extractAgentSelfConfidence` — always present, so a null score is never unexplained. */
export const AGENT_CONFIDENCE_REASONS = [
  /** The marker was present and parsed to a valid 0–1 number. */
  'reported',
  /** No marker found anywhere in the text — the model did not comply this turn. */
  'not_reported',
  /** A marker was found but its JSON body did not parse, or `agentConfidence` was not a number. */
  'malformed',
  /** A marker parsed to a number, but it was outside the closed [0, 1] range. */
  'out_of_range',
  /** No model call happened this turn at all (e.g. the early-decline gate short-circuited). */
  'no_model_call',
] as const;

export type AgentConfidenceReason = (typeof AGENT_CONFIDENCE_REASONS)[number];

export type AgentSelfConfidence = {
  agentConfidence: number | null;
  agentConfidenceBasis: string | null;
  reason: AgentConfidenceReason;
};

/** The `AgentSelfConfidence` recorded whenever no model call happened this turn. */
export const NO_MODEL_CALL_AGENT_CONFIDENCE: AgentSelfConfidence = {
  agentConfidence: null,
  agentConfidenceBasis: null,
  reason: 'no_model_call',
};

/**
 * Finds the LAST `BEX_AGENT_CONFIDENCE` marker in `rawText` (in case the model echoes an example of
 * one earlier in its reasoning), parses it, and returns both the self-confidence and the text with
 * that marker (and any trailing whitespace it left behind) removed. The marker never reaches the
 * returned `text` in any outcome — a malformed one is stripped just as much as a valid one, since a
 * half-broken machine marker leaking into a chat reply would be worse than no marker at all.
 */
export function extractAgentSelfConfidence(rawText: string): {
  text: string;
  selfConfidence: AgentSelfConfidence;
} {
  const openIndex = rawText.lastIndexOf(MARKER_OPEN);
  if (openIndex === -1) {
    return {
      text: rawText,
      selfConfidence: { agentConfidence: null, agentConfidenceBasis: null, reason: 'not_reported' },
    };
  }

  const closeIndex = rawText.indexOf(MARKER_CLOSE, openIndex + MARKER_OPEN.length);
  if (closeIndex === -1) {
    // An opened-but-never-closed marker is not renderable as a marker OR as prose — drop from the
    // open brace onward rather than leak a half-written machine tag into the visible reply.
    return {
      text: rawText.slice(0, openIndex).replace(/\s+$/, ''),
      selfConfidence: { agentConfidence: null, agentConfidenceBasis: null, reason: 'malformed' },
    };
  }

  const strippedText = (
    rawText.slice(0, openIndex) + rawText.slice(closeIndex + MARKER_CLOSE.length)
  ).replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '');

  const jsonBody = rawText.slice(openIndex + MARKER_OPEN.length, closeIndex).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBody);
  } catch {
    return {
      text: strippedText,
      selfConfidence: { agentConfidence: null, agentConfidenceBasis: null, reason: 'malformed' },
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      text: strippedText,
      selfConfidence: { agentConfidence: null, agentConfidenceBasis: null, reason: 'malformed' },
    };
  }

  const record = parsed as Record<string, unknown>;
  const rawConfidence = record.agentConfidence;
  const rawBasis = record.agentConfidenceBasis;
  const basis = typeof rawBasis === 'string' && rawBasis.trim() ? rawBasis.trim().slice(0, 500) : null;

  if (typeof rawConfidence !== 'number' || !Number.isFinite(rawConfidence)) {
    return {
      text: strippedText,
      selfConfidence: { agentConfidence: null, agentConfidenceBasis: basis, reason: 'malformed' },
    };
  }

  if (rawConfidence < 0 || rawConfidence > 1) {
    return {
      text: strippedText,
      selfConfidence: { agentConfidence: null, agentConfidenceBasis: basis, reason: 'out_of_range' },
    };
  }

  return {
    text: strippedText,
    selfConfidence: { agentConfidence: rawConfidence, agentConfidenceBasis: basis, reason: 'reported' },
  };
}

/**
 * B0-491 — wraps a caller-visible delta sink (`onAssistantDelta`) so the confidence marker never
 * reaches it, even mid-stream. Holds back only as much as it must: everything before the marker
 * start is flushed immediately; a short trailing lookahead buffer (bounded by the marker's own
 * length) guards against the marker's opening sequence arriving split across two deltas.
 *
 * Once the marker's close is seen, the whole marker is dropped (never flushed) and anything after
 * it (there should be nothing, per the prompt instruction) is flushed normally. `finish()` must be
 * called once the stream ends: if a marker was opened but never closed by then, the held buffer is
 * dropped silently (same "never leak a half-written machine tag" rule as the non-streaming parser);
 * otherwise any still-held lookahead text (never actually part of a marker) is flushed.
 */
export function createAgentConfidenceStreamFilter(sink: (delta: string) => void): {
  onDelta: (delta: string) => void;
  finish: () => void;
} {
  let held = '';
  let markerOpen = false;

  const onDelta = (delta: string) => {
    held += delta;

    if (!markerOpen) {
      const openIndex = held.indexOf(MARKER_OPEN);
      if (openIndex === -1) {
        // No marker seen yet. Flush everything except a short tail that could still be the start
        // of the marker's opening sequence, split across the next delta.
        const safeToFlush = held.length - (MARKER_OPEN.length - 1);
        if (safeToFlush > 0) {
          sink(held.slice(0, safeToFlush));
          held = held.slice(safeToFlush);
        }
        return;
      }
      // Marker start found: flush everything before it, then start buffering the marker itself.
      if (openIndex > 0) {
        sink(held.slice(0, openIndex));
      }
      held = held.slice(openIndex);
      markerOpen = true;
    }

    const closeIndex = held.indexOf(MARKER_CLOSE);
    if (closeIndex !== -1) {
      // Whole marker captured — drop it. Flush anything after it (normally nothing).
      const after = held.slice(closeIndex + MARKER_CLOSE.length);
      if (after) {
        sink(after);
      }
      held = '';
      markerOpen = false;
    }
  };

  const finish = () => {
    if (!markerOpen && held) {
      sink(held);
    }
    held = '';
    markerOpen = false;
  };

  return { onDelta, finish };
}
