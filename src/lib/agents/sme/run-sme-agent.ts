import type { SmeAgentId, SmeAgentInvokeBody, SmeAgentRunResult } from './types';

const AGENTS: Record<
  SmeAgentId,
  Pick<SmeAgentRunResult, 'label' | 'summary' | 'focusAreas'>
> = {
  product: {
    label: 'Product SME',
    summary:
      'Rough stub for the product specialist: specs, compatibility, positioning, and how SKUs map to customer outcomes.',
    focusAreas: [
      'Product lines, models, and feature comparisons',
      'Technical specs relevant to sales and support',
      'Compatibility, accessories, and upsell paths',
      'RAG-backed answers once wired to `rag` document search',
    ],
  },
  bathroom: {
    label: 'Bathroom SME',
    summary:
      'Rough stub for the bathroom domain: layouts, fixtures, codes-adjacent guidance (non-legal), and project scoping.',
    focusAreas: [
      'Vanity, toilet, shower/tub, and rough-in considerations',
      'Space planning and typical residential workflows',
      'Material/finish vocabulary aligned to your catalog',
      'Hand-off notes for quoting and installation (placeholder)',
    ],
  },
};

function normalizeContext(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
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

  return {
    agent: agentId,
    label: meta.label,
    summary: meta.summary,
    focusAreas: meta.focusAreas,
    query,
    context: normalizeContext(body.context),
    steps: [
      {
        id: 'ingest-query',
        status: 'completed',
        note: query
          ? 'Query received; ready for retrieval + synthesis.'
          : 'No query yet — caller should send { query: string }.',
      },
      {
        id: 'retrieve-domain-knowledge',
        status: 'pending',
        note: 'Wire RAG / internal APIs scoped to this SME.',
      },
      {
        id: 'draft-sme-answer',
        status: 'pending',
        note: 'Add model call with SME system prompt and citations.',
      },
    ],
  };
}
