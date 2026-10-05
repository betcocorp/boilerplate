import type { ToolTraceEntry } from '~/lib/audit/trace';

/**
 * B0-1140 — helpers and types shared by the generation loop and everything around it (the workflow,
 * validator, retrieval pre-loaders and the structured-completion adapters). They lived in
 * `~/lib/openai/responses-runtime` only because that was the first loop written; none of them is
 * Responses-API specific, so they moved here unchanged ahead of that loop's retirement.
 */

export type ExecuteToolFn = (input: {
  name: string;
  argumentsJson: string;
  callId: string;
}) => Promise<{
  output: string;
  /**
   * B0-437 — slimmer projection of `output` for the model only (see `~/lib/tools/model-tool-payload`).
   * The runtime sends `modelOutput ?? output` to the model; the caller persists the full `output`, so
   * the validator and the regulated-claim guardrail keep seeing the complete evidence.
   */
  modelOutput?: string;
  trace: ToolTraceEntry;
}>;

/**
 * B0-436 — evidence retrieved BEFORE the first model call (speculative retrieval), handed to that
 * call so it can be the *answering* call instead of a round spent selecting the one obvious tool.
 *
 * It is appended to round 1's `input` as its own message item, deliberately NOT merged into
 * `instructions` and NOT reflected in `promptCacheKey`: those two form the stable cache prefix
 * (see `promptCacheKey` below) and a per-request value in either collapses prompt caching.
 */
export type PreloadedEvidence = {
  /** Where the evidence came from, e.g. `search_product_docs (pre-fetched)`. */
  label: string;
  /** The tool payload exactly as the model would have received it from a real tool call. */
  text: string;
};

/**
 * Renders `PreloadedEvidence` as the single message item both runtimes inject. Shared so the
 * Responses and AI SDK paths present byte-identical evidence to the model.
 *
 * The wording matters: the product-support system prompt hard-requires a retrieval call before
 * answering, so this block states plainly that the retrieval already ran (and what to do when it is
 * not enough) — otherwise the model reads "you have not retrieved yet" and burns the round anyway.
 */
export function formatPreloadedEvidence(evidence: PreloadedEvidence): string {
  return [
    '## Retrieved evidence (pre-fetched)',
    '',
    `A retrieval tool was already run on your behalf for this message: \`${evidence.label}\`.`,
    'This IS the mandatory retrieval call — treat the result below exactly as if you had called the tool yourself, and cite from it.',
    'If it does not contain what you need, call the appropriate tool(s) now before answering.',
    '',
    evidence.text,
  ].join('\n');
}

/**
 * B0-378 — one prior conversation turn as it is replayed into a stateless model call.
 *
 * Shared by both generation runtimes (`runResponsesWithToolLoop`'s `history` and
 * `runAiSdkWithToolLoop`'s `history`) so a replayed conversation is assembled identically on either
 * path — that symmetry is the point of the ticket.
 *
 * `toolContext` is the B0-378 fidelity patch: a *summary* of the tool activity that produced the
 * assistant turn, rendered by `formatPriorTurnToolContext`. It is only ever populated for
 * `role: 'assistant'` messages, and only by callers that have the persisted turn in hand
 * (`~/lib/bex/run-chat-turn`). See `PriorTurnToolContext` for why it is a summary and not real
 * tool-call/tool-result parts.
 */
export type ReplayedHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
  /** B0-378 — summarised tool activity for an assistant turn; see `formatPriorTurnToolContext`. */
  toolContext?: string;
};

/**
 * B0-378 — the prior-turn tool facts that are actually recoverable from a persisted assistant
 * message (`agent_messages.content`, `assistantMessageContentSchema`).
 *
 * What is stored is `toolSummary: [{ name, ok }]` and `sources: [{ title, documentId, … }]` — tool
 * NAMES and the TITLES of the documents that turn cited. The tool *arguments* and tool *outputs*
 * are not stored on the message at all: the only copy of them is the truncated
 * `argumentsPreview` / `outputPreview` on `workflow_steps`' persisted `toolTrace` (1.8k / 4k chars).
 *
 * So genuine AI SDK tool-call / tool-result message parts cannot be reconstructed: doing it would
 * require inventing tool-call ids and presenting a truncated preview as if it were the full tool
 * payload. A model handed a silently-truncated "tool result" believes it holds the whole document —
 * which, for label and SDS data, is precisely how an unsupported dilution or contact time gets
 * asserted. A summary that says plainly what it is cannot cause that; an inaccurate replay can.
 */
