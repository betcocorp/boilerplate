# Cross-reference recommendations — data model & cardinality (B0-81)

Design record for the web-search-grounded cross-reference recommendation engine (epics B0-76 data
model, B0-77 engine). Settles the open question — *does the current cross-reference support
many-to-many?* — and fixes the shape of the new durable store.

## Legacy cardinality audit (live `legacy.competitor_products`, 2026-07-14)

`legacy.competitor_products` is a row-per-mapping join table
(`Competitor` = CompetitorID, `ProductDescr`, `ProductKey`, `ProductID`, `BetcoProdID`, `id`),
joined to `legacy.products` / `legacy.products_descr` in `src/lib/tools/cross-reference-lookup.ts`.

Audited by pulling all rows and grouping (competitor identity = `(Competitor, ProductID)`; Betco
identity = `ProductKey`, falling back to `BetcoProdID`):

| Metric | Value |
|---|---|
| Total mapping rows | **1954** |
| Distinct competitor products | **1954** (one row each) |
| Distinct Betco products referenced | **319** |
| Competitor products → **>1** Betco product | **0** |
| Betco products → **>1** competitor product | **269** |
| Competitor products with **zero** Betco mapping | **0** |
| Distinct competitor brands (`Competitor`) | **31** |

### What this means

- The join table **structurally permits** many-to-many (one row per mapping), and
  `lookupCrossReference()` already returns up to `maxResults` (default 3, max 10) ranked,
  de-duplicated candidates.
- In the **actual data**, every competitor product maps to exactly **one** Betco product, while a
  single Betco product is the equivalent for **many** competitor products (269 such Betco products).
  So the practical relationship today is **competitor product → one Betco (many-to-one)**, and the
  apparent "1:1" per competitor product is a property of the **populated data**, not a cardinality
  cap.
- **Unique constraints:** no application-layer uniqueness is enforced (the legacy schema is a
  read-only MSSQL mirror; `cross-reference-lookup.ts` imposes none). A DB-level unique constraint on
  the mapping could not be confirmed via PostgREST introspection, but it is moot — the data already
  shows at most one Betco per competitor product, and the **new** store is designed independently.

## Decision: model the new store as explicitly many-to-many

The web-grounded path (B0-77) does **not** inherit the legacy 1-Betco-per-competitor shape: given an
unknown competitor product, spec enrichment + semantic retrieval yield a **ranked set of N Betco
candidates**, any of which a human may verify. The durable store therefore models:

- `rag.cross_reference_recommendations` — one row per recommendation *request* (a competitor product,
  optionally a brand), carrying the outcome (answered/declined), overall confidence, threshold, and
  evidence.
- `rag.cross_reference_recommendation_candidates` — **many** rows per recommendation, each a ranked
  Betco candidate with its own confidence, rank, rationale, and source.

This is a true one-recommendation → many-candidates model (B0-82).

### Decision: legacy path stays single-best-per-competitor

