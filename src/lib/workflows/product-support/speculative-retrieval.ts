import type { ToolTraceEntry } from '~/lib/audit/trace';
import type { ExecuteToolFn, PreloadedEvidence } from '~/lib/llm/generation-shared';

/**
 * B0-436 — speculative retrieval.
 *
 * Round 1 of the product-support tool loop used to be a model call whose entire output was a tool
 * selection: `tool_choice: 'required'` forced a call, and in 422 of 516 instrumented first calls the
 * tool chosen was `search_product_docs` with (effectively) the user's own message as the query, for an
 * average of only 1.12 tool calls per run. That round produced no user-visible text and cost a full
 * model round-trip (~2.8s at the observed 2,763ms/call).
 *
 * So we run that search ourselves BEFORE the first model call, hand the result to it as preloaded
 * evidence, and drop `tool_choice` to `'auto'`. The common path becomes one search + one model call
 * instead of one model call + one search + one model call.
 *
 * Guardrail: this must SATISFY the prompt's mandatory-retrieval requirement, never bypass it. The
 * speculative result flows through the workflow's own `executeTool` closure, so it lands in
 * `toolOutputLog` / `toolTrace` and is seen by `collectSourceMetaFromToolOutputs`,
 * `collectRetrievedDocumentChunksFromToolOutputs`, the usage/safety coverage gate,
 * `buildEvidenceSummary` and `evaluateRegulatedClaimGrounding` exactly as a model-requested call
 * would be.
 *
 * B0-635 — one exception, and only for user-visible citations: `collectSourcesFromToolOutputs` skips
 * a speculative result whose own product-line resolution declined to lock (see
 * `isUnendorsedSpeculativeToolOutput`). Because this searches the RAW user message, it can match an
 * incidental word rather than the product asked about, and those weak hits were being cited. The
 * evidence and audit paths above are deliberately NOT narrowed — the regulated-claim guardrail must
 * always see the complete evidence set.
 *
 * B0-788 — one more exception, and it is a correctness fix, not a citation-narrowing one. Dropping
 * `tool_choice` to `'auto'` means the model is free to answer straight from the speculative
 * `search_product_docs` result instead of making the SECOND call both the dilution-specialist prompt
 * and the shared product-support instructions explicitly require for exact dilution/contact-time/
 * kill-claim questions (`get_efficacy_data` — a typed-column lookup, not prose retrieval). Verified
 * live: a 14-item real eval of dilution questions called `get_efficacy_data` ZERO times across every
 * item; the prompt instruction alone was not enough. `looksLikeExactEfficacyQuestion` below is a
 * narrow, deterministic keyword check (same style as `classifySpeculativeRetrievalSkip`) the calling
 * workflow uses to override `'auto'` back to a named-function pin on `get_efficacy_data` for this one
 * question shape — everything else keeps the B0-436 latency win untouched. Deliberately NOT built by
 * relaxing the retired Responses loop's `suggestedFirstTool` bias (B0-512), which nothing in production
 * ever threaded and which was removed with that loop (B0-914).
 */

/**
 * B0-788 — questions whose correct answer is an EXACT number from the fact tables
 * (`get_efficacy_data`), not a paraphrase of retrieved prose: dilution ratios, oz/gal or mL/L
 * figures, gallon/RTU yield, contact/dwell time, and kill-claim / log-reduction / EPA-registration
 * questions. Kept deliberately broad (false positives cost one extra, cheap, informative tool call;
 * false negatives silently reproduce the bug this exists to fix) and deliberately simple (a keyword
 * match, not an LLM call — this must run before the first model call).
 */
const EXACT_EFFICACY_QUESTION_PATTERN =
  /\b(dilut\w*|oz\.?\s*(?:per|\/)\s*gal\w*|ml\s*(?:per|\/)\s*l\b|contact\s*time|dwell\s*time|kill\s*claim|log\s*reduction|efficacy|epa\s*reg(?:istration)?|yield\w*|gallons?)\b/i;

export function looksLikeExactEfficacyQuestion(userMessage: string): boolean {
  return EXACT_EFFICACY_QUESTION_PATTERN.test(userMessage);
}

/**
 * B0-889 — same fix shape as B0-788 above, for a different question: "best glass cleaner",
 * "strongest wood floor stripper", and "what should I use for greasy kitchen floors" all named 2-4
 * of a category's actual products instead of the full documented list. The prompt rules
 * (`product-support-prompts.ts` "Best/strongest…" and "Lists of products" sections) already say to
 * call the category tool and list every match — verified live, the model kept answering from
 * whatever `search_product_docs`/speculative-retrieval chunks happened to rank top instead, the same
 * failure mode `looksLikeExactEfficacyQuestion` exists to prevent for dilution questions. Deliberately
 * broad and deterministic (a keyword match, not an LLM call — this must run before the first model
 * call): a false positive costs one extra, cheap, informative category-tool call; a false negative
 * silently reproduces the bug.
 */
const SUPERLATIVE_RANKING_PATTERN = /\b(best|strongest|most effective|top\s*\d*)\b/i;

