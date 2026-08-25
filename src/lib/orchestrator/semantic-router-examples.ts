import { SME_AGENT_IDS, type SmeAgentId } from '~/lib/agents/agent-registry';

/**
 * B0-647 — the semantic router's example corpus. Each SME route owns a set of representative user
 * utterances; `semantic-router.ts` embeds them once, keeps the vectors in memory, and routes a live
 * message by max cosine similarity against them.
 *
 * Why examples in code rather than a table: the corpus IS the routing model. Editing it changes
 * routing behavior, so it belongs in version control next to the code that consumes it, reviewable
 * in a diff, and it must move through the same release as any threshold change tuned against it.
 *
 * IMPORTANT — `SEMANTIC_ROUTER_EXAMPLES_VERSION` is the cache key. Both the Redis example-embedding
 * cache (B0-654, key `semantic_router:examples:<version>:<model>:<route>`) and any future persisted
 * vector store are keyed on it, so ANY edit to the utterances below — adding, removing, or even
 * re-wording one — MUST bump this version. Forgetting to bump it means every instance keeps serving
 * embeddings computed from the OLD text while the code believes it is using the new corpus.
 *
 * Authoring rules for these utterances (they are also the reason this file is hand-written rather
 * than generated from `~/lib/training/orchestrator-intent-labels.json`):
 * - The labeled JSON set is the EVAL ground truth. Using it as router example data would make the
 *   B0-652 evaluation self-scoring, so these examples are authored fresh and independently.
 * - Betco brands only: Betco, Basic Coatings (wood floor coatings), EnviroZyme, 1950. Competitor
 *   brands appear only in the `recommendations` bucket, which is what that route is FOR.
 * - Never state a dilution ratio, oz/gal, mL/L, ppm, %, contact time, EPA registration number, or
 *   log-reduction value here. Regulated values must be transcribed from a label, never invented, so
 *   every such utterance is phrased as a question that ASKS for the value.
 * - Discriminative, not merely on-topic: an utterance that would score nearly as well against a
 *   second route teaches the router nothing and depresses the margin for real traffic.
 */
export const SEMANTIC_ROUTER_EXAMPLES_VERSION = 'v1';

/**
 * Route ownership boundaries, mirroring the LLM classifier's routing rules in
 * `intent-classifier.ts` (`buildInstructions`) so the two routers agree about what each route means:
 *
 * - `dilution`   — mix ratios, oz/gal and mL/L conversions, titration, dispensers, proportioners,
 *                  metering tips, dilution-station setup.
 * - `bathroom`   — restroom fixtures and surfaces: bowls, urinals, partitions, grout, showers,
 *                  drain/uric scale, restroom odor control and disinfection procedure.
 * - `floor`      — VCT, terrazzo, concrete and wood floors: strip, seal, finish, recoat, scrub,
 *                  burnish, screen-and-recoat, maintenance programs (Basic Coatings for wood).
 * - `product`    — catalog attributes: shelf life, packaging and case pack, item numbers,
 *                  certifications, availability, where-to-find-the-SDS, product-vs-product specs.
 * - `recommendations` — competitor cross-reference ONLY (per B0-511/B0-514): the message names a
 *                  NON-Betco product and wants the Betco equivalent. "What should I use to clean X?"
 *                  is task advice and belongs to the specialist that owns the job, NOT here.
 */
export const SEMANTIC_ROUTER_EXAMPLES: Readonly<Record<SmeAgentId, readonly string[]>> = {
  product: [
    'What is the shelf life of an unopened case of this degreaser?',
    'What container sizes does this product come in?',
    'What is the case pack count and the item number for the gallon size?',
    'Is there a fragrance-free version of this glass cleaner in the catalog?',
    'Which Betco products carry a Green Seal certification?',
    'Where can I find the SDS for this product?',
    'Is this item available in Canada as well as the United States?',
    'What is the difference between your neutral cleaner and your heavy-duty degreaser?',
    'What is the pH of this product as packaged?',
    'Has this product been discontinued or replaced by a newer formula?',
  ],
  bathroom: [
    'What should we use to remove hard water scale from the urinals?',
    'The restroom still smells like urine after mopping, what is the right odor control approach?',
    'How do I clean and brighten restroom floor grout without damaging it?',
    'Which bowl cleaner is safe for a porcelain toilet with a chrome flush valve?',
    'We have uric scale building up in the drain lines under the urinals, which descaler should we use?',
    'What is the recommended daily restroom cleaning procedure for a high-traffic school?',
    'Is the same disinfectant safe on restroom partitions and mirrors?',
    'How do we deal with mildew on the shower stalls in the locker room?',
    'What contact time does the label require for the restroom disinfectant on toilet seats?',
    'Which EnviroZyme product should we put down the restroom floor drains for odor?',
  ],
  dilution: [
    'What is the correct dilution ratio for this floor cleaner in a mop bucket?',
    'How many ounces per gallon should we be putting in the auto scrubber tank?',
    'Our dispenser is pulling the wrong concentration, how do I recalibrate it?',
    'Which metering tip goes on the proportioner for the heavy-duty setting?',
    'How do I titrate the solution to confirm we are hitting the labeled concentration?',
    'Can you give me the label dilution in millilitres per litre for our Canadian sites?',
    'The dispenser draws water but no chemical, how do I troubleshoot the venturi?',
    'What dilution should housekeeping use for daily damp mopping versus a deep clean?',
    'How do I set up a wall-mounted four-product dilution station in the janitor closet?',
    'How much concentrate goes into a 32 oz spray bottle to match the label dilution?',
  ],
  floor: [
    'What is the right procedure to strip and recoat a VCT floor?',
    'How many coats of finish should we apply after stripping a retail entryway?',
    'Our burnisher is leaving swirl marks in the finish, what are we doing wrong?',
    'Which Basic Coatings system should we use to refinish a gymnasium wood floor?',
    'Can we screen and recoat the hardwood court instead of doing a full sand and finish?',
    'What sealer do you recommend for polished concrete in a warehouse aisle?',
    'How often should a terrazzo lobby be scrubbed and recoated?',
    'What pad and machine speed should we use to burnish a high-solids finish?',
    'The floor finish is peeling in front of the entry mats, what is causing the delamination?',
    'Does a brand new VCT installation need to be sealed before we apply finish?',
  ],
  recommendations: [
    'What is the Betco equivalent to Diversey Virex II 256?',
    'We currently buy Zep Formula 50, what should we switch to from Betco?',
    'Do you have a cross-reference for Spartan Clean by Peroxy?',
    'Our customer uses Simple Green Industrial, what is the comparable Betco product?',
    'Which Betco product replaces Ecolab Oasis 146 Multi-Quat?',
    'The competitor is quoting Clorox Total 360 solution, what do we cross to?',
    'Can you match this Hillyard floor finish to something in the Betco line?',
    'What is our answer to State Industrial Products enzyme drain treatment?',
    'The account is on a Buckeye program today, which Betco products cross-reference to it?',
    'Is there a Betco equivalent for Spic and Span concentrate?',
  ],
};

/** Total authored utterances — asserted in tests so an accidental deletion is caught, not silently routed on. */
export const SEMANTIC_ROUTER_EXAMPLE_COUNT = SME_AGENT_IDS.reduce(
  (total, route) => total + SEMANTIC_ROUTER_EXAMPLES[route].length,
  0,
);