The legacy lookup is left as-is. Because the data holds one Betco per competitor product, the
legacy path (`source: 'legacy'`) naturally returns that one confident match (still shaped as a
candidate list of length ≥1 for a uniform contract). We do **not** synthesize extra legacy
candidates — multiple ranked candidates are the job of the web-grounded path. If a future need
arises to surface Betco "siblings" (products sharing a competitor's category), that is a separate
enhancement, not part of this engine.

## Eval question set + threshold calibration (B0-97)

Goal: use the `/admin/tests` harness (`src/lib/tests/{runner,run-executor,repository}.ts`) to prove
`XREF_RECOMMENDATION_MIN_CONFIDENCE` (default `0.80`, `src/lib/recommendations/confidence-scoring.ts`)
is the right answer-gate threshold, with a labeled question set and a precision/recall sweep across
0.70–0.90. Reused `src/lib/recommendations/eval/cross-reference-eval.ts` (the REC-8 headless
category-consistency eval) and its golden set rather than building a second one from scratch.

### What already existed in the harness (verified against the live DB, 2026-07-26)

- **`Recommendation Golden Set — Cross-Reference 1:1 (B0-99)`** — 1,954 `test_items` rows,
  `intended_agent: recommendations`, sourced from a point-in-time export of
  `legacy.competitor_products` (the same real table audited above). Every row carries a real
  `expected_canonical_product` (e.g. `Clear Image Non-Ammoniated Glass Conc. (4 - 2 L FastDraw)` for
  3M `#1 Glass Cleaner`) with `input_payload.source = "legacy_1to1_cross_reference"`. This is genuine
  labeled ground truth — not fabricated for this ticket.
- **`Recommendations test set`** — 23 rows, `intended_agent: recommendations`, uploaded from a CSV
  whose schema declares an `expected_canonical_product` column, but every row's expected fields are
  currently `null` in the DB. Treat this set as an **unlabeled smoke-test prompt list only** — it is
  not usable for precision/recall scoring until someone fills in real expected values.

**Important caveat on the 1,954-row golden set:** every one of those competitor products has a
confident row in the legacy mapping table, so `recommendCrossReference()`
(`src/lib/recommendations/recommend-cross-reference.ts`) answers all of them via the **deterministic
legacy path** (`source: 'legacy'`), which returns immediately once `legacyConfident` is true and never
reaches `scoreRecommendation` / `gateRecommendation` (the 0.70–0.90 gate under test here). So this
golden set is a strong, real regression check for **legacy-lookup retrieval correctness**, but it does
**not exercise the web-grounded confidence gate** — the two are different code paths. Running the
harness against this set (below) validates the legacy path; it cannot by itself calibrate the
`XREF_RECOMMENDATION_MIN_CONFIDENCE` gate.

### New: synthetic no-equivalent probes (`src/supabase/migrations/20260726120000_seed_recommendations_no_equivalent_probes.sql`)

The legacy audit above found **zero** competitor products with no Betco mapping, so there is no real
"known no-equivalent" case anywhere in the available data. Per the no-fabrication rule for
regulated/product-identity claims, we did not invent a plausible-looking competitor→Betco mapping to
fill this gap. Instead we added a 5-item test (`Recommendations — No-Equivalent Probes (synthetic,
B0-97)`, `intended_agent: recommendations`) using deliberately fictional competitor brands/products
(e.g. "Zorbex Klenz-9000") so the harness has *some* decline-path coverage. These are clearly flagged
`metadata.synthetic: true` and must never be read as real market data — they test that the gate
declines gracefully on an unrecognized product, nothing more.

### Reusable calibration function

`src/lib/recommendations/eval/threshold-calibration.ts` — `computeThresholdCalibration(cases,
thresholds)` sweeps candidate thresholds (default `[0.70, 0.75, 0.80, 0.85, 0.90]`) over
`{ id, overallConfidence, correct }` tuples and returns, per threshold: `coverage` (answered/total,
always computable), plus `precision`/`recall` (`null` when no case yet carries a `correct`
verdict — a case with `correct: null` still counts toward coverage but is excluded from
precision/recall so an unverified case can never silently inflate either metric). Fully unit-tested
with synthetic numeric fixtures (`threshold-calibration.test.ts`) — no product data is embedded in
the library itself; callers supply real labeled cases.

### Coverage snapshot from real historical engine runs, 2026-07-26 (superseded — see 2026-09-02 below)

`rag.cross_reference_recommendations` (DB table backing `src/lib/recommendations/persist-recommendation.ts`)
holds 23 real rows from prior manual runs of the live web-grounded engine (queried 2026-07-26). None of
these rows carry a human-reviewed correctness verdict (no `reviewed_status`/`reviewer_verdict` column
exists yet — that is B0-95's review-queue work), so **precision cannot be computed from them**. Their
`overallConfidence` values do give a real coverage curve at the current default threshold and
candidates:

| Threshold | Answered / Total | Coverage |
|---|---|---|
| 0.70 | 6 / 23 | 26.1% |
| 0.75 | 2 / 23 | 8.7% |
| 0.80 (current default) | 1 / 23 | 4.3% |
| 0.85 | 0 / 23 | 0% |
| 0.90 | 0 / 23 | 0% |

(All 22 "declined" rows returned the exact `XREF_DECLINE_COPY` string; the single answered row at
0.831 confidence was `Sentec Mountain Meadow`.) This shows the gate is strict in practice — most
manually-tried competitor products so far fall below even 0.70 — but says nothing about whether the
*answered* cases are *correct*, which is the actual question a precision target needs to answer.

---

## Calibration executed against real data (B0-97, 2026-09-02)

The 2026-07-26 pass above stopped at "no labeled pairs exist". They do now. This section supersedes
it: the ground-truth deadlock was broken, the sweep was run for real, and the conclusion is **not**
"0.80 is right" — it is that the threshold is the wrong knob.

### Where the threshold actually lives today (verified live)

- **`XREF_RECOMMENDATION_MIN_CONFIDENCE` is still read from `process.env`**, in
  `resolveXrefThreshold()` (`src/lib/recommendations/confidence-scoring.ts`). It was **not** migrated
  in B0-638; `select key from public.settings where key like '%XREF%'` returns only
  `XREF_RECOMMENDATION_TIMEOUT_MS` (`25000`). There is no settings row and no env var set, so the
  live effective value is the hardcoded fallback `DEFAULT_XREF_MIN_CONFIDENCE = 0.8`. Per the
  config-in-settings rule this belongs in `public.settings`; moving it is deliberately **not** done
  here, because the number itself should change first (below).
- **The gate is currently bypassed in production.** `BEX_DISABLE_CONFIDENCE_GATING` is `true` in
  `public.settings`, and `gateRecommendation()` returns `answered: true` unconditionally when it is
  set. This is visible in the data: of 432 rows in `rag.cross_reference_recommendations`, 129 are
  `answer_given = true` but only **1** of those scores ≥ 0.80 — answered confidences go down to
  **0.365**. Any statement of the form "the 0.80 gate is protecting users today" is false.

### Method: forced-web-path harvest with auto-derived labels

The blocker was that the two paths are mutually exclusive — `recommendCrossReference()` returns
immediately on a confident legacy match and never reaches `scoreRecommendation`/`gateRecommendation`,
so a competitor product either has a curated answer (and skips the gate) or reaches the gate (and has
no curated answer to be checked against). Measured live: of 327 historical web-path rows, exactly
**1** has a counterpart in `legacy.competitor_products`.

`scripts/calibrate-xref-threshold.ts --harvest` breaks the deadlock without inventing any product
data. It samples competitor products that **do** have a curated Betco equivalent, injects a
deliberately-missing legacy lookup (`deps.lookupInternal` returning the engine's own legacy-miss
shape — no production code changed), and forces the run down the web-grounded path. The label is
then derived, not authored: the top candidate's `betcoProductKey` is compared against the curated
`ProductKey` from Betco's own cross-reference table. Two data-quality fixes were required for the
harvest to be valid at all — `competitor_products.Competitor` is a `CompetitorID`, not a brand name
(feeding the raw id sends `"24 First Step Floor Sealer"` to web search), and rows whose id does not
resolve to a brand are dropped rather than harvested brandless, since `brandKnown: false` applies a
0.9 penalty that would bias the curve downward.

**Label semantics — read this before quoting any precision number.** `correct` means *the web path
reproduced the curated SKU exactly*. It is a strict lower bound on real-world correctness: a run that
returns the right product line in the wrong pack size, or a defensible alternate, counts as wrong.
Spot-checking the misses confirms both kinds are present — e.g. Misco `First Step Floor Sealer`
(curated `Floor Sealer`) returned `Metal Interlocked Acrylic Polymer Floor Sealer`, plausibly the
same thing at a different naming grain, while Misco `Hang-Tite Plus` (curated `Kling 9% HCl Thick
Bowl Cleaner`) returned `Concentrated Acid Free Bathroom Disinfectant`, a materially different
chemistry. Distinguishing these is SME work; the harness does not.

### Score distribution (n = 327 historical web-path runs + 60 harvested)

| Statistic | Historical web-path rows | Harvest (60 forced runs) |
|---|---|---|
| p50 | 0.588 | 0.615 |
| p90 | 0.705 | — |
| p99 | 0.787 | — |
| max | **0.831** | **0.760** |
| ≥ 0.70 | 38 / 327 (11.6%) | 4 / 60 |
| ≥ 0.80 | **1 / 327 (0.3%)** | **0 / 60** |
| ≥ 0.85 | 0 / 327 | 0 / 60 |

The scorer's realised range tops out around 0.83. **A 0.80 threshold is not a strict gate, it is an
off switch** — it answers 0.3% of web-path questions. That is almost certainly why
`BEX_DISABLE_CONFIDENCE_GATING` was turned on.

### The precision/recall curve (61 cases, 49 labeled)

Produced by `npx tsx --env-file=.env.local scripts/calibrate-xref-threshold.ts`, sweeping 0.70–0.90
in 0.01 steps over the 60 harvested cases plus the 1 human-verified row from the review queue.
Abbreviated (rows are flat between the breakpoints shown):

| Threshold | Answered | Coverage | Labeled answered | Correct | FP | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|---|
| 0.70–0.72 | 4 | 6.6% | 4 | 1 | 3 | 0.250 | 0.250 | 0.250 |
| 0.73–0.75 | 3 | 4.9% | 3 | 1 | 2 | 0.333 | 0.250 | 0.286 |
| 0.76 | 2 | 3.3% | 2 | 1 | 1 | 0.500 | 0.250 | 0.333 |
| 0.77 | 1 | 1.6% | 1 | 1 | 0 | 1.000 | 0.250 | 0.400 |
| **0.78–0.90** | **0** | **0%** | 0 | 0 | 0 | — | 0.000 | — |

**At the current default of 0.80, every threshold in the range answers nothing at all.** The
`precision = 1.000` at 0.77 rests on a single case and is not evidence; `selectThreshold()` refuses
to return it (`minLabeledAnswered` default 20) rather than let it be quoted as a result.

### The finding that matters: the score does not separate correct from incorrect

Across the 48 labeled harvest cases (3 correct, 45 wrong at exact-key grain):

- mean `overallConfidence` of **correct** answers: **0.574**
- mean `overallConfidence` of **wrong** answers: **0.607**
- AUC (probability a correct case outranks a wrong one): **0.319**

All three correct cases scored *below* 0.70 (0.645, 0.540, 0.536) and would be declined at every
threshold in the sweep. With only 3 positives the AUC point estimate carries enormous uncertainty and
should **not** be reported as "the score is anti-correlated with correctness" — but it is squarely
inconsistent with the score having useful discriminative power. **No threshold can rescue a score
that does not rank correct above incorrect.** Tuning `XREF_RECOMMENDATION_MIN_CONFIDENCE` up or down
is choosing a point on a curve that is flat in the only dimension that matters.

### Recommendation

> **Partly superseded by B0-795 (below), same day.** Items 2 and 5 were acted on: the scorer was
> fixed (`candidateAgreement` → `candidateMargin`) and the threshold moved into `public.settings` at
> its unchanged value of 0.80. Items 1, 3 and 4 still stand. Note also that the **AUC 0.319** quoted
> above was measured on 48 cases with 3 positives; re-measured on 200 harvested runs with the same
> scorer it is **0.489** — i.e. coin-flip rather than anti-correlated, which is the more defensible
> reading and the one the small-n caveat above anticipated.

1. **Do not retune `XREF_RECOMMENDATION_MIN_CONFIDENCE` on this data.** The honest answer to "is 0.80
   right?" is that the question is malformed: at 0.80 the gate answers 0.3% of web-path questions,
   and the confidence signal it thresholds shows no measured ability to rank correct answers above
   wrong ones. Changing the number trades one arbitrary operating point for another.
2. **Fix `scoreRecommendation` before the threshold.** Its inputs (`topSimilarity` 0.55,
   `specCompleteness` 0.25, `candidateAgreement` 0.20) are embedding-similarity and
   metadata-completeness proxies; none of them measures whether the candidate is *the same kind of
   product*. `candidateAgreement` (mean similarity across candidates) arguably rewards an
   undifferentiated candidate list, which is the opposite of confidence.
3. **Keep the target as stated: precision ≥ 90% on answered recommendations.** A wrong equivalent
   reaching a customer is materially worse than a decline-to-sales-rep. That target is currently
   unreachable at any coverage worth having.
4. **Leave `BEX_DISABLE_CONFIDENCE_GATING = true` as-is for now, but treat it as a known open risk,
   not a setting.** With the gate bypassed, sub-0.40-confidence cross-reference answers reach users.
   The pairing of "gate bypassed" + "gate would answer almost nothing if re-enabled" is the real
   finding of this ticket.
5. **Move the threshold into `public.settings` when its value is next changed** (config-in-settings
   rule), not before — a settings row that codifies an unproven number is worse than a documented
   fallback.

### How much labeled data would settle it

`selectThreshold()` requires ≥ 20 labeled *answered* cases before it will name a threshold. Because
only ~7% of harvested runs clear even 0.70, reaching 20 labeled answered cases needs roughly
**300 harvested runs** at the current score distribution — or far fewer once the scorer is fixed and
its output actually spreads across the 0.70–0.90 band.

What an SME must supply is **not** more competitor→Betco pairs (Betco already has 1,954 curated ones
and the harvest reads them automatically). It is adjudication of the *near-misses*: a reviewer
marking, for ~50 harvested cases, whether the returned Betco product is an acceptable equivalent even
when it is not the exact curated SKU. That converts the strict exact-key lower bound into a true
precision figure and is the only labeling step a machine cannot do here. The review queue at
`/admin/tools/cross-reference/recommendations` (B0-95/96) already writes exactly this verdict —
`status = 'verified'` plus `evidence.verification.verifier` — and `loadReviewedCases()` in the script
picks those rows up automatically. Today that queue holds **1** reviewed row.

### Harness question set (AC1)

> **Purged 2026-09-03 (B0-826).** This test set carried `expected_criteria` but no concept columns,
> so it was removed with every other concept-less item; the `/admin/tests` harness run is no longer
> part of the pre-handoff checklist. The seed migration and CSV fixture below still exist, so the set
> can be re-seeded if it is ever given `minimum_concepts` / `expected_concepts`. The description that
> follows is historical.

`Cross-Reference Gate Calibration (B0-97)` — test id `3a1c7f52-9d4b-4e18-b6a7-2c95f0e41d83`,
`intended_agent: cross_reference`, 65 items, seeded by
`src/supabase/migrations/20260902120000_seed_cross_reference_gate_calibration_b0_97.sql`
(fixture: `src/lib/tests/fixtures/cross-reference-gate-calibration-b0-97.csv`). Every item records
its provenance:

- **60 positives, `source: curated_legacy_mapping`** — real competitor brand + product with the
  curated Betco equivalent. The migration SELECTs brand, competitor description and expected product
  live from `legacy.competitor_products` / `legacy.competitor` / `legacy.products`; nothing is
  transcribed by hand. Each carries `metadata.harvest_confidence` and
  `metadata.harvest_correct_exact_key` so the set and the curve above trace to the same engine runs.
  `expected_criteria` uses `match: 'exact'` on the Betco product name — a product identity is an
  exact value and exact matching costs no LLM call.
- **5 negatives, `source: synthetic_no_equivalent`** — deliberately fictional brands/products
  (`metadata.synthetic: true`). The legacy cardinality audit found **zero** real competitor products
  without a Betco mapping, so a real no-equivalent case does not exist in the available data. These
  test graceful decline only and must never be read as market data.

Also retagged to `cross_reference` by the same migration (they predate the B0-663 split and were
mislabeled `recommendations` / `product`): the B0-99 1,954-row golden set, the 23-row
`Recommendations test set`, and the 5-row synthetic no-equivalent probes. **All three remain
`is_archived = true`** — B0-750 pruned the golden roster and that decision is left alone here. Note
the standing caveat: those positives are answered by the deterministic legacy path and so are a
regression check on *legacy-lookup retrieval*, not on the gate. Gate calibration requires the
harvest script.

---

## Fixing the scorer, not the threshold (B0-795, 2026-09-02)

B0-97 ended by refusing to name a threshold and saying the scorer had to be fixed first. This is
that work. **Read the B0-97 section above first** — the method, the harvest and the label semantics
are unchanged, and the caveats there still apply to every number below.

### The measurement instrument came first

Two additions made an honest A/B possible at all:

- **`computeDiscrimination()`** (`src/lib/recommendations/eval/threshold-calibration.ts`) — AUC via
  Mann–Whitney U over midranks, plus per-class means and the positive/negative counts. `AUC` is the
  probability a correct case outranks a wrong one; the counts are returned beside it because at this
  n the point estimate alone is not a result. `scripts/calibrate-xref-threshold.ts` now prints this
  block **above** the threshold sweep, because the sweep is only meaningful once the score ranks.
- **`--rescore`** — the harvest now persists the exact inputs `scoreRecommendation` saw
  (`scoreInputs`: enriched spec, grounded candidate list with similarities, `brandKnown`), so a
  changed scorer can be replayed over the identical runs offline: no web searches, no LLM calls, no
  non-determinism. `correct` is never recomputed, so a scorer change can move the score but can
  never move the ground truth it is graded against. This is what makes the before/after below a
  true like-for-like comparison rather than two different experiments.

The labeled set was also widened from 48 to **200 harvested runs** (seed 97, superset of B0-97's 60),
which raised known-correct cases from 3 to 4 (+1 from the review queue = 5).

### Signals measured, in isolation, over the same 200-run harvest

AUC of each signal used **alone**, under two labels. "Exact" is B0-97's strict exact-SKU label.
"Line" is a secondary label derived from `legacy.products_attr` — the returned product belongs to the
same Betco **product line** as the curated one. That converts "right product line, wrong pack size"
near-misses into positives; it is still machine-derived from Betco's own line grouping, not authored
equivalence, and it has 17 positives rather than 4, so it carries most of the statistical weight.

| Signal (alone) | AUC (exact, 4 pos) | AUC (line, 17 pos) |
|---|---|---|
| `candidateMargin` — top vs runner-up similarity | **0.741** | **0.574** |
| `topSimilarity` | 0.516 | 0.561 |
| `specCompleteness` | 0.432 | 0.497 |
| `categoryCompatibility` — product-kind match | 0.155 | 0.474 |
| `candidateAgreement` — mean similarity | **0.117** | **0.389** |

### `candidateAgreement` is removed — the evidence (AC3)

It is **below chance under both labels** (0.117 / 0.389), which is what its shape predicts: mean
similarity rises when every candidate looks alike, and an undifferentiated candidate list is
ambiguity, not confidence. Its 0.20 weight now goes to **`candidateMargin`**, the normalized gap
between the top candidate and the runner-up (`MARGIN_FULL_SEPARATION = 0.10`; sweeping that constant
to 0.05 and 0.15 moved AUC by ≤0.003). A single candidate yields `null`, not 0 — an un-measurable
margin is not a lost run-off — and null components are dropped from the weighted mean with their
weight redistributed.

### The category signal does not work here, and that is the finding (AC1)

`public.product_category` / `product_category_link` were evaluated first and are the wrong tool for
this comparison for a structural reason, not a coverage one: the links are **product-line** scoped
across two unreconciled taxonomies (240 `metakeywords` + 224 `betco_site_scrape`, B0-205), and only
one side of the comparison — the Betco candidate — appears in them at all. The competitor is a
third-party product with no row anywhere, so it would have to be classified into the taxonomy by
text regardless. `product_category.aliases` carries no synonyms (every alias is a concatenation of
the node's own path, e.g. `Restroom - Acid Cleaner`), so the table supplies no competitor vocabulary
either.

What it *is* good for is the vocabulary's shape, and that was taken from it:
`src/lib/recommendations/product-kind.ts` is a deterministic classifier whose domains are the live
`metakeywords` roots (Restroom / Floor Care / Carpet Care / Industrial / Gen'l Cleaning /
Disinfectants / Laundry / Warewash / Wood Floor / Skin Care / Odor / Food Serv / Concrete) and whose
leaves are its leaves (`Acid Cleaner` vs `Acid Free Cleaner`, Sealers, Strippers, Finishes,
Spotters, Glass). It classifies accurately — 76/89 competitor sides and 81/89 candidate sides
resolve — **once `keyClaims` is excluded from its input.** Feeding claims text in produced 25 domain
"mismatches" in 72 comparable cases, most of them the artefact of a bowl cleaner claiming a
"pleasant fragrance" being read as an odor product. With claims excluded that falls to 9, and those
9 are genuine category boundaries.

**And it still carries no information about correctness:**

| Top candidate judged | line-correct | wrong |
|---|---|---|
| same product kind | 10 | 43 (18.9% correct) |
| different domain | 1 | 5 (16.7% correct) |

Those rates are indistinguishable. The reason is visible in the same numbers: retrieval already
lands in the right category ~82% of the time (53 same-kind of 65 comparable), so the errors this
scorer needs to catch are **within-category SKU errors**, which a category check is blind to by
construction. Weighted at 0.30 it dropped combined AUC from 0.66 to 0.24; applied as a
mismatch-only penalty it would have suppressed **one of only five** known-correct answers.

So `categoryCompatibility` is **computed and persisted on every run** (in `evidence.score`, with the
two kind labels beside it so a verdict is auditable) and **deliberately not weighted**. That is a
measured decision, not an oversight — `confidence-scoring.ts` says so at the top and a unit test
asserts the score does not move with it. It is collected so the next investigation starts with the
feature already in the data. Do not give it a weight without re-running the calibration script.

Note the Hang-Tite Plus case from B0-97 specifically: the classifier *does* separate
`bowl_cleaner_acid` from `bowl_cleaner_acid_free`, but the enriched competitor spec for that run
never captured the acid/HCl chemistry at all (`productCategory: "disinfectant"`,
`primaryUse: "toilet bowls and urinals"`). The information needed to catch it is missing upstream, in
spec enrichment — not in the scorer. That is the real next lever.

### Before / after on the identical labeled set (AC2)

Produced by `npx tsx --env-file=.env.local scripts/calibrate-xref-threshold.ts --rescore`. Same 200
harvested runs, same labels, only `scoreRecommendation` changed. (The 111 cases without
`scoreInputs` are exactly the runs that returned no candidate: all score 0 and all are unlabeled, so
every case that contributes to a metric below was rescored.)

| | AUC exact (4 pos / 79 neg) | AUC line (17 / 66) | AUC as the script prints it (5 / 79) |
|---|---|---|---|
| Before (`candidateAgreement`) | 0.361 | 0.525 | **0.489** |
| After (`candidateMargin`) | **0.660** | **0.577** | **0.728** |

Mean confidence, correct vs wrong, went from 0.612 / **0.604** (a 0.008 gap in the *wrong*
direction on the script's set) to 0.612 / **0.537**.

**The AC2 gate is MET: AUC is above 0.5 on every view of the labeled set.** With the honest
qualifiers attached, all of which matter:

- **n is small and the exact-label result rests on 4 positives.** The 0.361 → 0.660 jump is the
  headline number but the widest error bar. The line label carries 17 positives and shows a real but
  far more modest 0.525 → 0.577.
- **Variant selection is an overfitting risk.** 17 scoring variants were compared. The two
  conclusions drawn are the two that hold under *both* labels, in the same direction, and have a
  mechanical explanation independent of this dataset (a flat candidate list is ambiguity; a clear
  leader is separation). Nothing was tuned per-case, and the product-kind vocabulary was written
  before any of its results were seen.
- The exact-SKU label remains a **strict lower bound** — reasonable near-misses still count as wrong.

### Score distribution after the change

| Statistic | Before | After |
|---|---|---|
| p50 | 0.600 | 0.538 |
| p90 | 0.670 | 0.621 |
| max | 0.757 | 0.738 |
| ≥ 0.70 | 4 / 89 | 3 / 89 |
| ≥ 0.80 | **0 / 89** | **0 / 89** |

The realised range still tops out below 0.75. Discrimination improved; **calibration did not** — the
score now ranks better but is still compressed into roughly 0.4–0.75.

### Threshold: still not nameable, and that is the answer (AC5)

`selectThreshold()` refuses. At the precision target of 0.90 the lowest qualifying row is 0.74, and
it rests on **1** labeled answered case against a floor of 20. Naming 0.74 would be quoting a
sample of one.

**Recommendation: leave `XREF_RECOMMENDATION_MIN_CONFIDENCE` at 0.80. Confidence in that number:
low — it is a preserved status quo, not a calibrated choice.** The reasoning is unchanged from
B0-97 in kind but has a new specific: at 0.80 the gate would answer 0 of 89 web-path runs, so
turning `BEX_DISABLE_CONFIDENCE_GATING` off today would still take cross-reference to near-zero
coverage. The scorer now ranks; it is not yet *calibrated to an absolute scale*, and a threshold is
an absolute-scale question. Two things are needed before the number can move:

1. **More labeled answered cases.** ~20 are needed; the harvest produces roughly 1 per 20 runs at
   this distribution, so on the order of 400 more harvested runs — or far fewer once the score
   spreads across the 0.70–0.90 band.
2. **Calibration, not just ranking.** The obvious next step is to map the score onto observed
   correctness rates (isotonic/Platt) so 0.80 means "80% of these are right", at which point the
   threshold follows from the precision target instead of being chosen.

`BEX_DISABLE_CONFIDENCE_GATING` stays `true` and stays a known open risk, unchanged by this ticket.

### `XREF_RECOMMENDATION_MIN_CONFIDENCE` moved to `public.settings` (AC4)

`src/supabase/migrations/20260902160000_add_xref_recommendation_min_confidence_setting_b0795.sql`
seeds the row at **0.80** — the value that was already live — so applying it changes nothing.
`resolveXrefThreshold()` now reads `getNumberSetting(...)` and is `async`; `gateRecommendation`,
`buildCrossReferenceRecommendationPrompt`, `latencyCeilingFallback` and
`unresolvedCompetitorDecline` became async with it. The key is registered in
`src/components/admin/settings/SettingsPanel.tsx`. A stray env var of the old name can no longer
influence the gate, and there is a test asserting that.

One trap this surfaced, worth knowing about elsewhere: `recommend-cross-reference.test.ts` mocked
`getNumberSetting` with a blanket `mockResolvedValue(20_000)` for every key. The moment the
threshold started coming from the same service, the answer gate silently became 20000 and six
web-path tests failed for a reason unrelated to what they were testing. Settings mocks must honour
each key's own fallback.

### Pre-handoff checklist (AC4)

Any change to the recommendation/cross-reference prompt, `sme-routing.ts` recommendation signals,
`scoreRecommendation`/`gateRecommendation`, or `XREF_RECOMMENDATION_MIN_CONFIDENCE` requires **all
three** before merge:

```bash
# 1. Unit + guardrail suite (fast, no network).
pnpm exec vitest run src/lib/recommendations

# 2. Re-run the discrimination (AUC) + threshold curve on the stored labeled cases and confirm
#    neither has regressed. AUC is the gate; the sweep is only meaningful once the score ranks.
npx tsx --env-file=.env.local scripts/calibrate-xref-threshold.ts

# 3. When the scorer itself changed — replay the stored scoreInputs through the new scorer. This is
#    offline (no web search, no LLM) and keeps the labels fixed, so it is a true like-for-like A/B.
#    Prefer this over re-harvesting: re-harvesting changes the labels too and stops being a
#    controlled comparison.
npx tsx --env-file=.env.local scripts/calibrate-xref-threshold.ts --rescore

# 4. Only to grow the labeled set (or refresh cases harvested before scoreInputs was captured).
npx tsx --env-file=.env.local scripts/calibrate-xref-threshold.ts --harvest --limit 200
```

plus the `/admin/tests` run of `Cross-Reference Gate Calibration (B0-97)`. Labeled cases live in
`src/lib/recommendations/eval/xref-threshold-cases.json` (checked in, regenerated by `--harvest`).
See `AGENTS.md` → "Quick checks before handoff".
