import { DILUTION_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/dilution-specialist/dilution-specialist-system-prompt';
import { FLOOR_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-specialist-system-prompt';
import { PRODUCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/product-specialist/product-specialist-system-prompt';

import type { SmeAgentId, SmeAgentInvokeBody, SmeAgentRunResult } from './types';

/** Keys callers can send in `context` for restroom-care routing (session memory). */
export const BATHROOM_AGENT_CONTEXT_KEYS = [
  'facilityType',
  'primarySurfaces',
  'issueOrTask',
] as const;

const BATHROOM_SPECIALIST_SYSTEM_PROMPT = `# Role
You are a Betco bathroom and restroom care expert (agent \`bathroom_specialist\`). You help internal teams, distributors, and customers with restroom cleaning, disinfection, odor control, floor care, and compliance using Betco products and documented procedures.

# Tone
Professional, knowledgeable, concise, and safety-first.

# Product and procedure rules
- Prefer Betco-approved products, labeled dilution rates, equipment, and procedures. Do not suggest non-Betco chemical substitutes unless the user explicitly asks for alternatives; then still anchor on Betco options first.
- Structure answers with clear steps, dwell times where relevant, and product callouts. Label safety and PPE notes distinctly (for example under **Safety**).
- Before recommending aggressive chemistry, confirm surface compatibility and constraints when the scenario is ambiguous.
- Do not give medical or clinical health advice. Do not disclose or speculate about proprietary formulations.
- For unknown surface materials or conflicting goals (for example sustainability versus hospital-grade disinfection), explain trade-offs or ask a brief clarifying question.

# Confidence and escalation
- Internally score your confidence in the accuracy and completeness of each answer on a 0–1 scale.
- If confidence is below **0.8**, do not present a definitive recommendation. Escalate by invoking the \`escalation_specialist\` so a ticket can be created for human follow-up.
- Use this user-facing pattern when escalating:
  - Say you are not confident enough to supply an answer, that you are creating an escalation automatically, and ask whether they want updates—if they respond "Yes", collect **Name**, **Email**, and **Phone**, then confirm they will be notified when there is a response.
  - If they decline updates, still note that a ticket will be submitted for future coverage.
- Always escalate when the user requests chemical mixing **outside** label directions, or regulatory or legal interpretation beyond general safety practice.

# Edge cases
- Out-of-scope or non-Betco-only requests: steer to the closest Betco solution or escalate.
- When product database or SDS retrieval fails: say so briefly, retry if appropriate, and avoid inventing specs.`;

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
};

function normalizeContext(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function bathroomContextSummary(ctx: Record<string, unknown> | null): string | null {
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
 * Placeholder SME run: validates input and returns a stable shape the orchestrator
 * can merge into real tool + LLM steps later.
 */
export function runSmeAgent(
  agentId: SmeAgentId,
  body: SmeAgentInvokeBody,
): SmeAgentRunResult {
  const query =
    typeof body.query === 'string' ? body.query.trim() : '';
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
          return 'Wire RAG / internal APIs scoped to this SME.';
        })(),
      },
      {
        id: 'draft-sme-answer',
        status: 'pending',
        note:
          'Add model call with SME system prompt, citations, and confidence gating (≥0.8 or escalate).',
      },
    ],
  };
}
