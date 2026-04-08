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

export function buildProductSupportInstructions(input: {
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

  return [
    'You are Bex product support. Follow the specialist policy below.',
    '',
    routingHintBlock({
      decision: input.routing.decision,
      rationale: input.routing.rationale,
      scores,
    }),
    '',
    '---',
    '',
    PRODUCT_SPECIALIST_SYSTEM_PROMPT,
    '',
    '## Tool and grounding rules',
    '',
    '- Call tools to retrieve approved snippets; never invent usage, compatibility, or safety claims.',
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
