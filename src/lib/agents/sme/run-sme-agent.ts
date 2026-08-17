import { BATHROOM_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/bathroom-specialist/bathroom-specialist-system-prompt';
import { DILUTION_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/dilution-specialist/dilution-specialist-system-prompt';
import { FLOOR_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-specialist-system-prompt';
import { PRODUCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/product-specialist/product-specialist-system-prompt';
import { RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/recommendations-specialist/recommendations-specialist-system-prompt';
import { runBexChatTurn } from '~/lib/bex/run-chat-turn';
import type { ProductSupportOutcome } from '~/lib/orchestrator/orchestrator-schemas';

import type {
  SmeAgentId,
  SmeAgentInvokeBody,
  SmeAgentRunResult,
} from './types';

/**
 * B0-520/521/522/523 — agents wired to the real `runProductSupportWorkflow` (via
 * `runBexChatTurn`, forced to that agent's `agentMode`) instead of the `runSmeAgent`
 * placeholder. `recommendations` is intentionally out of scope for this set — it is already
 * fully built via its own tool (`lookup_cross_reference` + web-search recommendation engine),
 * not through this forced-routing mechanism.
 */
const REAL_WORKFLOW_AGENT_IDS = ['product', 'dilution', 'floor', 'bathroom'] as const;
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
  floor: {
    label: 'Floor Care Specialist',
    summary:
      'Floor maintenance programs: stripping, finishing, burnishing, recoating — procedural guidance with Betco-approved methods.',
    focusAreas: [
      'Stripping, finishing, burnishing, and scrub-and-recoat workflows',
      'Coat counts, equipment, and safety notes from approved procedures',
      'Hand back to Product Specialist for pure SKU/SDS fact questions when appropriate',
    ],
    systemPrompt: FLOOR_SPECIALIST_SYSTEM_PROMPT,
    sessionContextGuide: [
      '`floorType` — e.g. VCT, terrazzo, concrete (if known).',
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
      'Recommends the Betco equivalent for a competitor product via the cross-reference lookup and (when available) the web-search-grounded recommendation engine; answers only above 0.80 confidence, otherwise defers to a Betco sales representative.',
    focusAreas: [
      'Competitor product → Betco equivalent cross-reference (many-to-many; may offer more than one match)',
      'Fallback to capability-based search when no cross-reference row exists',
      'Confidence gating at 0.80 with a graceful decline to a sales representative',
      'Grounded only: never invent product names, SKUs, EPA numbers, dilution, or claims',
    ],
    systemPrompt: RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT,
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
 * B0-520/521/522/523 — runs the real specialist (`product`, `dilution`, `floor`, `bathroom`)
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
 * Placeholder SME run: validates input and returns a stable shape the orchestrator
 * can merge into real tool + LLM steps later. Still used for `recommendations` (out of
 * scope for B0-520/521/522/523 — see the Confluence source doc) and for any real-workflow
 * agent called with no query.
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
    if (agentId === 'floor' && typeof ft === 'string' && ft.trim()) {
      parts.push(`floorType: ${ft.trim()}`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  })();

  const ingestNote = (() => {
    if (!query) {
      return 'No query yet — caller should send { query: string }.';
    }
    if (sessionNote) {
      return `Query received; session context: ${sessionNote}. Ready for retrieval + synthesis.`;
    }
    return 'Query received; ready for retrieval + synthesis.';
  })();

  if (query && isRealWorkflowAgent(agentId)) {
    return runRealSmeAgentAnswer(agentId, meta, query, context, sessionNote);
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
          if (agentId === 'floor') {
            return 'Wire floor-care SOPs, finish/stripper bulletins, and procedural RAG scoped to maintenance programs.';
          }
          if (agentId === 'recommendations') {
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
