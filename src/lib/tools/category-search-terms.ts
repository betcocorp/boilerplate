/**
 * B0-889 / B0-977 — the taxonomy tokens a user's category phrase reduces to.
 *
 * Phrases a user actually types ("glass cleaner", "wood floor stripper", "stripping and finish
 * products") never substring-match the real taxonomy strings, which are truncated/abbreviated legacy
 * category labels (verified live against `rag.document` product_line_profile metadata, 2026-09-08
 * and 2026-09-14): `Gen'l Cleaning - Glass, Surfac`, `Floor Care-Strippers`,
 * `Food Serv-Cleaners, Degreasers`, `Floor Care-Finishes-Resilient` / `Finishes`,
 * `Disinfectants - Concentrates` / `Disinfectants - Ready to use` / `Disinfectant Wipes`,
 * `Floor Care-Sealers` / `Wood Floor - WB Sealers`. Each token below IS present in its taxonomy
 * strings, so `matchesCategory`'s substring check (`category-lookup.ts`) finds them.
 *
 * Pure (no Supabase import) so `fact-tool-enforcement.ts` and the workflow can share it.
 */
const CATEGORY_TERM_RULES: ReadonlyArray<{ pattern: RegExp; term: string }> = [
  { pattern: /glass/i, term: 'glass' },
  // "floor stripper", "wood floor stripper", "stripping", "strippers" — "Floor Care-Strippers".
  { pattern: /strip/i, term: 'stripper' },
  // "degreaser", "kitchen degreaser", "grease" — "Food Serv-Cleaners, Degreasers".
  { pattern: /degreas|grease/i, term: 'degreaser' },
  // "finish", "finishes", "finishing" — "Floor Care-Finishes-Resilient", "Finishes".
  { pattern: /finish/i, term: 'finish' },
  // "disinfectant", "disinfection" — "Disinfectants - …", "Disinfectant Wipes".
  { pattern: /disinfect/i, term: 'disinfect' },
  // "sealer", "sealing" — "Floor Care-Sealers", "Wood Floor - WB Sealers".
  { pattern: /\bseal/i, term: 'sealer' },
];

/**
 * B0-977 — EVERY category token the text names, in order of first appearance, de-duplicated.
 * "what stripping and finish products should I use for my VCT floor?" → `['stripper', 'finish']`.
 * Empty when the text names no known category token.
 */
export function detectCategorySearchTerms(text: string): string[] {
  const hits: Array<{ index: number; term: string }> = [];
  for (const rule of CATEGORY_TERM_RULES) {
    const match = rule.pattern.exec(text);
    if (match && !hits.some((hit) => hit.term === rule.term)) {
      hits.push({ index: match.index, term: rule.term });
    }
  }
  return hits.sort((a, b) => a.index - b.index).map((hit) => hit.term);
}

/**
 * B0-889 — the single token a category phrase reduces to (the FIRST hit in rule order, matching the
 * pre-B0-977 behaviour exactly for glass/stripper/degreaser), or the raw phrase when none matches.
 */
export function normalizeCategorySearchTerm(raw: string): string {
  for (const rule of CATEGORY_TERM_RULES) {
    if (rule.pattern.test(raw)) return rule.term;
  }
  return raw;
}
