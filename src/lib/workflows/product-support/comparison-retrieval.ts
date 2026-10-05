import { resolveProductEntityByName } from '~/lib/rag/entity-context';
import type { ProductEntityResolutionSource } from '~/lib/rag/entity-context';
import type { ExecuteToolFn, PreloadedEvidence } from '~/lib/llm/generation-shared';
import { SPECULATIVE_SEARCH_TOOL_NAME } from '~/lib/workflows/product-support/speculative-retrieval';

/**
 * B0-890 — two-product comparison retrieval.
 *
 * "What's the difference between pH7Q and pH7Q Dual?" was answered with "there is no label or
 * documentation provided for pH7Q (non-Dual)" — false; the corpus has a label for each. The single
 * speculative `search_product_docs` call (B0-436) only searches the raw user message and
 * `resolveProductLineFromMatches` can only lock ONE product line, so only one of the two named
 * products' evidence ever reached the generator, and the validator then rejected the pH7Q half of
 * an otherwise-correct draft for lack of a pH7Q source.
 *
 * This module deterministically detects a two-product comparison, resolves BOTH names to their own
 * `product_line_key` (never guessing — the same resolver `resolveProductEntityByName` used
 * everywhere else), and fans out one retrieval call SCOPED to each resolved line so both labels are
 * available as pre-fetched evidence before the model's first call — the same mechanism B0-436 uses
 * for the single-product case.
 */

type ExecutedTool = Awaited<ReturnType<ExecuteToolFn>>;

export type ComparisonEntity = {
  /** The name segment extracted from the user's message for this side of the comparison. */
  name: string;
  productLineKey: string;
  productKey: string | null;
  resolutionSource: ProductEntityResolutionSource;
};

