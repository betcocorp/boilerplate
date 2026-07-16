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
