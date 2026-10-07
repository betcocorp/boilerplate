/**
 * B0-32 — Labeled query set for the category-vs-semantic routing eval.
 *
 * `expectedPath: 'category'` = a filter/browse query that SHOULD short-circuit to the deterministic
 * taxonomy (B0-29). `expectedPath: 'semantic'` = a usage/safety/recommendation/junk query that should
 * fall through to the embedding pipeline. A few "hard" semantic cases deliberately mention a
 * product-type word (wood, dispenser, all-purpose) to exercise false-positive pressure on the
 * name-containment resolver.
 */

export type RoutingEvalCase = {
  query: string;
  expectedPath: 'category' | 'semantic';
  /** Optional note on why it's labeled this way. */
  note?: string;
};

export const ROUTING_EVAL_DATASET: RoutingEvalCase[] = [
  // --- category-intent (browse / "what do you have") ---
  { query: 'floor strippers', expectedPath: 'category' },
  { query: 'glass cleaner', expectedPath: 'category' },
  { query: 'disinfectants', expectedPath: 'category' },
  { query: 'what degreasers do you have', expectedPath: 'category' },
  { query: 'show me all hand soaps', expectedPath: 'category' },
  { query: 'sanitizers', expectedPath: 'category' },
  { query: 'automatic scrubbers', expectedPath: 'category' },
  { query: 'burnishers', expectedPath: 'category' },
  { query: 'carpet extractors', expectedPath: 'category' },
  { query: 'laundry', expectedPath: 'category' },
  { query: 'warewashing', expectedPath: 'category' },
  { query: 'deodorizers', expectedPath: 'category' },
  { query: 'bowl cleaners', expectedPath: 'category' },
  { query: 'floor sealers', expectedPath: 'category' },
  { query: 'presoak products', expectedPath: 'category' },

  // --- non-category (usage / safety / recommendation / cross-ref / junk) ---
  { query: 'how do I dilute this product', expectedPath: 'semantic' },
  { query: 'what is the contact time for disinfection', expectedPath: 'semantic', note: 'usage, not a category' },
  { query: 'recommend a product for a greasy kitchen', expectedPath: 'semantic' },
  { query: 'what is the Spartan equivalent to BNC-15', expectedPath: 'semantic', note: 'cross-reference' },
  { query: 'give me the safety data sheet for 315', expectedPath: 'semantic' },
  { query: 'what temperature should I run the wash cycle', expectedPath: 'semantic' },
  { query: 'can I mix two cleaners together', expectedPath: 'semantic' },
  { query: 'how long before it starts working', expectedPath: 'semantic' },
  { query: 'xyzzy quux total nonsense query', expectedPath: 'semantic' },
  { query: 'is this safe to use on wood floors', expectedPath: 'semantic', note: 'hard: mentions "wood" (a category leaf)' },
  { query: 'how do I refill the dispenser', expectedPath: 'semantic', note: 'hard: mentions "dispenser"' },
];
