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

### Coverage snapshot from real historical engine runs (not yet a precision/recall calibration)

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

### Blocker: no labeled (confidence, correctness) pairs yet for the web-grounded gate

To turn the coverage snapshot above into a real precision/recall calibration for
`XREF_RECOMMENDATION_MIN_CONFIDENCE`, we need cases where (a) the web-grounded path actually ran
(competitor product not in the legacy table, or run with the legacy shortcut disabled) and (b) a
human — SME or product team — confirmed whether the top candidate was the correct Betco equivalent.
Neither exists yet in this environment. **This is a genuine data gap, not a code gap**, and it should
not be closed by guessing plausible-sounding competitor→Betco mappings.

**Proposed next step:** sample ~30–50 competitor products from the legacy golden set's *long tail*
(brands/products with weaker retrieval signal), force them through the web-grounded path (bypass the
legacy shortcut for the sample), and have an SME/product-team reviewer mark each top candidate
correct/incorrect. Feed the resulting `{ id, overallConfidence, correct }` list into
`computeThresholdCalibration` to get a real precision/recall table across 0.70–0.90, and set
`XREF_RECOMMENDATION_MIN_CONFIDENCE` from that data rather than the current placeholder default.

### Target (provisional, pending real calibration data)

Proposed target once real data exists: **precision ≥ 90% on answered recommendations** at the chosen
threshold (a wrong equivalent reaching a customer is a materially worse failure mode than an
unnecessary decline-to-sales-rep). Until the blocker above is resolved, `0.80` remains the operating
default — reasonable given the coverage snapshot (very few false-positive-risk answers slip through)
but **not yet proven correct** by a labeled precision curve.

### Harness run — pre-handoff checklist

Any change to the recommendation prompt, `scoreRecommendation`/`gateRecommendation` weights, or
`XREF_RECOMMENDATION_MIN_CONFIDENCE` should be checked against the legacy-lookup regression set before
merge:

```bash
pnpm exec vitest run src/lib/recommendations
```

and, once real calibration data exists, re-running `computeThresholdCalibration` against it before
changing the default threshold. See `AGENTS.md` → "Quick checks before handoff".
