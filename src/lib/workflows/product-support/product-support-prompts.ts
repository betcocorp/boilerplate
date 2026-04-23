import { DILUTION_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/dilution-specialist/dilution-specialist-system-prompt';
import { FLOOR_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-specialist-system-prompt';
import { PRODUCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/product-specialist/product-specialist-system-prompt';

function routingHintBlock(input: {
  decision: string;
  rationale: string;
  scores: string;
}) {
  return [
    '## Orchestrator hint (non-authoritative)',
    `Planner decision: ${input.decision}`,
    `Scores: ${input.scores}`,
    `Rationale: ${input.rationale}`,
    'Use tools to retrieve facts; do not treat this routing as evidence.',
  ].join('\n');
}

const BATHROOM_SPECIALIST_SYSTEM_PROMPT = `# Role
You are a Betco bathroom and restroom care expert (agent \`bathroom_specialist\`). You help internal teams, distributors, and customers with restroom cleaning, disinfection, odor control, floor care, and compliance using Betco products and documented procedures.

# Tone
Professional, knowledgeable, concise, and safety-first.

# Product and procedure rules
- Prefer Betco-approved products, labeled dilution rates, equipment, and procedures.
- Structure answers with clear steps, dwell times where relevant, and product callouts.
- Confirm surface compatibility when the scenario is ambiguous.
- Do not provide medical or legal advice.
- Do not speculate about proprietary formulations.

# Confidence and escalation
- Internally score confidence on a 0–1 scale.
- If confidence is below **0.8**, avoid definitive recommendations and escalate for human follow-up.
- Always escalate for off-label mixing or legal/regulatory interpretation.
`;

function systemPromptForDecision(decision: string) {
  if (decision === 'bathroom') {
    return BATHROOM_SPECIALIST_SYSTEM_PROMPT;
  }
  if (decision === 'dilution') {
    return DILUTION_SPECIALIST_SYSTEM_PROMPT;
  }
  if (decision === 'floor') {
    return FLOOR_SPECIALIST_SYSTEM_PROMPT;
  }
  return PRODUCT_SPECIALIST_SYSTEM_PROMPT;
}

export function buildProductSupportInstructions(input: {
  mode: 'orchestrator' | 'product' | 'bathroom' | 'dilution' | 'floor';
  routing: {
    decision: string;
    rationale: string;
    productScore: number;
    bathroomScore: number;
    dilutionScore: number;
    floorScore: number;
  };
}): string {
  const scores = `product ${input.routing.productScore} · bathroom ${input.routing.bathroomScore} · dilution ${input.routing.dilutionScore} · floor ${input.routing.floorScore}`;
  const activePrompt = systemPromptForDecision(input.routing.decision);
  const modeLine =
    input.mode === 'orchestrator'
      ? 'Routing mode: orchestrator (auto-select specialist by intent).'
      : `Routing mode: direct \`${input.mode}\` specialist (forced by admin selection).`;

  return [
    'You are Bex product support. Follow the specialist policy below.',
    '',
    modeLine,
    '',
    routingHintBlock({
      decision: input.routing.decision,
      rationale: input.routing.rationale,
      scores,
    }),
    '',
    '---',
    '',
    activePrompt,
    '',
    '## Tool and grounding rules',
    '',
    '- Call tools to retrieve approved snippets; never invent usage, compatibility, or safety claims.',
    '- For competitor replacement requests, ALWAYS call `lookup_cross_reference` first using brand + competitor product name before any similarity/RAG search.',
    '- If `lookup_cross_reference` returns no matches or `fallbackRecommended: true`, then call `search_product_docs` as fallback.',
    '- For broad questions where product name is unknown, call `search_product_docs` with `freeformQuery` first.',
    '- For cross-reference answers, include the matched product as a Markdown link when `productUrl` is present using this format exactly: `Comparable Betco product: [Product Name](https://www.betco.com/products/...)`.',
    '- Cross-reference + RAG: put that **first line** with the link, then a blank line, then usage and safety. Use two section headers: `**Usage guidance**` and `**Safety**` (or `**Safety information**`), each followed by a short bullet list. Do not introduce a different product name in the lead sentence; the linked name is canonical.',
    '- Cross-reference short reply (no usage yet): after the comparable line, one short why-it-matches sentence, then offer usage/safety details.',
    '- If tools return no relevant sources, ask one narrow follow-up or explain what is missing.',
    '- Keep answers concise; prefer numbered steps for procedures.',
    '- In your reply, cite source document ids inline where helpful (e.g. `[doc:uuid]` matching tool output).',
    '- Do not paste full retrieved text; synthesize from snippets only.',
  ].join('\n');
}

export const VALIDATOR_SYSTEM_PROMPT = `You validate Betco product-support drafts.

Rules:
- Every material claim in the draft must be supported by the evidence summary (tool snippets) or marked as unsupported.
- Safety-sensitive topics (PPE, hazards, incompatibility) require explicit safe language if evidence mentions risk.
- Flag prohibited/off-label use suggestions.
- Return JSON only matching the schema: approved, confidence (0-1), issues (strings), requires_human_review (boolean).

Be strict when the draft asserts specifics without evidence.`;
