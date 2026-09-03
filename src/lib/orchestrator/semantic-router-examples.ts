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
 *   brands appear only in the `cross_reference` bucket, which is what that route is FOR. Job/problem
 *   phrasing with NO competitor named belongs in the `recommendations` bucket instead (B0-663).
 * - Never state a dilution ratio, oz/gal, mL/L, ppm, %, contact time, EPA registration number, or
 *   log-reduction value here. Regulated values must be transcribed from a label, never invented, so
 *   every such utterance is phrased as a question that ASKS for the value.
 * - Discriminative, not merely on-topic: an utterance that would score nearly as well against a
 *   second route teaches the router nothing and depresses the margin for real traffic.
 *
 * B0-663 — bumped v1 -> v2: split the old single `recommendations` (competitor) bucket into
 * `cross_reference` (competitor examples, unchanged) and a new `recommendations` bucket (job/problem
 * phrasing, no competitor). Per the cache-key rule above, ANY edit to the utterances requires this.
 *
 * B0-746 — bumped v2 -> v3: split the old single `floor` bucket into `floor_wood_sport`,
 * `floor_concrete`, `floor_stg`, and `floor_vct` (the four substrate specialists that replaced the
 * flat `floor` SME id). `floor_stg` utterances are newly authored (the old bucket had no stone/
 * tile/grout content); the rest are the old `floor` utterances reassigned to the substrate they
 * actually name.
 */
export const SEMANTIC_ROUTER_EXAMPLES_VERSION = 'v3';

/**
 * Route ownership boundaries, mirroring the LLM classifier's routing rules in
 * `intent-classifier.ts` (`buildInstructions`) so the two routers agree about what each route means:
 *
 * - `dilution`   — mix ratios, oz/gal and mL/L conversions, titration, dispensers, proportioners,
 *                  metering tips, dilution-station setup.
 * - `bathroom`   — restroom fixtures and surfaces: bowls, urinals, partitions, grout, showers,
 *                  drain/uric scale, restroom odor control and disinfection procedure.
 * - `floor_vct`  — B0-746: VCT, terrazzo, and other resilient/hard tile: strip, seal, finish,
 *                  recoat, scrub, burnish, maintenance programs.
 * - `floor_wood_sport` — B0-746: wood (hardwood) sport/gym floor finish and coating: recoat,
 *                  screen-and-recoat, sand and finish (Basic Coatings for wood).
 * - `floor_concrete` — B0-746: concrete floors: seal, densify, coat, strip, scrub.
 * - `floor_stg`  — B0-746: Stone, Tile & Grout (STG) cleaning and protectant — cleaning and
 *                  protecting natural stone, tile, and grout surfaces (not a stripped-and-recoated
 *                  film finish the way the other three floor routes are).
 * - `product`    — catalog attributes: shelf life, packaging and case pack, item numbers,
 *                  certifications, availability, where-to-find-the-SDS, product-vs-product specs.
 * - `cross_reference` — competitor cross-reference ONLY (per B0-511/B0-514/B0-663): the message
 *                  names a NON-Betco product and wants the Betco equivalent.
 * - `recommendations` — B0-663 NEW: job/problem-driven "what should I use / what do you recommend"
 *                  asks with NO competitor named, that do NOT fit bathroom/dilution/one of the four
 *                  floor specialists' own domain (those specialists still own their own "what
 *                  should I use" questions — additive-only). A factual/spec lookup ("does Betco
 *                  make X", "tell me about X") is `product`, not `recommendations`.
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
  floor_vct: [
    'What is the right procedure to strip and recoat a VCT floor?',
    'How many coats of finish should we apply after stripping a retail entryway of VCT?',
    'Our burnisher is leaving swirl marks in the finish on the resilient tile, what are we doing wrong?',
    'How often should a terrazzo lobby be scrubbed and recoated?',
    'What pad and machine speed should we use to burnish a high-solids finish on VCT?',
    'Does a brand new VCT installation need to be sealed before we apply finish?',
    'What is the top-scrub procedure between full strip-and-refinish cycles on VCT?',
    'How do we remove black heel marks from a VCT hallway without stripping the whole floor?',
  ],
  floor_wood_sport: [
    'Which Basic Coatings system should we use to refinish a gymnasium wood floor?',
    'Can we screen and recoat the hardwood court instead of doing a full sand and finish?',
    'How many coats of finish should we apply after a full sand and refinish on the gym floor?',
    'The wood gym floor finish is peeling in front of the entry doors, what is causing the delamination?',
    'What is the recommended recoat interval for a high school basketball court?',
    'How do we prep a wood volleyball court floor before applying the first coat of finish?',
    'Our sport floor finish is tacky days after recoating, what went wrong?',
    'What is the daily dust-mopping routine for a hardwood gymnasium floor between game nights?',
  ],
  floor_concrete: [
    'What sealer do you recommend for polished concrete in a warehouse aisle?',
    'How do we densify and seal a new concrete slab before opening the space?',
    'The concrete floor coating is peeling near the loading dock entrance, what is causing the delamination?',
    'How do we prep an old concrete floor before applying a new coating system?',
    'What is the right burnishing approach for a polished concrete showroom floor?',
    'Our concrete floor is showing hot-tire pickup marks in the garage, what caused that?',
    'How often should a sealed concrete warehouse floor be scrubbed and resealed?',
    'What is the cure time before we can coat a freshly poured concrete slab?',
  ],
  floor_stg: [
    'What is the right daily cleaner and protectant for our natural stone lobby floor?',
    'How often do we need to reapply the grout protectant on a high-traffic tile entryway floor?',
    'Is this stone floor cleaner safe on marble, or will it etch the surface?',
    'What should we use to keep a ceramic tile floor looking clean between full scrubs?',
    'How do we remove soap scum buildup from tile and grout without damaging the protectant?',
    'What is the reapplication schedule for the stone protectant in a busy hotel lobby?',
    'Our travertine floor is losing its shine between cleanings, what protectant approach fixes that?',
    'Is the tile and grout cleaner safe to use on porcelain tile in a retail entryway?',
  ],
  cross_reference: [
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
  // B0-663 — starter set only, authored to be discriminative against product/bathroom/dilution/
  // the four floor specialists rather than tuned against a real eval; expand/re-tune once
  // B0-652-style routing-accuracy data exists for this route. TODO(B0-663): revisit once real
  // traffic/eval data is available.
  recommendations: [
    'What should I use to degrease a commercial kitchen floor?',
    'I have a problem with sticky residue on tile, what do you recommend?',
    'What product would you recommend for general all-purpose cleaning around the office?',
    'We have a persistent odor problem in the break room, what should we use?',
    'I have an issue with static cling building up on the carpet, what would you recommend?',
    'Looking for a product to handle graffiti removal on a masonry wall.',
    'What is the best product for cleaning up a chemical spill in the loading dock?',
    "We have a stubborn stain on the office carpet that regular cleaner isn't touching, what should we use?",
  ],
};

/** Total authored utterances — asserted in tests so an accidental deletion is caught, not silently routed on. */
export const SEMANTIC_ROUTER_EXAMPLE_COUNT = SME_AGENT_IDS.reduce(
  (total, route) => total + SEMANTIC_ROUTER_EXAMPLES[route].length,
  0,
);