/**
 * B0-977 — the first alternation also admits a noun phrase between "what" and "should I/we use":
 * "what stripping and finish products should I use for my VCT floor?" was `false` here (the
 * contiguous "what should I use" never occurs), so the B0-889 category-tool forcing never ran and
 * the answer collapsed to whichever two products the speculative search ranked top. Bounded to 60
 * non-`?` characters so it stays within one question.
 */
const TASK_RECOMMENDATION_PATTERN =
  /\bwhat\b[^?]{0,60}?\bshould\s+(?:i|we)\s+use\b|\bwhat\s+(?:should|do|would|can)\s+(?:i|you|we)\s+use\b|\bwhat\s+(?:do|would)\s+you\s+recommend\b|\brecommend\s+(?:a|an|something)\s+for\b/i;

export function looksLikeCategoryListOrSuperlativeAsk(userMessage: string): boolean {
  return SUPERLATIVE_RANKING_PATTERN.test(userMessage) || TASK_RECOMMENDATION_PATTERN.test(userMessage);
}

export const SPECULATIVE_SEARCH_TOOL_NAME = 'search_product_docs';

/**
 * Speculative retrieval is on by default; set `BEX_SPECULATIVE_RETRIEVAL=false` to fall back to the
 * pre-B0-436 behaviour (forced tool choice, no preloaded evidence) without a redeploy.
 */
export function isSpeculativeRetrievalEnabled(): boolean {
  return process.env.BEX_SPECULATIVE_RETRIEVAL !== 'false';
}

export type SpeculativeSkipReason =
  /** `BEX_SPECULATIVE_RETRIEVAL=false`. */
  | 'flag_disabled'
  /** `shouldForceCrossReferenceLookup` fired — that path forces `lookup_cross_reference` and is left exactly as it was. */
  | 'forced_cross_reference'
  /** The cross_reference route must call `lookup_cross_reference` before any similarity search, so a product-docs search is wasted work. */
  | 'cross_reference_route'
  /** Nothing to search for. */
  | 'empty_message';

/**
 * Which runs skip speculation. Anything not listed here speculates — including the `product` and
 * `ambiguous` routes, which are 92% of production traffic.
 */
export function classifySpeculativeRetrievalSkip(input: {
  userMessage: string;
  forcedCrossReference: boolean;
  routingDecision: string;
}): SpeculativeSkipReason | null {
  if (!isSpeculativeRetrievalEnabled()) {
    return 'flag_disabled';
  }
  if (input.forcedCrossReference) {
    return 'forced_cross_reference';
  }
  if (input.routingDecision === 'cross_reference') {
    return 'cross_reference_route';
  }
  if (!input.userMessage.trim()) {
    return 'empty_message';
  }
  return null;
}

/**
 * `freeformQuery` alone is valid input per `searchProductDocsInputSchema` (B0-362) and is exactly
 * what the prompt tells the model to send when the product name is not yet known — which is the
 * shape 82% of real first calls take.
 */
export function buildSpeculativeSearchArgumentsJson(userMessage: string): string {
  return JSON.stringify({ freeformQuery: userMessage.trim() });
}

export function buildSpeculativeCallId(runId: string): string {
  return `speculative-search-${runId}`;
}

type ExecutedTool = Awaited<ReturnType<ExecuteToolFn>>;

/** The workflow's `executeTool` closure, which accepts the `speculative` audit marker. */
export type SpeculativeExecuteToolFn = (input: {
  name: string;
  argumentsJson: string;
  callId: string;
  speculative?: boolean;
}) => Promise<ExecutedTool>;

export type SpeculativeRetrievalOutcome = {
  skippedReason: SpeculativeSkipReason | null;
  /** Null when skipped. Present (with `trace.ok === false`) when the search itself failed. */
  result: ExecutedTool | null;
};

/**
 * Runs the speculative search through the caller's `executeTool` closure so all of its bookkeeping
 * (audit rows, `retrievalTiming` accounting, `toolTrace`, `toolOutputLog`, tool started/completed
 * events) happens exactly once and exactly as it does for a model-requested call.
 */
export async function runSpeculativeRetrieval(input: {
  userMessage: string;
  routingDecision: string;
  forcedCrossReference: boolean;
  callId: string;
  execute: SpeculativeExecuteToolFn;
}): Promise<SpeculativeRetrievalOutcome> {
  const skippedReason = classifySpeculativeRetrievalSkip({
    userMessage: input.userMessage,
    forcedCrossReference: input.forcedCrossReference,
    routingDecision: input.routingDecision,
  });
  if (skippedReason) {
    return { skippedReason, result: null };
  }

  const result = await input.execute({
    name: SPECULATIVE_SEARCH_TOOL_NAME,
    argumentsJson: buildSpeculativeSearchArgumentsJson(input.userMessage),
    callId: input.callId,
    speculative: true,
  });

  return { skippedReason: null, result };
}

/** trim + lowercase + collapse whitespace. Deliberately NOT fuzzy — see `canReuseSpeculativeSearch`. */
function normalizeQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Whether a model-requested `search_product_docs` call is the same search the speculative run already
 * performed, and can therefore be served from it.
 *
 * Matching is strictly literal (normalized string equality on the single query field, or empty args).
 * A duplicate real search costs latency; a wrongly reused result silently answers a *different*
 * question from the wrong documents — which for EPA/GHS content is a correctness failure, not a
 * performance one. So anything that is not an obvious match runs for real.
 */
