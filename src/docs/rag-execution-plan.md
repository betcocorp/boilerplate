# BEX RAG System — Execution Plan

> **Reference:** See `rag-specification.md` for the end-state design this plan is building toward.
> **Current date:** May 2026

---

## Current State Snapshot

> **Updated 2026-07-15 (live reconciliation — see `BEX-2.0-Corpus-Assessment-and-Reconciliation-Strategy.md` §6).** Figures below are measured from the live Supabase project and supersede the May 2026 snapshot. SP/FR SDS purged; CAN retained. B1xxx deferred (separate brand). Phase 4 is partially unblocked — SDS and markdown-knowledge admin ingest panels now exist.

| Area | Status (2026-07-15) |
|---|---|
| Documents in corpus | 4,661 — `sds` 2,958 + `product_line_profile` 1,703 |
| Chunks in corpus | 26,825 — all embedded on `embedding_large` (text-embedding-3-large / 3072) |
| Old `embedding` (1536) column | Dead (0 / 26,825) — slated for drop (B0-203) |
| Token counts | 100% populated |
| Entity link | SDS 2,119 / 2,958; all docs 3,822 / 4,661 (~82%) |
| `section_type` on chunks | ✅ Done (GHS categories) |
| Hybrid search / reranker / query rewriter / multi-intent | ✅ Implemented |
| Entity metadata enrichment | Partial — `dilution_code` 155, `coverage_sq_ft` 145, descriptions ~550 |
| Context assembly (entity hydration) | ✅ Done (`entity-context.ts`) |
| Structured facts | ✅ `rag.product_line_fact` (dilution/coverage backfilled) + `rag.product_efficacy` (empty until efficacy docs) |
| Product alias resolution | ✅ `rag.product_alias` (2,985 unambiguous aliases) |
| Knowledge (markdown) corpus | Ingest path built (`document_kind='knowledge'`); load pending S3 read creds |
| Eval harness | Populated (12 tests / 2,788 items); knowledge + dilution eval fixtures added |

---

## Phase 0 — Data Completeness ✅ MOSTLY DONE
**Goal:** Prepare the corpus before enrichment and retrieval improvements.

**Completed:**
- ✅ Two-pass entity_id backfill (exact + base-code strip) — 2,119 / 3,157 SDS docs linked (67%)
- ✅ Spanish (SP) + French (FR) SDS documents purged (1,091 docs / 9,294 chunks removed)
- ✅ Canadian (CAN) SDS documents retained
- ✅ Token counts backfilled — 100% populated
- ✅ B1xxx series: deferred — separate brand, no legacy data available; SDS docs remain in corpus and are text-searchable

**Remaining:**

### 0.1 — Fix null product_code documents
- Pull the 203 SDS documents where `metadata->>'product_code'` is NULL
- Re-examine source PDFs or filenames to extract the missing code
- Re-run entity linking pass on fixed documents
- **Deliverable:** `product_code` populated on all parseable SDS docs; entity_id link rate ≥ 70%+ for non-B1xxx corpus

### 0.2 — Verify section heading coverage
- Run `SELECT COUNT(*) FROM rag.document_chunk WHERE heading IS NULL` scoped to SDS docs
- If significant gaps, re-run `rag.enrich_sds_section_headings_batch()` to completion
- Confirm `section_path` is populated on ≥ 90% of SDS chunks
- **Deliverable:** heading + section_path populated on all parseable SDS chunks (prerequisite for section_type classification in Phase 1.3)

---

## Phase 1 — Entity & Chunk Enrichment
**Goal:** Add structured metadata to entities and classify chunks by section type.  
**Why:** Enables product-context-aware responses and section-type filtering in Phase 2.

### 1.1 — Enrich entity metadata from legacy
For each `rag.entity` where `entity_type = 'product_line'`:
- Join `legacy.products` on `entity.metadata->>'prod_line_id'` = `products.DSLProdLn`
- Aggregate per product line: take the web-available variant where present, else any active variant
- Write to `entity.metadata`:
  - `dilution_code` ← `products.DilutionCode`
  - `coverage_sq_ft` ← `products.Coverage_Usable_Gal_Sq_Ft`
  - `sku_count` ← count of variants
- Join `legacy.prod_line_descr` on product line key
- Write `description` ← `FullDescr`, `short_description` ← `ShortDescr`
- **Deliverable:** `dilution_code` and `coverage_sq_ft` populated on all linkable entity records

