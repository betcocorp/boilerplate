import { BATHROOM_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/bathroom-specialist/bathroom-specialist-system-prompt';
import { CROSS_REFERENCE_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/cross-reference-specialist/cross-reference-specialist-system-prompt';
import { DILUTION_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/dilution-specialist/dilution-specialist-system-prompt';
import { FLOOR_CONCRETE_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-concrete-specialist-system-prompt';
import { FLOOR_STG_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-stg-specialist-system-prompt';
import { FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-vct-specialist-system-prompt';
import { FLOOR_WOOD_SPORT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-wood-sport-specialist-system-prompt';
import { PRODUCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/product-specialist/product-specialist-system-prompt';
import { RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/recommendations-specialist/recommendations-specialist-system-prompt';
import { runBexChatTurn } from '~/lib/bex/run-chat-turn';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import type { ProductSupportOutcome } from '~/lib/orchestrator/orchestrator-schemas';
import { XREF_DECLINE_COPY, resolveXrefThreshold } from '~/lib/recommendations/confidence-scoring';
import {
  extractCompetitorProduct,
  isCompetitorIdentityUnresolved,
} from '~/lib/recommendations/extract-competitor-product';
import { runCrossReferenceRecommendation } from '~/lib/recommendations/persist-recommendation';
import { buildWebFallbackAnswer } from '~/lib/recommendations/web-fallback-answer';

import type {
  SmeAgentId,
  SmeAgentInvokeBody,
  SmeAgentRunResult,
} from './types';

/**
 * B0-779 — the decline used when the query names no resolvable competitor brand/product at all
 * (`extractCompetitorProduct` came back with neither). Returned WITHOUT ever calling
 * `runCrossReferenceRecommendation` — there is no competitor identity to look up, and calling the
 * engine on the raw query text is exactly what fabricated "Comparable Betco product" matches in
 * PRO-045/PRO-036. Never persisted: an attempt that never ran isn't a recommendation outcome.
 */
async function unresolvedCompetitorDecline(): Promise<
  Awaited<ReturnType<typeof runCrossReferenceRecommendation>>
> {
  return {
    source: 'web',
    answered: false,
    status: 'declined',
    overallConfidence: 0,
    // B0-795: the threshold now comes from the settings table, so resolving it is async.
    thresholdUsed: await resolveXrefThreshold(),
    candidates: [],
    evidence: { source: 'web', reason: 'competitor_identity_unresolved' },
    declineReason: XREF_DECLINE_COPY,
    recommendationId: null,
  };
}

/**
 * B0-520/521/522/523 — agents wired to the real `runProductSupportWorkflow` (via
 * `runBexChatTurn`, forced to that agent's `agentMode`) instead of the `runSmeAgent`
 * placeholder.
 *
 * B0-663 — `recommendations` was previously excluded here because it was (nominally) built via
 * its own tool/engine rather than this forced-routing mechanism; in practice its HTTP route was
 * always a placeholder. `recommendations` now means job/problem-driven product recommendation
 * (no competitor named), which runs through the same RAG/catalog tool loop as `product`/
 * `dilution`/the four floor specialists/`bathroom`, so it is wired in here like them. Competitor cross-reference
 * moved to the new `cross_reference` agent, which does NOT go through this real-workflow chat
 * loop — see `runCrossReferenceSmeAgentAnswer` below.
 */
const REAL_WORKFLOW_AGENT_IDS = [
  'product',
  'dilution',
  'floor_wood_sport',
  'floor_concrete',
  'floor_stg',
  'floor_vct',
  'bathroom',
  'recommendations',
] as const;
type RealWorkflowAgentId = (typeof REAL_WORKFLOW_AGENT_IDS)[number];

function isRealWorkflowAgent(agentId: SmeAgentId): agentId is RealWorkflowAgentId {
  return (REAL_WORKFLOW_AGENT_IDS as readonly string[]).includes(agentId);
}

/** Keys callers can send in `context` for restroom-care routing (session memory). */
export const BATHROOM_AGENT_CONTEXT_KEYS = [
  'facilityType',
  'primarySurfaces',
  'issueOrTask',
] as const;

type AgentMeta = {
  label: string;
  summary: string;
  focusAreas: string[];
  systemPrompt: string;
  sessionContextGuide: string[];
};

const AGENTS: Record<SmeAgentId, AgentMeta> = {
  product: {
    label: 'Betco Product Specialist',
    summary:
      'Authoritative Betco product facts: features, SDS safety (non-medical), compatibility, catalogs, and label-faithful dilution summaries — with handoffs to Dilution and Floor specialists when required.',
    focusAreas: [
      'Product identity, packaging, RTU vs concentrate, and comparisons between Betco SKUs',
      'SDS facts: hazards, PPE, first aid, handling, environmental notes (from approved documents)',
      'Dwell times, efficacy claims, and use surfaces when documented',
      'Filter-style questions: return matching products/lists from structured data or RAG (avoid "best" rankings without data)',
      'Decline or escalate: pricing, stock, legal/regulatory interpretation, unsafe mixing, off-label use',
    ],
    systemPrompt: PRODUCT_SPECIALIST_SYSTEM_PROMPT,
    sessionContextGuide: [
      '`referencedProduct` — product name or SKU the user is asking about (session memory).',
      '`surfaceOrEnvironment` — e.g. sealed floor, stainless, food contact area, when it disambiguates.',
    ],
  },
  dilution: {
    label: 'Dilution Control Specialist',
    summary:
      'Dispenser calibration, proportioning systems, metering tips, and exact on-site setup grounded in Betco equipment and label charts.',
    focusAreas: [
      'Dispenser and dilution control hardware setup',
      'Metering tips, charts, and proportioner configuration',
      'Escalation when documentation is missing — no guessing',
    ],
    systemPrompt: DILUTION_SPECIALIST_SYSTEM_PROMPT,
    sessionContextGuide: [
      '`dispenserModel` — equipment name if known.',
      '`productSkuOrName` — chemical tied to the dispenser.',
    ],
  },
  floor_wood_sport: {
    label: 'Wood/Sport Floor Care Specialist',
    summary:
      'Wood (hardwood) sport/gym floor finish and coating: recoating programs and daily/interim maintenance, using Betco-approved methods.',
    focusAreas: [
      'Wood/hardwood sport and gym floor finish and coating procedures',
      'Coat counts, equipment, and safety notes from approved procedures',
      'Hand back to Product Specialist for pure SKU/SDS fact questions when appropriate',
    ],
    systemPrompt: FLOOR_WOOD_SPORT_SPECIALIST_SYSTEM_PROMPT,
    sessionContextGuide: [
      '`programGoal` — recoat, daily maintenance, high-gloss burnish.',
    ],
  },
  floor_concrete: {
    label: 'Concrete Floor Care Specialist',
    summary:
      'Concrete floor cleaning, densifying, sealing, coating, stripping, and scrubbing — procedural guidance with Betco-approved methods.',
    focusAreas: [
      'Concrete sealing, coating, densifying, stripping, and scrubbing workflows',
      'Coat counts, equipment, and safety notes from approved procedures',
      'Hand back to Product Specialist for pure SKU/SDS fact questions when appropriate',
    ],
    systemPrompt: FLOOR_CONCRETE_SPECIALIST_SYSTEM_PROMPT,
    sessionContextGuide: [
      '`programGoal` — seal, coat, densify, strip, daily maintenance.',
    ],
  },
  floor_stg: {
    label: 'Stone, Tile & Grout Specialist',
    summary:
      'Cleaning and protecting natural stone, tile, and grout surfaces (STG Cleaner and Protectant line), using Betco-approved methods.',
    focusAreas: [
      'Daily/periodic cleaning and protectant application for stone, tile, and grout',
      'Reapplication schedules and safety notes from approved procedures',
      'Hand back to Product Specialist for pure SKU/SDS fact questions when appropriate',
    ],
    systemPrompt: FLOOR_STG_SPECIALIST_SYSTEM_PROMPT,
    sessionContextGuide: [
      '`surfaceType` — e.g. natural stone, ceramic/porcelain tile, grout (if known).',
    ],
  },
  floor_vct: {
    label: 'VCT & Resilient Tile Floor Care Specialist',
    summary:
      'VCT, terrazzo, and resilient/hard tile floor maintenance programs: stripping, finishing, burnishing, recoating — procedural guidance with Betco-approved methods.',
    focusAreas: [
      'Stripping, finishing, burnishing, and scrub-and-recoat workflows',
      'Coat counts, equipment, and safety notes from approved procedures',
      'Hand back to Product Specialist for pure SKU/SDS fact questions when appropriate',
    ],
    systemPrompt: FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT,
    sessionContextGuide: [
      '`floorType` — e.g. VCT, terrazzo (if known).',
      '`programGoal` — strip, recoat, daily maintenance, high-gloss burnish.',
    ],
  },
  bathroom: {
    label: 'Bathroom specialist',
    summary:
      'Restroom and bathroom cleaning, disinfection, odor control, floor care, and compliance using Betco products, dilutions, equipment, and SOPs.',
    focusAreas: [
      'Product recommendation by soil, surface, facility type, and issue (odor, scale, bacteria, stains)',
      'Procedure guidance: daily clean, deep clean, descaling, disinfection—with dwell time and safety notes',
      'Compliance and safety advisory: PPE, hazards, label-faithful use (not legal or medical advice)',
      'Troubleshooting odor, scale, soil, and slip resistance with Betco-aligned fixes',
    ],
    systemPrompt: BATHROOM_SPECIALIST_SYSTEM_PROMPT,
    sessionContextGuide: [
      '`facilityType` — e.g. school, healthcare, hospitality, industrial, office (session memory).',
      '`primarySurfaces` — e.g. porcelain, stainless, stone, resilient flooring, partitions.',
      '`issueOrTask` — e.g. daily clean, deep clean, descale, disinfect, odor, urine scale.',
    ],
  },
  recommendations: {
    label: 'Product Recommendations Specialist',
    summary:
      'Job/problem-driven product recommendation across categories, when no competitor product is named and the ask doesn\'t belong to a specific domain specialist (bathroom/dilution/floor); finds the single best-fit Betco product from the catalog/RAG tools.',
    focusAreas: [
      'Job/problem-driven best-fit product selection (no competitor named)',
      'Uses the existing product catalog/RAG tools (search_product_docs, find_products_by_category, get_products_in_category, get_product_category, get_product_spec) — no bespoke retrieval engine',
      'Always presents exactly 1 primary best-fit pick, plus up to 2 alternatives (e.g. lower-cost or lighter-duty) only when there is a genuine reason to offer them',
      'Confidence gating at 0.80 with a graceful decline to a sales representative',
      'Grounded only: never invent product names, SKUs, or claims not in retrieved Betco data',
    ],
    systemPrompt: RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT,
    sessionContextGuide: [
      '`taskDescription` — the job or problem the user described.',
      '`facilityType` — if known, helps narrow category.',
    ],
  },
  cross_reference: {
    label: 'Cross-Reference Specialist',
    summary:
      'Recommends the Betco equivalent for a competitor product via the cross-reference lookup and (when available) the web-search-grounded recommendation engine; answers only above 0.80 confidence, otherwise defers to a Betco sales representative.',
    focusAreas: [
      'Competitor product → Betco equivalent cross-reference (many-to-many; may offer more than one match)',
      'Fallback to capability-based search when no cross-reference row exists',
      'Confidence gating at 0.80 with a graceful decline to a sales representative',
      'Grounded only: never invent product names, SKUs, EPA numbers, dilution, or claims',
    ],
    systemPrompt: CROSS_REFERENCE_SPECIALIST_SYSTEM_PROMPT,
    sessionContextGuide: [
      '`competitorBrand` — competitor company/brand (optional but strongly preferred; missing lowers confidence).',
      '`competitorProduct` — competitor product name or SKU the user wants a Betco equivalent for.',
    ],
  },
};

function normalizeContext(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function bathroomContextSummary(
  ctx: Record<string, unknown> | null,
): string | null {
  if (!ctx) {
    return null;
  }

  const parts: string[] = [];

  for (const key of BATHROOM_AGENT_CONTEXT_KEYS) {
    const raw = ctx[key];
    if (typeof raw === 'string' && raw.trim()) {
      parts.push(`${key}: ${raw.trim()}`);
    }
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * B0-520/521/522/523 — runs the real specialist (`product`, `dilution`, one of the four floor
 * specialists, `bathroom`)
 * through `runProductSupportWorkflow`, forced to this agent's mode via `runBexChatTurn` —
 * the exact mechanism the Bex chat UI uses for `agentMode !== 'orchestrator'` direct routing
 * (see `run-chat-turn.ts`, `run-orchestration.ts`'s `bex-chat` workflow, and
 * `src/lib/tests/runner.ts`, which all funnel through this one entry point).
 *
 * Each `/api/v1/agents/*` call is a stateless, single-turn invocation from an external API
 * client (no `conversationId` in the request contract — see `sme-schemas.ts`), so a fresh
 * conversation is created per call and attributed to no end user, matching the eval-harness
 * convention (`owner: { kind: 'system' }`). `source: 'orchestrator_api'` is reused rather than
 * adding a new `run_source` value — these are, like `/api/v1/orchestrator`, token-authenticated
 * server-to-server v1 callers, and the `workflow_runs.source` column has a DB CHECK constraint
 * that would need its own migration to grow (out of scope for this wiring change).
 *
 * The caller's optional `context` (e.g. `dispenserModel`, `floorType`) isn't part of
 * `runProductSupportWorkflow`'s input contract, so rather than silently dropping it now that
 * this is a real model call, it is folded into the message sent to the workflow as a
 * "Session context" hint.
 */
async function runRealSmeAgentAnswer(
  agentId: RealWorkflowAgentId,
  meta: AgentMeta,
  query: string,
  context: Record<string, unknown> | null,
  sessionNote: string | null,
): Promise<SmeAgentRunResult> {
  const ingestNote = sessionNote
    ? `Query received; session context: ${sessionNote}. Ready for retrieval + synthesis.`
    : 'Query received; ready for retrieval + synthesis.';

  const messageForWorkflow = sessionNote
    ? `${query}\n\n(Session context — ${sessionNote})`
    : query;

  const outcome = await runBexChatTurn({
    conversationId: null,
    message: messageForWorkflow,
    // B0-416 — this path is only reachable through a token-authenticated `/api/v1/agents/*`
    // route (server-to-server); see the module doc comment above for why this reuses
    // 'orchestrator_api' rather than adding a new source.
    source: 'orchestrator_api',
    agentMode: agentId,
    useValidator: false,
    owner: { kind: 'system' },
  });

  const answer: ProductSupportOutcome = {
    answerText: outcome.answerText,
    conversationId: outcome.conversationId,
    workflowRunId: outcome.workflowRunId,
    latestOpenaiResponseId: outcome.latestOpenaiResponseId,
    traceId: outcome.traceId,
    sources: outcome.sources,
    confidence: outcome.confidence,
    validation: outcome.validation,
    routingDecision: outcome.routingDecision,
    usage: outcome.usage,
    promptVersion: outcome.promptVersion,
    promptBundleVersion: outcome.promptBundleVersion,
    answerProvenance: outcome.answerProvenance,
    priorMessageCount: outcome.priorMessageCount,
    previousResponseId: outcome.previousResponseId,
    // B0-491 — the answering agent's own self-reported confidence, distinct from `confidence`.
    agentConfidence: outcome.agentConfidence,
    agentConfidenceBasis: outcome.agentConfidenceBasis,
    agentConfidenceReason: outcome.agentConfidenceReason,
  };

  return {
    agent: agentId,
    label: meta.label,
    summary: meta.summary,
    focusAreas: meta.focusAreas,
    systemPrompt: meta.systemPrompt,
    sessionContextGuide: meta.sessionContextGuide,
    query,
    context,
    steps: [
      {
        id: 'ingest-query',
        status: 'completed',
        note: ingestNote,
      },
      {
        id: 'retrieve-domain-knowledge',
        status: 'completed',
        note: `Ran the ${meta.label} via runProductSupportWorkflow forced to \`${agentId}\` routing (workflow run ${outcome.workflowRunId}); tool calls retrieved grounded Betco data — see \`answer.sources\`.`,
      },
      {
        id: 'draft-sme-answer',
        status: 'completed',
        note: `Answer drafted${
          typeof outcome.confidence === 'number'
            ? ` with confidence ${outcome.confidence}`
            : ''
        }; validator approved=${outcome.validation.approved}${
          outcome.validation.requires_human_review ? ' (flagged for human review)' : ''
        }.`,
      },
    ],
    answer,
  };
}

/**
 * B0-663 — competitor cross-reference SME answer. Unlike `runRealSmeAgentAnswer` (the generic
 * RAG/tool chat loop `product`/`dilution`/the four floor specialists/`bathroom`/`recommendations`
 * all share), this
 * agent is driven directly by the dedicated `recommendCrossReference()` engine (legacy lookup +
 * web-grounded fallback + validator gate) via `runCrossReferenceRecommendation` — the same engine
 * the orchestrator's `recommend_cross_reference` tool and the deterministic workflow-level
 * cross-reference fallback call — so it never runs a model chat loop of its own.
 *
 * Resolves the competitor brand/product from `context` (`competitorBrand`/`competitorProduct`,
 * per this agent's `sessionContextGuide`) when the caller supplied them; otherwise falls back to
 * `extractCompetitorProduct` on the raw query text.
 *
 * This path creates no conversation/workflow_run row (there is no chat turn), so `conversationId`
 * and `workflowRunId` are synthetic UUIDs and `latestOpenaiResponseId` is a synthetic
 * `cross-reference:<traceId>` marker — the same "no real OpenAI response id" idea the AI SDK
 * generation runtime uses (`ai_sdk:<runId>`) for its own non-Responses-API path.
 */
async function runCrossReferenceSmeAgentAnswer(
  meta: AgentMeta,
  query: string,
  context: Record<string, unknown> | null,
): Promise<SmeAgentRunResult> {
  const traceId = newCorrelationId();

  const contextProductRaw = context?.competitorProduct;
  const contextBrandRaw = context?.competitorBrand;
  const contextProduct =
    typeof contextProductRaw === 'string' && contextProductRaw.trim() ? contextProductRaw.trim() : null;

  let resolvedBrand: string | null;
  let resolvedProduct: string;
  let extractNote: string;
  // B0-779 — set only on the extraction branch below; session-context-supplied identity is treated
  // as caller-confirmed and never subject to this guard.
  let identityUnresolved = false;

  if (contextProduct) {
    resolvedBrand =
      typeof contextBrandRaw === 'string' && contextBrandRaw.trim() ? contextBrandRaw.trim() : null;
    resolvedProduct = contextProduct;
    extractNote = 'Competitor brand/product resolved from session context.';
  } else {
    const extracted = await extractCompetitorProduct(query);
    resolvedBrand = extracted.brand;
    resolvedProduct = extracted.product;
    identityUnresolved = isCompetitorIdentityUnresolved(extracted);
    extractNote = identityUnresolved
      ? 'No competitor brand or product could be confidently identified in the query text; declining rather than matching on the raw query (B0-779).'
      : `Competitor brand/product extracted from the query text (brand: ${extracted.brand ?? 'unknown'}).`;
  }

  /**
   * B0-779 — never call the engine (or persist an attempt) on an unresolved competitor identity:
   * `resolvedProduct` would otherwise be standing in for the raw query text, which is exactly the
   * PRO-045/PRO-036 shape that fabricated a "Comparable Betco product" match.
   */
  const result = identityUnresolved
    ? await unresolvedCompetitorDecline()
    : await runCrossReferenceRecommendation(
        { competitorProduct: resolvedProduct, competitorBrand: resolvedBrand },
        { traceId },
      );

  const competitorLabel =
    [resolvedBrand, resolvedProduct].filter(Boolean).join(' ').trim() || resolvedProduct;
  const { answerText } = buildWebFallbackAnswer({ result, competitorLabel });

  const answer: ProductSupportOutcome = {
    answerText,
    conversationId: newCorrelationId(),
    workflowRunId: newCorrelationId(),
    latestOpenaiResponseId: `cross-reference:${traceId}`,
    traceId,
    sources: [],
    confidence: result.overallConfidence,
    validation: {
      approved: result.answered,
      confidence: result.overallConfidence,
      issues: [],
      requires_human_review: result.status === 'escalated',
    },
    routingDecision: 'cross_reference',
    priorMessageCount: 0,
    previousResponseId: null,
    agentConfidence: null,
    agentConfidenceBasis: null,
  };

  return {
    agent: 'cross_reference',
    label: meta.label,
    summary: meta.summary,
    focusAreas: meta.focusAreas,
    systemPrompt: meta.systemPrompt,
    sessionContextGuide: meta.sessionContextGuide,
    query,
    context,
    steps: [
      {
        id: 'ingest-query',
        status: 'completed',
        note: `Query received; ${extractNote}`,
      },
      {
        id: 'retrieve-domain-knowledge',
        status: 'completed',
        note: `Ran recommendCrossReference (source: ${result.source}); ${result.candidates.length} grounded candidate(s) considered.`,
      },
      {
        id: 'draft-sme-answer',
        status: 'completed',
        note: `Answer drafted with confidence ${result.overallConfidence} (threshold ${result.thresholdUsed}); status=${result.status}${
          result.status === 'escalated' ? ' (flagged for human review)' : ''
        }.`,
      },
    ],
    answer,
  };
}

/**
 * Entry point for every `/api/v1/agents/{id}` route.
 *
 * B0-352/B0-746 — all nine agent ids dispatch to a REAL answer path: `product`, `dilution`,
 * `floor_wood_sport`, `floor_concrete`, `floor_stg`, `floor_vct`,
 * `bathroom` and `recommendations` run the product-support workflow forced to that specialist
 * (`runRealSmeAgentAnswer`, B0-520/521/522/523/663) and `cross_reference` runs the dedicated
 * cross-reference engine (`runCrossReferenceSmeAgentAnswer`, B0-663). None of them is a stub.
 *
 * The `pending`-steps payload at the bottom is the ONLY placeholder left, and it is unreachable
 * over HTTP: `smeAgentHttpInvokeSchema` rejects an absent/blank `query` with a 400 before this
 * function is called, so the empty-query branch can only be hit by a direct in-process call. It is
 * kept as a defensive default (this function's return type has no "no answer" variant), not as a
 * feature — see the `/api/v1/agents/*` section of `AGENTS.md` for the decision.
 */
export async function runSmeAgent(
  agentId: SmeAgentId,
  body: SmeAgentInvokeBody,
): Promise<SmeAgentRunResult> {
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  const meta = AGENTS[agentId];
  const context = normalizeContext(body.context);

  const sessionNote = (() => {
    if (agentId === 'bathroom') {
      return bathroomContextSummary(context);
    }
    if (!context) {
      return null;
    }
    const rp = context.referencedProduct;
    const dm = context.dispenserModel;
    const ft = context.floorType;
    const parts: string[] = [];
    if (agentId === 'product' && typeof rp === 'string' && rp.trim()) {
      parts.push(`referencedProduct: ${rp.trim()}`);
    }
    if (agentId === 'dilution') {
      if (typeof dm === 'string' && dm.trim()) {
        parts.push(`dispenserModel: ${dm.trim()}`);
      }
      const pn = context.productSkuOrName;
      if (typeof pn === 'string' && pn.trim()) {
        parts.push(`productSkuOrName: ${pn.trim()}`);
      }
    }
    if (
      (agentId === 'floor_vct' || agentId === 'floor_wood_sport') &&
      typeof ft === 'string' &&
      ft.trim()
    ) {
      parts.push(`floorType: ${ft.trim()}`);
    }
    if (agentId === 'recommendations') {
      const td = context.taskDescription;
      const recFacility = context.facilityType;
      if (typeof td === 'string' && td.trim()) {
        parts.push(`taskDescription: ${td.trim()}`);
      }
      if (typeof recFacility === 'string' && recFacility.trim()) {
        parts.push(`facilityType: ${recFacility.trim()}`);
      }
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  })();

  const ingestNote = (() => {
    if (!query) {
      // B0-352 — unreachable over HTTP (the route 400s on a blank query). If it ever surfaces,
      // it must be unmistakable that this is a placeholder payload and not a real agent answer.
      return 'PLACEHOLDER RESPONSE — no answer was produced. No query yet: caller should send { query: string }.';
    }
    if (sessionNote) {
      return `Query received; session context: ${sessionNote}. Ready for retrieval + synthesis.`;
    }
    return 'Query received; ready for retrieval + synthesis.';
  })();

  if (query && isRealWorkflowAgent(agentId)) {
    return runRealSmeAgentAnswer(agentId, meta, query, context, sessionNote);
  }

  if (query && agentId === 'cross_reference') {
    return runCrossReferenceSmeAgentAnswer(meta, query, context);
  }

  return {
    agent: agentId,
    label: meta.label,
    summary: meta.summary,
    focusAreas: meta.focusAreas,
    systemPrompt: meta.systemPrompt,
    sessionContextGuide: meta.sessionContextGuide,
    query,
    context,
    steps: [
      {
        id: 'ingest-query',
        status: 'completed',
        note: ingestNote,
      },
      {
        id: 'retrieve-domain-knowledge',
        status: 'pending',
        note: (() => {
          if (agentId === 'bathroom') {
            return 'Wire RAG / product DB / restroom SOPs + SDS read paths scoped to restroom care.';
          }
          if (agentId === 'product') {
            return 'Wire Supabase products table, SDS retrieval, and RAG over approved Betco docs; cite sources in answers.';
          }
          if (agentId === 'dilution') {
            return 'Wire dilution control charts, equipment manuals, and labeled setup data; no fabricated ratios.';
          }
          if (
            agentId === 'floor_wood_sport' ||
            agentId === 'floor_concrete' ||
            agentId === 'floor_stg' ||
            agentId === 'floor_vct'
          ) {
            return 'Wire floor-care SOPs, finish/stripper bulletins, and procedural RAG scoped to this substrate\'s maintenance programs.';
          }
          if (agentId === 'recommendations') {
            return 'Wire the product catalog/RAG tools (search_product_docs, find_products_by_category, get_products_in_category, get_product_category, get_product_spec) to identify the job/problem and select the single best-fit Betco product; enforce the 0.80 confidence gate before naming a product.';
          }
          if (agentId === 'cross_reference') {
            return 'Wire `lookup_cross_reference` first, then the web-search-grounded recommendation engine (Jira B0-77) and RAG fallback; enforce the 0.80 confidence gate before naming a product.';
          }
          return 'Wire RAG / internal APIs scoped to this SME.';
        })(),
      },
      {
        id: 'draft-sme-answer',
        status: 'pending',
        note: 'Add model call with SME system prompt, citations, and confidence gating (≥0.8 or escalate).',
      },
    ],
  };
}