export type PriorTurnToolContext = {
  /** Tool names in execution order, deduplicated, exactly as recorded on the persisted turn. */
  toolNames: string[];
  /** Titles of the documents that turn retrieved. Titles only — never snippets (see below). */
  sourceTitles: string[];
  /** How many further source titles the caller's cap dropped, if any. */
  omittedSourceCount?: number;
};

/** B0-378 — stable opening line of a replayed tool-context block; asserted on by both runtimes' tests. */
export const PRIOR_TURN_TOOL_CONTEXT_HEADER = '## Prior turn tool activity (summary)';

/**
 * B0-378 — renders `PriorTurnToolContext` as the single message item both runtimes inject after the
 * assistant turn it belongs to. Shared with `formatPreloadedEvidence` above for the same reason:
 * the Responses and AI SDK paths must present byte-identical text to the model.
 *
 * Deliberately carries NO source snippets, only titles. A snippet is a fragment of a regulated
 * document lifted out of its context; re-injecting fragments turn after turn is an invitation to
 * quote a dilution ratio or contact time whose surrounding qualifiers were dropped. Titles let the
 * model recognise what it already looked at and re-fetch it — which is the actual thing the AI SDK
 * path was missing — without ever putting an unverifiable number in front of it.
 *
 * Returns `null` when there is nothing to say, so callers do not emit an empty block.
 */
export function formatPriorTurnToolContext(context: PriorTurnToolContext): string | null {
  const toolNames = context.toolNames.filter((name) => name.trim().length > 0);
  const sourceTitles = context.sourceTitles.filter((title) => title.trim().length > 0);
  if (toolNames.length === 0 && sourceTitles.length === 0) {
    return null;
  }

  const omitted = context.omittedSourceCount ?? 0;
  const lines = [
    PRIOR_TURN_TOOL_CONTEXT_HEADER,
    '',
    'This is a SUMMARY of what ran on the previous assistant turn — not the tool results themselves.',
    'The tool arguments and tool payloads from that turn are not available in this context.',
    '',
  ];

  if (toolNames.length > 0) {
    lines.push(`Tools called, in order: ${toolNames.join(', ')}`);
  }
  if (sourceTitles.length > 0) {
    lines.push(
      `Documents retrieved (titles only): ${sourceTitles.map((title) => `"${title}"`).join('; ')}` +
        (omitted > 0 ? ` (+${omitted} more)` : ''),
    );
  }

  lines.push(
    '',
    'Do not quote or infer any dilution ratio, oz/gal, mL/L, ppm, percentage, contact time, EPA ' +
      'registration number, CAS number, or log-reduction value from this summary — it contains ' +
      'none. If this turn needs a value from one of those documents, call the appropriate tool ' +
      'again now.',
  );

  return lines.join('\n');
}

/**
 * B0-948 — the caller's fact-category → tool policy, evaluated ONCE per run on the model's first
 * finished draft (the first response that requests no tools).
 *
 * The runtime deliberately knows nothing about product-support fact categories or tool names — the
 * same rule `RETRIEVAL_TOOL_NAMES` follows, and for the same reason: this loop is generic over
 * whatever `opts.tools` it is handed. It only supplies the mechanism (classify → pin `tool_choice`
 * → re-draft, at most once). The policy lives in
 * `~/lib/workflows/product-support/fact-tool-enforcement`.
 *
 * Return the ONE tool that must be called before the draft may stand, together with the
 * model-visible instruction to send with it, or null to finalise the draft as-is.
 */
export type FactToolRequirementCheck = (input: {
  draftAnswer: string;
  /** Tool names executed through this runtime so far, in execution order. */
  toolNames: string[];
}) => { toolName: string; instruction: string } | null;

/**
 * B0-948 — what the run did about the fact-tool requirement, reported once so the workflow can
 * persist it as a gate and it is visible in the run report.
 */
