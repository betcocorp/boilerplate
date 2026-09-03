import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';

import type { SmeAgentId } from '~/lib/agents/sme/types';

/**
 * B0-339 — routing golden set for competitor→Betco cross-reference intent.
 *
 * Complements `cross-reference-eval.ts` (REC-8), which scores the *decision chain* — grounding a
 * competitor and checking chemistry-class consistency. This set scores the step before that: does a
 * cross-reference request get recognised as one at all, and do the cross-reference post-processing
 * branches engage?
 *
 * That distinction is what B0-339 was about. `PRODUCT_SIGNALS` carries the generic tokens 'product'
 * and 'betco', so a literal "Cross-reference X to a Betco product" scored product 2 /
 * cross_reference 1 and routed to `product` — which skipped the curated-override safety net, the
 * competitive-answer builder, and the validator evidence injection. On live `audit_logs`, 270 of the
 * 414 runs that called `lookup_cross_reference` (65%) were labeled `product`.
 *
 * Fully offline and deterministic: no LLM, no web search, no DB. Safe to run in CI on every change
 * to `sme-routing.ts`, unlike the `/admin/tests` B0-99 harness which needs live runs.
 *
 * Data provenance: every competitor brand/product and every Betco product named below is a real
 * pair read from `legacy.competitor_products ⋈ legacy.competitor ⋈ legacy.products` — the same
 * ground-truth mapping that backs the B0-99 golden set. Nothing here is invented.
 *
 * Regulated-data note: these messages deliberately *ask about* dilution ratios, contact times and
 * EPA registrations rather than asserting them. No case states a regulated value, so this file can
 * never become a source of an unverified claim. Keep it that way when extending.
 *
 * B0-663 — the `cross_reference` cases below are a straight rename of the old `recommendations`
 * (competitor) expectations; behavior is unchanged. A new "--- Job-based recommendations (B0-663)
 * ---" section further down adds cases for the SEPARATE job/problem-driven `recommendations` agent
 * (no competitor named) — those never expect cross-reference post-processing.
 */

export type RoutingGoldenCase = {
  id: string;
  message: string;
  /** The specialist `routeUserMessageToSme` should choose. `null` means "no signals fired". */
  expectedRoute: SmeAgentId | null;
  /**
   * Whether the cross-reference post-processing should engage for this turn — the curated-override
   * safety net, `buildCompetitiveRecommendationAnswer`, validator evidence injection, and the REC-4
   * gate. In the workflow this is `routingDecision === 'cross_reference' || crossReferenceIntent`.
   */
  expectsCrossReferencePostProcessing: boolean;
  /** What regression this case guards. Keep it specific — this is why the case earns its place. */
  note: string;
};