### 1.2 — Resolve product_direction_of_use join key
- Inspect `legacy.product_direction_of_use` schema and data to find the correct FK to product line
- Once resolved, write `directions_of_use` text to `entity.metadata`
- Consider also injecting direction text as a dedicated `document_kind = 'product'` chunk per product so it participates in vector search
- **Deliverable:** directions text in entity metadata; optionally chunked and embedded

### 1.3 — Classify chunk section_type
Add `section_type text` column to `rag.chunk` (migration).

Populate via rule-based mapping from `heading` and `section_path`:
```
heading ILIKE '%section 1%' OR '%identification%'  → 'identification'
heading ILIKE '%section 2%' OR '%hazard%'           → 'hazard'
heading ILIKE '%section 3%' OR '%composition%'      → 'composition'
heading ILIKE '%section 4%' OR '%first aid%'        → 'first_aid'
heading ILIKE '%section 7%' OR '%handling%storage%' → 'handling_storage'
heading ILIKE '%section 8%' OR '%exposure%'         → 'exposure_ppe'
heading ILIKE '%dilution%' OR '%use dilution%'      → 'dilution'
heading ILIKE '%direction%' OR '%how to use%'       → 'application'
```

Run in batches (2,000 rows) using a DB function similar to existing batch utilities.
- **Deliverable:** `section_type` populated on ≥ 85% of SDS chunks

### 1.4 — Add boolean metadata flags to chunks
Using `section_type` and keyword scan of `chunk_text`, populate `chunk.metadata`:
- `has_dilution_info` — `section_type IN ('dilution','application')` OR text matches ratio pattern
- `has_hazard_info` — `section_type IN ('hazard','composition')`
- `has_first_aid` — `section_type = 'first_aid'`
- **Deliverable:** metadata flags populated for use in downstream context assembly

---

## Phase 2 — Retrieval Improvements
**Goal:** Use the enriched data to improve search precision and context quality.  
**Why:** Entity scoping and section filtering are the two highest-leverage retrieval changes.

### 2.1 — Entity-scoped search in RPCs
Modify `match_corpus_chunks_hybrid` and `match_product_chunks_hybrid` RPCs to accept an optional `p_entity_id uuid` parameter. When provided, add `AND c.product_line_key = (SELECT product_line_key FROM rag.entity WHERE id = p_entity_id)` to the WHERE clause.

Update `searchProductChunks` in `search.ts` to pass `productLineKey` through to the RPC when set.

- **Deliverable:** entity-scoped search working end-to-end; orchestrator can pin a product context

### 2.2 — Section-type filtering in RPCs
Add optional `p_section_type text` parameter to the search RPCs. When set, filter `AND c.section_type = p_section_type`.

Update `SearchProductChunksOptions` and `searchProductChunks` with `sectionType?: string`.

- **Deliverable:** callers can request "only first_aid sections" or "only dilution sections"

### 2.3 — Entity hydration in context assembly
After retrieval, before LLM context construction, fetch entity metadata for all unique `entity_id` values in the result set. Prepend a structured product block:

```
[Product: Floor Science 309]
Dilution: 1:128 (1 oz per gallon)
Coverage: 3,200 sq ft/gal
Description: High-performance neutral floor cleaner for VCT and LVT
---
[SDS Section 7 — Handling & Storage]
...chunk text...
```

This gives the LLM grounded product facts without relying on the model to extract them from chunk text.

- **Deliverable:** context assembly function in `lib/rag/` that hydrates entity data per search result set

### 2.4 — Orchestrator integration
Update `run-orchestration.ts` and SME agents to:
- Pass `productLineKey` to `searchProductChunks` when the orchestrator has resolved a product entity from the conversation
- Pass `sectionType` when the query intent is clearly section-specific (first aid, dilution, hazard)
- Use the entity-hydrated context in the LLM prompt

- **Deliverable:** BEX chat responses include structured product context and respect product scope

---

## Phase 3 — Evaluation & Tuning
**Goal:** Quantify improvements with real data; establish baseline and regression detection.

### 3.1 — Build the gold eval set
Create test suites in the admin eval UI covering:
- 20 direct product lookup queries (varied phrasing)
- 20 section-specific queries (first aid, dilution, hazard, application)
- 10 abbreviation / colloquial queries (RTU, VCT, "green cleaner")
- 10 multi-product queries
- 10 negative queries (no expected match)