export type FactToolEnforcementOutcome = {
  /** The tool the policy demanded, or null when it demanded nothing. */
  requiredTool: string | null;
  /** Whether the forced round actually happened. */
  enforced: boolean;
  /** Why it did not. Absent when `enforced`, or when nothing was required. */
  reason?: 'tool_not_offered' | 'retrieval_withdrawn' | 'no_rounds_remaining' | 'model_declined_call';
  /** Whether the forced call executed successfully. Null when nothing was forced. */
  toolSucceeded: boolean | null;
  /**
   * B0-984 — the draft the model had finished BEFORE the forced round, so a run report can diff
   * what enforcement changed. Present whenever a forced round was opened (enforced, or the model
   * declined the pinned call); absent when nothing was required or the pin could not be placed.
   */
  preEnforcementDraft?: string;
};

export type LlmTokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * B0-324 — prompt tokens the provider served from its automatic prompt cache
   * (`usage.input_tokens_details.cached_tokens`). Non-zero on the 2nd+ model call of a
   * multi-round tool loop means the stable prefix (instructions + tool schemas) is being reused.
   */
  cachedPromptTokens: number;
};

/**
 * B0-381 — the user-role message that accompanies the synthetic outputs on the forced final request.
 * Exported (B0-901) so the AI SDK loop injects the identical text; there is deliberately no second
 * copy of it anywhere.
 */
export const TOOL_ROUNDS_EXHAUSTED_INSTRUCTION =
  'You have reached the tool-call limit for this turn — no further tool calls will be executed. ' +
  'Answer the user\'s question NOW using only the evidence already gathered above. ' +
  'If the gathered evidence is not sufficient for a complete verified answer, say plainly which part ' +
  'you could not verify instead of guessing or inventing values.';

/**
 * B0-381 — last-resort answer when even the forced `tool_choice: 'none'` request produces no text.
 * Exhaustion must never surface an empty `assistantText`.
 */
export const TOOL_ROUNDS_EXHAUSTED_FALLBACK_TEXT =
  'I hit the tool-call limit for this request before I could finish gathering evidence, so I can\'t ' +
  'give a complete verified answer. Please narrow the question (one product or one topic at a time) ' +
  'and ask again.';

/**
 * B0-635 — the tools whose payloads carry a `sources[]` array of retrieved RAG evidence, i.e. the
 * ones whose *only* contribution to a turn is documents. Taken from the `executeProductTool` switch
 * in `~/lib/tools/product-tools.ts`: every branch below returns `sources: sourcePayload(result)`
 * (the semantic-search family) or an explicitly built `sources` array (`get_efficacy_data`, both its
 * single and batch forms).
 *
 * Deliberately NOT listed, because their value is structured/computed rather than retrieved and a
 * repeat call can legitimately return the same ids: `get_escalation_policy` (static policy),
 * `lookup_cross_reference` / `recommend_cross_reference` (competitor cross-reference),
 * `get_products_in_category` / `get_product_category` / `find_products_by_category` (website
 * taxonomy navigation). Those stay callable even after retrieval is withdrawn.
 *
 * A hard-coded list rather than an import from `~/lib/tools/tool-schemas`: this runtime is generic
 * over whatever `opts.tools` it is handed and must not take a dependency on the product-support tool
 * surface. An unrecognised tool name is simply not treated as retrieval (fail-open — it can never
 * cause an early stop).
 */
export const RETRIEVAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'search_product_docs',
  'get_product_spec',
  'get_approved_usage_guidance',
  'get_safety_constraints',
  'get_compatibility_rules',
  'list_allowed_surfaces',
  'list_disallowed_uses',
  'get_efficacy_data',
  // B0-529 — knowledge-corpus retrievals: they return document ids, so an unproductive repeat is
  // the same signal here as for any other retrieval tool.
  'get_dispenser_asset',
  'get_floor_asset',
]);

/**
 * B0-635 — how many *consecutive* retrieval calls may return zero previously-unseen evidence ids
 * before retrieval tools are withdrawn for the rest of the run.
 *
 * 2, not 1: one repeat is normal and often productive in a different way (a second call re-reads the
 * same document with different arguments, or narrows to one product of several). Two in a row is the
 * observed signature of the pathological pattern in run `5b13095f` — progressively broader generic
 * queries returning unrelated products, ~26k chars of context and ~4s for nothing. Any productive
 * call resets the counter, so an arbitrarily long chain of searches that keep finding new documents
 * is completely unaffected.
 */
