/**
 * B0-746 — shared boilerplate for the four floor-care substrate specialists that replaced the
 * single flat `floor` specialist (`floor_wood_sport`, `floor_concrete`, `floor_stg`, `floor_vct`).
 *
 * Per the AGENTS.md B0-352 lesson (the bathroom-prompt duplication saga): a mandatory-retrieval
 * guardrail must never be allowed to silently drift between near-identical copies. The
 * "tool use (mandatory)" clause below is IDENTICAL in structure and intent across all four
 * substrates — only the substrate noun phrase differs — so it lives here ONCE and every
 * substrate prompt calls this function instead of hand-writing its own copy. Everything that is
 * NOT identical across substrates (which products, which procedures, which recurring question
 * types, which decline copy) stays in each specialist's own prompt file and is deliberately NOT
 * factored in here.
 */
export function floorToolUseMandatoryClause(substrateLabel: string): string {
  return `# Tool use (mandatory)

You MUST call at least one retrieval tool before answering any ${substrateLabel} question. Never answer from training knowledge alone — call \`search_product_docs\` or \`get_approved_usage_guidance\` first.

For coat counts, coverage/yield figures, dry and cure times, procedures, and pad or equipment selection, call \`get_floor_asset\` — it searches the approved knowledge corpus only, so what it returns is a documented procedure or chart rather than marketing copy. Transcribe coat counts, coverage figures, dry times, and dilution values exactly as written — never round, convert, or average them — and name the source document. If it returns nothing relevant, say the documented procedure is not on file rather than estimating one.`;
}

/**
 * Shared "closing caveat" line used by all four substrate prompts' Answer shape section — the
 * exact wording never varies by substrate, so it lives here too rather than being retyped four
 * times.
 */
export const FLOOR_LABEL_CAVEAT_LINE =
  '**One caveat**: pre-test an inconspicuous area; confirm the substrate is listed on the label; dry/cure times depend on temperature, humidity, and airflow.';

/**
 * Shared "your product damaged our floor" escalation bullet — identical policy across all four
 * substrates (never offer remediation steps; always escalate to Customer Service).
 */
export const FLOOR_DAMAGE_ESCALATION_LINE =
  '**"Your product damaged our floor/surface"** — Do not offer remediation steps. Escalate the complaint to Betco Customer Service (customerservice@betco.com, 1-888-GO-BETCO) and offer the label facts they will ask for.';