Each test item should have an `expected_entity_id` or `expected_section_type` to enable automated pass/fail beyond "returned any result".

- **Deliverable:** gold eval set in the database; reproducible A/B testing baseline

### 3.2 — A/B comparison: retrieval strategies
Run the gold set across all four strategy combinations:
- `vector`
- `hybrid`
- `vector+reranked`
- `hybrid+reranked`

Compare: `avg_similarity`, `top1_match_rate`, `elapsed_ms`. Pick the default strategy that maximizes match rate within the latency budget.

- **Deliverable:** documented strategy recommendation with data

### 3.3 — Multi-intent evaluation
Run targeted multi-intent queries against the gold set with and without `useMultiIntent = true`. Confirm it improves multi-product queries without degrading single-intent precision.

- **Deliverable:** go/no-go decision on enabling multi-intent by default

### 3.4 — Tune rewriter prompt
Review query rewrites for the gold set queries. Identify cases where the rewrite hurts retrieval (e.g., over-expands a specific product name). Adjust the system prompt constraints.

- **Deliverable:** rewriter prompt v2 with measurable improvement on the eval set

---

## Phase 4 — Ingestion Pipeline & Sync ⚠️ DEFERRED
**Status:** Deferred. No automated sync path between AWS SDS source and the database is currently available. Re-ingestion is a manual operation. Revisit when a sync mechanism or scheduled dump process is established.

**Goal:** Make the system maintainable as the corpus changes.

### 4.1 — Incremental SDS ingestion
Build an admin-triggered pipeline that:
1. Compares current `rag.document` records against the AWS SDS file list
2. Identifies new / changed PDFs
3. Re-parses, re-chunks, re-embeds, re-links only the delta
4. Preserves unchanged chunks (avoids unnecessary re-embedding cost)

- **Deliverable:** incremental ingestion route in `/api/admin/rag/ingest`

### 4.2 — Legacy data refresh
Build a refresh job that re-runs entity enrichment (Phase 1.1) when the legacy snapshot is updated. Should be idempotent — safe to run against unchanged data.

- **Deliverable:** `POST /api/admin/rag/enrich-entities` server action

### 4.3 — Staleness monitoring
Add a visible staleness indicator in the admin RAG UI:
- Last SDS ingestion date
- Last entity enrichment date
- Count of unlinked SDS documents
- Count of chunks missing `section_type`

- **Deliverable:** status panel on the admin RAG page

---

## Phase 5 — Production Hardening (defer until Phase 3 is complete)

- **Rate limiting** on the search API to prevent eval runs from starving chat traffic
- **Embedding cost tracking** — log token count per embedding call; alert if monthly spend spikes
- **Fallback behavior** — if Cohere reranker is unavailable, degrade gracefully to hybrid without error
- **Chunk size review** — after Phase 3 eval data, determine if current chunk sizes are optimal or if splitting/merging improves match rates
- **Model upgrade path** — document the process to swap `text-embedding-3-large` for a future model without losing existing embeddings

---

## Priority Order Summary

| Phase | Focus | Status | Blocks |
|---|---|---|---|
| **0** | Corpus cleanup + heading verification | ✅ Done | — |
| **1** | Entity enrichment + section_type classification | ✅ section_type done; enrichment partial | — |
| **2** | Entity-scoped search + context hydration | ✅ Shipped (search scope, section filter, `entity-context.ts` hydration) | — |
| **3** | Gold eval set + A/B measurement | 🔄 Harness populated; knowledge + dilution eval fixtures added | — |
| **4** | Incremental ingestion + staleness monitoring | 🔄 Partial — SDS + markdown-knowledge admin ingest panels exist | Full AWS sync still manual |
| **5** | Hardening | 🔄 Started — RLS enabled on 43 tables (B0-202) | Per-user thread ownership pending |

---

## Open Questions

1. **B1xxx product lines** — confirmed as a separate brand whose data did not transfer with the main product export. Deferred; SDS docs remain text-searchable without entity context.

2. **`product_direction_of_use` join key** — this table has valuable directions text but we haven't resolved the FK. Worth a dedicated investigation session.

3. **Chunk size** — current chunking strategy inherited from initial ingestion. Once we have eval data, it's worth measuring whether smaller (semantic sentence) or larger (full section) chunks perform better for BEX's query patterns.

4. **Non-English corpus** — retain or purge? Currently retained but excluded from search by dedup. Purging would simplify the data model and save ~81 chunks.