export const ROUTING_GOLDEN_SET: RoutingGoldenCase[] = [
  // --- The B0-339 regressions: cross-reference intent that used to land on `product` ------------
  {
    id: 'xref-literal-with-product-token',
    message: 'Cross-reference Multi-Clean 007 Peroxide Cleaner to a Betco product.',
    expectedRoute: 'cross_reference',
    expectsCrossReferencePostProcessing: true,
    note: 'Headline B0-339 case: "product" + "betco" out-hit "cross-reference" 2-1, so counting alone routed this to product.',
  },
  {
    id: 'xref-switch-to',
    message:
      'We currently use Diversey AHP 5. Which Betco product should we switch to?',
    expectedRoute: 'cross_reference',
    expectsCrossReferencePostProcessing: true,
    note: '"switch to" scored zero in CROSS_REFERENCE_SIGNALS before B0-339; only "switch from" was listed.',
  },
  {
    id: 'xref-replaces',
    message: 'Which Betco product replaces Ecolab A-456 II?',
    expectedRoute: 'cross_reference',
    expectsCrossReferencePostProcessing: true,
    note: '"replaces" scored zero before B0-339; PRODUCT_SIGNALS only carried "replacement".',
  },
  {
    id: 'xref-looking-to-replace',
    message: 'Looking to replace Hillyard 1907 Gym Finish with something from Betco.',
    expectedRoute: 'cross_reference',
    expectsCrossReferencePostProcessing: true,
    note: 'Substitution phrased as an intent rather than a question.',
  },
  {
    id: 'xref-swap-out',
    message: 'We want to swap out Buckeye 1844 for a Betco floor finish.',
    expectedRoute: 'cross_reference',
    expectsCrossReferencePostProcessing: true,
    note: 'Guards "swap out" and confirms a floor-finish noun does not pull this to the floor specialist.',
  },
  {
    id: 'xref-can-replace',
    message: 'What can replace our current Franklin 2 N’ 1 Rug Spotter RTU?',
    expectedRoute: 'cross_reference',
    expectsCrossReferencePostProcessing: true,
    note: 'Substitution with no "betco" token at all — must still reach the cross-reference path.',
  },

  // --- Canonical phrasings whose old behaviour depended on the competitor's product name --------
  // Measured against pre-B0-339 code, both of these also routed to `product`. The old scoring was
  // luck-dependent: "Betco equivalent of Zep's heavy-duty degreaser" tied 2-2 and the tie-break
  // rescued it, but naming a product with more catalog nouns pushed product ahead outright.
  {
    id: 'xref-equivalent',
    message: 'What is the Betco equivalent of 3M #5 Quat Disinfectant Cleaner?',
    expectedRoute: 'cross_reference',
    expectsCrossReferencePostProcessing: true,
    note: 'Canonical "Betco equivalent" phrasing that still lost pre-B0-339, because "disinfectant" and "cleaner" in the competitor name pushed productScore to 3 against cross_reference 2.',
  },
  {
    id: 'xref-comparable',
    message: 'Is there a comparable Betco product to Claire Ammoniated Glass Cleaner?',
    expectedRoute: 'cross_reference',
    expectsCrossReferencePostProcessing: true,
    note: '"comparable" plus a competitor name containing "cleaner" — also routed to product pre-B0-339.',
  },
  {
    id: 'xref-alternative-to',
    message: 'We need a Betco alternative to NCL 24/7 Floor Finish.',
    expectedRoute: 'cross_reference',
    expectsCrossReferencePostProcessing: true,
    note: 'Regression guard for "alternative to" — again with a floor-finish noun present.',
  },
  {
    id: 'xref-competitor-word',
    message:
      'Cross-reference this competitor disinfectant to a comparable Betco product.',
    expectedRoute: 'cross_reference',
    expectsCrossReferencePostProcessing: true,
    note: 'Generic competitor phrasing with no named brand.',
  },

  // --- Genuine product questions that must NOT be pulled onto the cross-reference path ----------
  {
    id: 'product-dilution-ratio',
    message: 'What is the dilution ratio for pH7 Ultra Neutral Cleaner?',
    expectedRoute: 'product',
    expectsCrossReferencePostProcessing: false,
    note: 'B0-339 must not widen the cross-reference path onto ordinary catalog questions.',
  },
  {
    id: 'product-epa-registration',
    message: 'What is the EPA registration number for Quat-Stat 5 Disinfectant?',
    expectedRoute: 'product',
    expectsCrossReferencePostProcessing: false,
    note: 'Asks about a regulated value; must stay on the product route.',
  },
  {
    id: 'product-sds-ppe',
    message:
      'What PPE and first aid information is on the SDS for Extreme Ultra Floor Stripper?',
    expectedRoute: 'product',
    expectsCrossReferencePostProcessing: false,
    note: 'SDS/hazard question — product route.',
  },
  {
    id: 'product-dwell-time',
    message: 'What dwell time does Triforce Disinfectant need?',
    expectedRoute: 'product',
    expectsCrossReferencePostProcessing: false,
    note: 'Contact-time question — product route.',
  },
  {
    id: 'product-compatibility',
    message: 'Is Green Earth Glass Cleaner compatible with my FastDraw dispenser?',
    expectedRoute: 'product',
    expectsCrossReferencePostProcessing: false,
    note: 'Mentions a dispenser but is a compatibility question, not dispenser setup.',
  },

  // --- Boundaries the decisive short-circuit must respect --------------------------------------
  {
    id: 'boundary-instead-of-internal',
    message:
      'Should I use the Betco concentrate instead of the RTU for this floor?',
    expectedRoute: 'product',
    expectsCrossReferencePostProcessing: false,
    note: '"instead of" is a contributing signal but never decisive — this is a Betco-internal comparison, not a competitor cross-reference.',
  },
  {
    id: 'boundary-recommend-floor-procedure',
    message:
      'What do you recommend to strip and recoat a VCT floor using the floor maintenance program?',
    expectedRoute: 'floor_vct',
    expectsCrossReferencePostProcessing: false,
    note: 'The broad "recommend" cross_reference signal, and the job-based "what do you recommend" recommendations signal, must not hijack a floor procedure — "floor maintenance program" ties all four floor categories (B0-746) plus recommendations/cross_reference, and floor_vct wins the tie-break (SME_ROUTE_TIE_BREAK_ORDER, B0-663/B0-746).',
  },
  {
    id: 'boundary-dilution-hardware',
    message:
      'How do I calibrate the dispenser and set the metering tip on my dilution control system?',
    expectedRoute: 'dilution',
    expectsCrossReferencePostProcessing: false,
    note: 'Procedure specialists must still win; guards the decisive short-circuit stealing turns.',
  },
  {
    id: 'boundary-restroom',
    message: 'What should I use on urinals and toilets in a restroom?',
    expectedRoute: 'bathroom',
    expectsCrossReferencePostProcessing: false,
    note: 'Bathroom route intact — also the B0-663 additive-only guard: "what should I use" matches the new job-based recommendations signal too, but bathroom out-scores it (2 vs 1) here.',
  },
  {
    id: 'boundary-no-signal',
    message: 'Hello, can you help me with something?',
    expectedRoute: null,
    expectsCrossReferencePostProcessing: false,
    note: 'No signals fire; the router must decline to guess.',
  },

  // --- Job-based recommendations (B0-663): "what should I use" with no competitor named and no ----
  // --- bathroom/dilution/floor-specific domain signal — additive-only, never expects cross-------
  // --- reference post-processing. ------------------------------------------------------------------
  {
    id: 'job-degrease-kitchen-floor',
    message: 'What should I use to degrease a commercial kitchen floor?',
    expectedRoute: 'recommendations',
    expectsCrossReferencePostProcessing: false,
    note: 'Generic job/problem ask ("what should I use") with a bare "degreas" PRODUCT_SIGNALS hit — ties product 1-1 and recommendations wins the tie (additive-only order still keeps it below dilution/the four floor specialists/bathroom).',
  },
  {
    id: 'job-sticky-residue-tile',
    message: 'I have a problem with sticky residue on tile, what do you recommend?',
    expectedRoute: 'recommendations',
    expectsCrossReferencePostProcessing: false,
    note: 'Incidentally touches bathroom vocabulary ("tile") but two job-phrase hits ("i have a problem", "what do you recommend") outscore the single bathroom hit outright.',
  },
  {
    id: 'job-best-product-warehouse-grease',
    message:
      'What is the best product for removing grease buildup in a warehouse — what would you recommend?',
    expectedRoute: 'recommendations',
    expectsCrossReferencePostProcessing: false,
    note: 'No competitor named; "best product for" + "what would you recommend" outscore the single generic PRODUCT_SIGNALS "product" hit.',
  },
  {
    id: 'job-static-cling-carpet',
    message: 'I have an issue with static cling building up on the carpet, what would you recommend?',
    expectedRoute: 'recommendations',
    expectsCrossReferencePostProcessing: false,
    note: 'Cross-domain problem (carpet is outside bathroom/dilution/every floor specialist) with no competitor named — outright win.',
  },
  {
    id: 'job-adhesive-residue-need-something',
    message: 'Need something for removing stubborn adhesive residue — what would you recommend?',
    expectedRoute: 'recommendations',
    expectsCrossReferencePostProcessing: false,
    note: '"need something for" + "what would you recommend" with no product/domain vocabulary at all.',
  },
];