/** Strips leading question phrasing so the resolver sees just the product name. */
const LEADING_FILLER_RE =
  /^(?:what(?:'s| is| are)?|which|is|are|do you (?:have|carry|sell)|tell me about|compare)\s+(?:the\s+)?/i;

/** Strips a trailing clause that isn't part of the product name (e.g. "... for VCT floors?"). */
const TRAILING_FILLER_RE = /\s*,?\s+\b(?:for|in|on|when|at|is|are|the|do you)\b.*$/i;

function cleanCandidate(raw: string): string {
  return raw
    .replace(/[®™]/g, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/[?.!]+$/, '')
    .trim();
}

/**
 * Deterministically splits a message into two candidate product-name phrases when it uses
 * comparison phrasing — "vs", "versus", "difference between … and …", "compared to", or "or". No
 * resolution happens here; a candidate is just a phrase, real or not — `resolveComparisonEntities`
 * below is what decides whether it names an actual, distinct product.
 */
export function extractComparisonCandidates(message: string): [string, string] | null {
  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }

  const betweenMatch = trimmed.match(/difference\s+between\s+(.+?)\s+and\s+(.+?)(?:[?.!]|$)/i);
  if (betweenMatch?.[1] && betweenMatch[2]) {
    const a = cleanCandidate(betweenMatch[1]);
    const b = cleanCandidate(betweenMatch[2]);
    return a && b ? [a, b] : null;
  }

  const connectorMatch = trimmed.match(/\s+(?:vs\.?|versus|compared\s+to|or)\s+/i);
  if (!connectorMatch || connectorMatch.index === undefined) {
    return null;
  }

  const left = trimmed.slice(0, connectorMatch.index).replace(LEADING_FILLER_RE, '');
  const right = trimmed.slice(connectorMatch.index + connectorMatch[0].length).replace(TRAILING_FILLER_RE, '');

  const a = cleanCandidate(left);
  const b = cleanCandidate(right);
  return a && b ? [a, b] : null;
}

export type ResolveProductEntity = (name: string) => Promise<{
  productLineKey: string | null;
  productKey: string | null;
  resolutionSource: ProductEntityResolutionSource;
}>;

const NULL_RESOLUTION = { productLineKey: null, productKey: null, resolutionSource: null } as const;

const defaultResolve: ResolveProductEntity = async (name) => {
  try {
    const resolved = await resolveProductEntityByName(name);
    return {
      productLineKey: resolved.productLineKey,
      productKey: resolved.productKey,
      resolutionSource: resolved.resolutionSource,
    };
  } catch {
    // Fail open — a resolver outage must never fail the turn or fall back to the single-search
    // path with an unhandled rejection; same contract as `enrichSignals` in
    // `~/lib/orchestrator/signals/analyze-turn-signals.ts`.
    return NULL_RESOLUTION;
  }
};

/**
 * Resolves a comparison-shaped message to TWO distinct, resolvable product entities, or `null` when
 * the message is not a validated two-product comparison — either because it does not use comparison
 * phrasing, one (or both) candidate names does not resolve to a real product line, or both
 * candidates resolve to the SAME product line (not a genuine two-product comparison; a single-query
 * retrieval already covers that case). This is the regression guard for single-product questions
 * that happen to contain the word "or": they only reach this function's detection step, never its
 * fan-out, because at most one side resolves.
 */
export async function resolveComparisonEntities(
  userMessage: string,
  resolve: ResolveProductEntity = defaultResolve,
): Promise<[ComparisonEntity, ComparisonEntity] | null> {
  const candidates = extractComparisonCandidates(userMessage);
  if (!candidates) {
    return null;
  }

  const [nameA, nameB] = candidates;
  const [resA, resB] = await Promise.all([resolve(nameA), resolve(nameB)]);

  if (!resA.productLineKey || !resB.productLineKey) {
    return null;
  }
  if (resA.productLineKey === resB.productLineKey) {
    return null;
  }

  return [
    { name: nameA, productLineKey: resA.productLineKey, productKey: resA.productKey, resolutionSource: resA.resolutionSource },
    { name: nameB, productLineKey: resB.productLineKey, productKey: resB.productKey, resolutionSource: resB.resolutionSource },
  ];
}

export type ComparisonExecuteToolFn = (input: {
  name: string;
  argumentsJson: string;
  callId: string;
  speculative?: boolean;
  /**
   * Forces `search_product_docs` to resolve THIS product line rather than whatever this call's own
   * `productName` argument would resolve to on its own — see `ProductToolTurnOptions.productLineLock`
   * in `~/lib/tools/product-tools.ts`. Without this, a B0-786 signals-derived lock already in effect
   * for the turn (`speculativeProductLineLock`) would apply to BOTH scoped calls and collapse the
   * fan-out back into a single product.
   */
  productLineLockOverride?: { productLineKey: string; resolutionSource: ProductEntityResolutionSource } | null;
}) => Promise<ExecutedTool>;

export function buildComparisonSearchArgumentsJson(name: string): string {
  return JSON.stringify({ productName: name });
}

export function buildComparisonCallId(runId: string, index: number): string {
  return `comparison-search-${index}-${runId}`;
}

/**
 * Runs ONE `search_product_docs` call per resolved entity, scoped to that entity's product line, so
 * both labels land in `toolOutputLog` / `toolTrace` exactly as a model-requested call would — the
 * evidence summary, validator, and regulated-claim guardrail all read from there.
 */
export async function runComparisonRetrieval(input: {
  entities: [ComparisonEntity, ComparisonEntity];
  runId: string;
  execute: ComparisonExecuteToolFn;
}): Promise<{ results: [ExecutedTool, ExecutedTool] }> {
  const results = (await Promise.all(
    input.entities.map((entity, index) =>
      input.execute({
        name: SPECULATIVE_SEARCH_TOOL_NAME,
        argumentsJson: buildComparisonSearchArgumentsJson(entity.name),
        callId: buildComparisonCallId(input.runId, index),
        speculative: true,
        productLineLockOverride: {
          productLineKey: entity.productLineKey,
          resolutionSource: entity.resolutionSource,
        },
      }),
    ),
  )) as [ExecutedTool, ExecutedTool];

  return { results };
}

/** True when at least one of the two scoped searches actually succeeded. */
export function comparisonRetrievalUsable(results: [ExecutedTool, ExecutedTool]): boolean {
  return results.some((r) => r.trace.ok);
}

/**
 * The combined pre-fetched evidence block for both resolved products — the same
 * `## Retrieved evidence (pre-fetched)` mechanism B0-436 uses for a single search, extended to carry
 * two labelled sections so the model, validator, and guardrail all see both labels.
 */
export function buildComparisonPreloadedEvidence(input: {
  entities: [ComparisonEntity, ComparisonEntity];
  results: [ExecutedTool, ExecutedTool];
}): PreloadedEvidence {
  const label = input.entities
    .map((e) => `${SPECULATIVE_SEARCH_TOOL_NAME}(${buildComparisonSearchArgumentsJson(e.name)})`)
    .join(' + ');

  const text = input.entities
    .map((entity, index) => {
      const result = input.results[index];
      const body = result.modelOutput ?? result.output;
      return `### Retrieval for "${entity.name}"\n\n${body}`;
    })
    .join('\n\n---\n\n');

  return { label, text };
}