export function canReuseSpeculativeSearch(input: {
  toolName: string;
  argumentsJson: string;
  userMessage: string;
}): boolean {
  if (input.toolName !== SPECULATIVE_SEARCH_TOOL_NAME) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.argumentsJson || '{}') as unknown;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }

  const args = parsed as Record<string, unknown>;
  // Any narrowing field the speculative call did not use makes this a different search.
  // B0-460 — `includeVariants: true` also makes this a different (fuller) search: the speculative
  // call always ran with the default `includeVariants: false`, so its result has the "Size and
  // package variants" section collapsed — not what a model call asking for it back should be served.
  if (
    trimmedString(args.surfaceType) ||
    trimmedString(args.productName) ||
    args.includeVariants === true
  ) {
    return false;
  }

  const freeformQuery = trimmedString(args.freeformQuery);
  const topic = trimmedString(args.topic);

  // Empty args: `executeProductTool` would build an empty query from them (and the Zod refine would
  // reject the call outright), so the speculative result is strictly better than running it.
  if (!freeformQuery && !topic) {
    return true;
  }
  // Exactly one query field, equal to the message the speculative call searched for.
  if (freeformQuery && topic) {
    return false;
  }
  return normalizeQuery(freeformQuery || topic) === normalizeQuery(input.userMessage);
}

/**
 * Wraps the workflow's `executeTool` so a model-requested search that matches the speculative one is
 * served from it. The reused entry is pushed onto the runtime's `toolTrace` (the model really did ask
 * for the tool) marked `reusedSpeculativeResult`, but is NOT re-logged into `toolOutputLog`: the
 * payload is already there from the speculative call, and double-logging it would double-count
 * `retrievalTiming` and the search-latency average.
 */
export function createSpeculativeReuseExecutor(input: {
  speculative: ExecutedTool | null;
  userMessage: string;
  execute: ExecuteToolFn;
  onReuse?: (reuse: { callId: string; argumentsJson: string }) => void;
}): ExecuteToolFn {
  const reusable =
    // Never reuse a failed search: let the model's own call surface (or recover from) the failure.
    input.speculative && input.speculative.trace.ok ? input.speculative : null;

  return async (call) => {
    if (
      reusable &&
      canReuseSpeculativeSearch({
        toolName: call.name,
        argumentsJson: call.argumentsJson,
        userMessage: input.userMessage,
      })
    ) {
      input.onReuse?.({ callId: call.callId, argumentsJson: call.argumentsJson });
      const trace: ToolTraceEntry = {
        ...reusable.trace,
        callId: call.callId,
        argumentsPreview: (call.argumentsJson || '').slice(0, 1800),
        speculative: undefined,
        reusedSpeculativeResult: true,
      };
      return { ...reusable, trace };
    }

    return input.execute(call);
  };
}

/** The preloaded-evidence block handed to round 1, labelled with the search that produced it. */
export function buildPreloadedEvidence(input: {
  userMessage: string;
  output: string;
}): PreloadedEvidence {
  return {
    label: `${SPECULATIVE_SEARCH_TOOL_NAME}(${buildSpeculativeSearchArgumentsJson(
      input.userMessage,
    )})`,
    text: input.output,
  };
}

export const CATEGORY_LIST_TOOL_NAME = 'get_products_in_category';

export function buildCategoryListArgumentsJson(categoryTerm: string): string {
  return JSON.stringify({ categoryName: categoryTerm });
}

export function buildCategoryListCallId(runId: string, categoryTerm: string): string {
  return `category-list-${categoryTerm.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${runId}`;
}

/**
 * B0-977 — a multi-category ask ("what stripping and finish products should I use for my VCT
 * floor?") gets ONE workflow-run `get_products_in_category` call per detected category (see
 * `detectCategorySearchTerms`), because a single pinned `tool_choice` yields one model call whose
 * `categoryName` normalises to its FIRST category token only ('strip…' → 'stripper'; the finishes
 * were never listed). Their payloads are appended to the speculative search's evidence block so the
 * same round-1 message carries every documented lineup, labelled call by call so the model can cite
 * which category each list came from. Payloads are carried verbatim — never summarised.
 */
export function appendCategoryListEvidence(
  base: PreloadedEvidence,
  categoryResults: ReadonlyArray<{ categoryTerm: string; output: string }>,
): PreloadedEvidence {
  if (categoryResults.length === 0) {
    return base;
  }
  const labels = categoryResults.map(
    (result) => `${CATEGORY_LIST_TOOL_NAME}(${buildCategoryListArgumentsJson(result.categoryTerm)})`,
  );
  const blocks = categoryResults.map(
    (result, index) => `### ${labels[index]}\n${result.output}`,
  );
  return {
    label: [base.label, ...labels].join(' + '),
    text: [`### ${base.label}\n${base.text}`, ...blocks].join('\n\n'),
  };
}