export type RoutingGoldenItemResult = {
  id: string;
  message: string;
  expectedRoute: SmeAgentId | null;
  actualRoute: SmeAgentId | null;
  routeMatch: boolean;
  expectsCrossReferencePostProcessing: boolean;
  actualCrossReferencePostProcessing: boolean;
  postProcessingMatch: boolean;
  passed: boolean;
  note: string;
};

export type RoutingGoldenReport = {
  total: number;
  passed: number;
  routeAccuracy: number;
  postProcessingAccuracy: number;
  failures: RoutingGoldenItemResult[];
  items: RoutingGoldenItemResult[];
};

export type RoutingGoldenDeps = {
  route: (message: string) => { agent: SmeAgentId | null };
  /**
   * The workflow's own cross-reference intent predicate. Injected rather than imported so this eval
   * stays free of `run-product-support-workflow`'s module graph (Supabase + OpenAI clients), which
   * would otherwise make a pure routing check require live credentials.
   */
  hasCrossReferenceIntent: (message: string) => boolean;
};

export function runRoutingGoldenSet(
  deps: RoutingGoldenDeps,
  cases: RoutingGoldenCase[] = ROUTING_GOLDEN_SET,
): RoutingGoldenReport {
  const items = cases.map((testCase): RoutingGoldenItemResult => {
    const actualRoute = deps.route(testCase.message).agent;
    const routeMatch = actualRoute === testCase.expectedRoute;

    // Mirrors `useCrossReferencePostProcessing` in run-product-support-workflow.ts.
    const actualCrossReferencePostProcessing =
      actualRoute === 'cross_reference' ||
      deps.hasCrossReferenceIntent(testCase.message);
    const postProcessingMatch =
      actualCrossReferencePostProcessing === testCase.expectsCrossReferencePostProcessing;

    return {
      id: testCase.id,
      message: testCase.message,
      expectedRoute: testCase.expectedRoute,
      actualRoute,
      routeMatch,
      expectsCrossReferencePostProcessing: testCase.expectsCrossReferencePostProcessing,
      actualCrossReferencePostProcessing,
      postProcessingMatch,
      passed: routeMatch && postProcessingMatch,
      note: testCase.note,
    };
  });

  const passed = items.filter((i) => i.passed).length;
  const routeMatches = items.filter((i) => i.routeMatch).length;
  const postProcessingMatches = items.filter((i) => i.postProcessingMatch).length;

  return {
    total: items.length,
    passed,
    routeAccuracy: items.length > 0 ? routeMatches / items.length : 0,
    postProcessingAccuracy:
      items.length > 0 ? postProcessingMatches / items.length : 0,
    failures: items.filter((i) => !i.passed),
    items,
  };
}

/** Default wiring for the routing half; callers supply the intent predicate. */
export const defaultRoutingGoldenRoute = (message: string) =>
  routeUserMessageToSme(message);