export const UNPRODUCTIVE_RETRIEVAL_CALL_LIMIT = 2;

/**
 * B0-635 — sent to the model in the same turn retrieval is withdrawn.
 *
 * Withdrawing a tool silently is worse than leaving it: an agent that still wants a number and has
 * no way to look it up is precisely the setup that invents one (the repro run reported confidence
 * 0.93 citing a "2 L package" present in no retrieved evidence). So the withdrawal is stated
 * explicitly, together with what to do instead — name the gap.
 */
export const RETRIEVAL_EXHAUSTED_INSTRUCTION =
  `Retrieval is exhausted for this turn. Your last ${UNPRODUCTIVE_RETRIEVAL_CALL_LIMIT} retrieval ` +
  'calls returned only documents you have already been given, so the retrieval tools have been ' +
  'withdrawn for the rest of this turn and no further search will run. The corpus does not hold ' +
  'more on this question than what is already above — searching again would return the same or ' +
  'unrelated documents. ' +
  'Answer the user NOW from the evidence already gathered. Where the evidence does not contain a ' +
  'value the question needs, say plainly and specifically that it is not on file: do not estimate, ' +
  'convert, back-calculate, or recall from general knowledge any dilution ratio, oz/gal, mL/L, ppm, ' +
  'percentage, contact time, yield, container volume, or pack size that does not appear verbatim in ' +
  'the evidence above.';

/**
 * B0-635 — the evidence ids one retrieval tool payload contributed, namespaced by field so a
 * document id can never collide with a chunk id.
 *
 * Reads the FULL tool payload (`output`), not the slimmed model-facing projection (`modelOutput`):
 * the projection drops `documentBodyChunkIds` whenever it truncates a body, and this decision must
 * be made on what was actually retrieved.
 *
 * `documentBodyChunkIds` is included alongside `documentId`/`chunkId` deliberately: since B0-547 the
 * same document can come back with a different assembled chunk window, which IS new information,
 * and counting those ids keeps such a call productive.
 *
 * Anything unparseable, non-object, or without a `sources` array yields no ids — a failed, errored,
 * or genuinely empty retrieval counts as "nothing new", which is the intended reading.
 */
export function collectRetrievalEvidenceIds(payloadJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }

  const sources = (parsed as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) {
    return [];
  }

  const ids: string[] = [];
  const push = (namespace: string, value: unknown) => {
    if (typeof value === 'string' && value.trim().length > 0) {
      ids.push(`${namespace}:${value}`);
    }
  };

  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      continue;
    }
    const record = source as Record<string, unknown>;
    push('documentId', record.documentId);
    push('chunkId', record.chunkId);
    if (Array.isArray(record.documentBodyChunkIds)) {
      for (const chunkId of record.documentBodyChunkIds) {
        push('chunkId', chunkId);
      }
    }
  }

  return ids;
}

/**
 * B0-635 — whether this payload came from a corpus *search* rather than a structured point lookup.
 *
 * Only a search can be evidence that the corpus is exhausted. `get_efficacy_data` answering "no
 * facts on file" for one product (adapter `structured_facts_v1`, no `sources` at all — exactly what
 * Push returns) says nothing about whether a document search would find the answer, so it must not
 * push the run toward withdrawing search. Without this, two empty efficacy lookups — a normal
 * opening move when efficacy rows are sparse — would withdraw `search_product_docs` before it had
 * been tried even once.
 *
 * Read from the payload's own `adapter` discriminator (`rag_corpus_full_document` for the semantic
 * search family, `structured_facts_v1` for fact lookups) rather than inferred from the tool name: a
 * tool like `get_efficacy_data` can answer from either path depending on what it finds.
 */
export function isCorpusSearchPayload(payloadJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    const adapter = (parsed as { adapter?: unknown }).adapter;
    return typeof adapter === 'string' && adapter.startsWith('rag_corpus');
  } catch {
    return false;
  }
}
