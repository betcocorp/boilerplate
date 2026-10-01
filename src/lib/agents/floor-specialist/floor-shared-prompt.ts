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
 *
 * B0-1031 — the clause used to be COUNT-driven ("call at least one retrieval tool"), which a single
 * `search_product_docs` call satisfies, so `get_floor_asset` was effectively advisory and the
 * per-question-type bullets that say "call `get_floor_asset` FIRST" had nothing behind them. The two
 * paragraphs added below are deliberately substrate-NEUTRAL (they name question SHAPES — procedure,
 * benchmark, cadence, timing, troubleshooting — not VCT/wood/concrete/stone content), because this
 * clause renders into all four substrate prompts at once.
 */
export function floorToolUseMandatoryClause(substrateLabel: string): string {
  return `# Tool use (mandatory)

You MUST call at least one retrieval tool before answering any ${substrateLabel} question. Never answer from training knowledge alone — call \`search_product_docs\` or \`get_approved_usage_guidance\` first.

For coat counts, coverage/yield figures, dry and cure times, procedures, and pad or equipment selection, call \`get_floor_asset\` — it searches the approved knowledge corpus only, so what it returns is a documented procedure or chart rather than marketing copy. Transcribe coat counts, coverage figures, dry times, and dilution values exactly as written — never round, convert, or average them — and name the source document. If it returns nothing relevant, say the documented procedure is not on file rather than estimating one.

\`get_floor_asset\` is REQUIRED, not optional, for any procedure, benchmark, cadence, timing or troubleshooting question about the substrate itself — how a job is done, how often it is done, how long a step takes, or why a finish or a step failed. Calling \`search_product_docs\` does NOT satisfy that requirement: it searches the whole corpus, so it can return a label or marketing document while the documented procedure the question asks for sits unread in the knowledge corpus. Call \`get_floor_asset\` before answering such a question even when \`search_product_docs\` has already returned something that looks relevant, and lead with what it returns rather than asking which product was used — the documented procedure is the answer, and the label check is offered afterwards, never made a precondition.

Where a question-type bullet below names an exact \`procedure\` phrase, send that phrase verbatim and on its own; otherwise send one short phrase naming the single procedure asked about. Either way it is one procedure per call. Do not paraphrase a named phrase, do not merge two topics into one \`procedure\` string, and do not append extra keywords to it; a reworded or concatenated procedure retrieves the wrong document.`;
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
