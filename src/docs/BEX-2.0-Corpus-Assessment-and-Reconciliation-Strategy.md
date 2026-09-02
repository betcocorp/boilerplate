# BEX 2.0 — OneDrive Corpus Assessment & Product-Reconciliation Strategy

**Prepared for:** Tom Bird
**Date:** July 14, 2026 (v3 — grounded in the actual code)
**Scope:** Assess the legacy `Proj - BEX` OneDrive export for what's worth migrating into the Bex 2.0 RAG corpus, and pressure-test the proposed product-specialist retrieval strategy.

**Grounding provenance:**
- **v1** — documented architecture only (no code, no DB).
- **v2** — live Supabase project `gbkobtatfsjibkxebvdw` (schema, row counts, generated types).
- **v3 (this)** — the actual repo, mounted locally (`bex2.0/`, branch `dev`, HEAD `9ae36e57` "feat(recommendations): LLM competitor-spec enrichment on the heuristic extractor (B0-86)"). Every claim about retrieval logic below is now read from source, not inferred.

---

## 0. Headline

**The strategy you proposed is already built — and it's more sophisticated than the description.** The "semantic search → top 3 → must be different → decide which pieces → return to the LLM" flow maps almost line-for-line onto `ragQueryForProductKnowledgeWithMeta` (`lib/retrieval/product-knowledge.ts`). So the work is **not** designing that flow; it's (a) making its fixed knobs intent-driven and (b) filling the one real hole: **structured facts (efficacy/dilution) are never joined — retrieval is text-only.**

---

## 1. Your mental model → the code that already implements it

| Your description | What actually exists | File |
|---|---|---|
| "run semantic search, get top 3 closest chunks" | `ragQueryForProductKnowledgeWithMeta`, `DEFAULT_UNIQUE_DOCUMENT_LIMIT = 3` — but each "source" is a **full document reassembled from all its chunks**, not a lone chunk | `product-knowledge.ts`, `document-assembly.ts` |
| "must be 3 different products" | `selectCuratedMatches(..., { maxPerDocument: 1 })` → 3 **unique parent documents** (diversity cap), not a literal product-distinctness rule | `source-selection.ts` |
| "find the closest matching products" | `resolveProductLineFromMatches` — confidence-gated **product-line lock** (abs ≥ 0.64, or ≥ 0.50 with ≥ 0.06 margin over runner-up), top-3 candidates, env-tunable | `product-line-resolution.ts` |
| "decide which pieces (efficacy, SDS, dilution) it needs" | `requiredDocumentKinds: ['product_line_profile','sds']` guarantees a profile + an SDS; task-specific retrievers add GHS `sectionType` filtering | `product-knowledge.ts`, `product-guidance.ts` |
| "get all the data and return it to the LLM" | Curated `CuratedSource[]` (full `documentBody` + entity metadata + `entityContextBlock`) returned as the function-tool result | `product-knowledge.ts`, `tools/definitions.ts` |

The retrieval pipeline underneath is well past a naive similarity search: **query rewrite** (domain synonym expansion, GPT-4.1-mini), an **embedding cache** (exact / rewritten / approximate via `find_similar_search_embedding`), **hybrid BM25+vector**, an optional **cross-encoder reranker**, and **multi-intent decomposition** that splits "what's the dilution for X and is it safe on VCT?" into sub-queries and merges results (`search.ts`). It also runs a **broad → lock → anchored re-search → broad-fallback** state machine, so a confident product match narrows retrieval to that line but degrades gracefully when ambiguous.

**Confirms v2 from the DB side:** search reads `embeddings_large` only (the 3072/halfvec column) — the old `embedding` column is genuinely dead. Default `scope` is `products` → `match_product_chunks`; `scope:'all'`/`'sds'` → `match_corpus_chunks` (both have `_hybrid` variants). So v2's RPC note was scope-dependent, now confirmed.

---

## 2. What this changes about the v1/v2 recommendations

**Correction — "drop the fixed 3 / 3-distinct rule" was aimed at something that doesn't exist as a naive filter.** There is no "3 distinct products" post-filter. What exists is a tunable unique-**document** limit (`maxPerDocument: 1`) plus a real confidence-gated resolver and fallback. The mechanism is sound. The refinement that still holds, precisely located: `limit`, `maxPerDocument`, and `requiredDocumentKinds` are **fixed defaults applied regardless of intent**. Consequences:
- A **single-product deep-dive** ("everything about pH7Q") is still capped at 3 unique docs and forced to spend one slot on an SDS.
- A **comparison** ("Squeaky vs Game Time") isn't modeled at this layer — it leans entirely on multi-intent decomposition in `search.ts`, which splits by *question*, not by *named entity*.
- A **category** question is actually handled elsewhere and well — `find_products_by_category` / `get_products_in_category` map to the `public.product_category` taxonomy **deterministically, no embeddings** (the 156/464 rows from v2).

The fix is small and in the right layer: let the SME tool pass intent-derived `limit` / `maxPerDocument` / `requiredDocumentKinds` into `ragQueryForProductKnowledgeWithMeta`, rather than changing the mechanism.

**The real gap (now confirmed in code): reconciliation of *facts* doesn't happen — assembly is text-only.**
`assembleDocumentBodies` stitches chunk **text** by `document_id`; `buildCuratedSource` carries `entityId`, `productLineKey`, and `productKey` as metadata — but **nothing joins the structured fact columns** (`dilution_oz_per_gal`, `contact_time_seconds`, `chemistry_class`, `epa_registration`) or any efficacy table, and **no tool returns structured facts**. `search_product_docs` accepts `topic: "dilution"` / `"kill claims"`, but that just biases prose retrieval. So today a kill-claim or dilution answer is produced from **paragraph text inside an SDS/profile body** — precisely the "confidently wrong" failure mode v1 warned about.

This is the highest-value change and it's now pinpointed: add a **structured-fact fetch keyed on `entity_id` / `product_line_key`**, merged into `CuratedSource`. Every match already carries those keys, so there's a clean place to hang it — no re-plumbing.

**Product tier is confirmed absent — joins are on `product_line_key`.** `rag.entity` is 100% `product_line`; the resolver, RPC filters, and every `CuratedSource` operate at product-line granularity. Note `filter_product_key` is passed as `undefined` everywhere in `search.ts` — product-level filtering is plumbed through the RPC signature but **dormant**. So "join on `product_id`" is a future step gated on a product-tier entity; "join on `product_line_id`" is available now.

> **SUPERSEDED 2026-09-02 (B0-203) — the paragraph above is stale on both counts; verified against the live DB.**
>
> **A product tier exists.** `rag.entity` holds 9,237 `entity_type = 'product'` rows alongside 1,703 `product_line` rows. They were seeded from label ingestion, and 131 of them carry a `metadata->>'sds_number'`.
>
> **`filter_product_key` is no longer dormant — it is live in the production path, and it stays.** B0-250 (`20260724130000_add_filter_product_key_to_corpus_match.sql`) added the parameter to the `match_corpus_chunks*` family; all four live `match_*` RPCs now declare it, with exactly one overload each. `product-tools.ts` resolves a `productKey` via `resolveProductEntityWithAliasTelemetry` and threads it through `retrieveApprovedUsage` / `retrieveSafetyConstraints` / `ragQueryForProductKnowledgeWithMeta` into `searchProductChunks`, and `/api/rag/search` accepts it straight off the request body.
>
> **Decision: keep it activated, do not tighten it, do not remove it.** The reason it is safe today is the B0-250 fallback in `runProductKnowledgeQuery` (`~/lib/retrieval/product-knowledge.ts`), which re-runs the search line-scoped whenever `curated.length === 0 && explicitProductKey`. That fallback is load-bearing, because the product tier is *reachable but thin*: only 254 documents / 2,045 chunks hang off `product` entities, against 3,888 documents / 16,595 chunks at the `product_line` tier, and only 384 of 1,703 `product_line` rows carry a `product_key` at all. The RPC predicate is `e.product_key = :key OR d.metadata @> {variant_product_keys:[:key]}`, so a product-key filter applied without the fallback would zero out ~89% of the corpus. **Removing the empty-result fallback, or making the filter a hard pre-filter, is the specific regression to guard against** — this is the same product_line-vs-SKU tier trap recorded for `get_efficacy_data`. Revisit only when chunks are attached at the product tier in bulk.

**SME agents — there are five now, and dilution is a stub.** `SME_AGENT_IDS = ['product','bathroom','dilution','floor','recommendations']`. `dilution` is registered with a route (`/api/v1/agents/dilution`) but is labeled "(stub)" in `V1_AGENT_REGISTRY` — enumerated, not implemented. `recommendations` is new (competitor cross-reference via `lookup_cross_reference` + `public.cross_reference_override`), matching the B0-86 HEAD commit.

---

## 3. Keep vs. throw away (unchanged — still valid)

**Keep / migrate:** all 56 non-archive `.md` files (net-new knowledge kind); the efficacy matrix → future structured table + populate the existing dilution/contact columns; "Top 100 Should/Shouldn't" + Q&A pairs → `/admin/tests` eval sets; SME `.msg` threads → curated edge-case notes; tech-sheet/SDS PDFs → gap-fill + citations.

**Throw away:** the entire `0 - Archive/` tree, non-final spec drafts, PM trackers/timesheets, near-duplicate md pairs.

**Concrete ingest touchpoint (new in v3):** the corpus has exactly two `document_kind`s (`sds`, `product_line_profile`), and `requiredDocumentKinds` is **hardcoded** to those two in `product-knowledge.ts`. Ingesting how-to/troubleshooting/FAQ therefore requires (a) a new `document_kind` (e.g. `knowledge`) at ingest, and (b) either adding it to the required-kinds set or exposing it via a dedicated retriever. Without step (b), newly ingested knowledge would be retrievable but never *guaranteed* a slot in the curated bundle.

---

## 4. Recommended sequence (code-anchored)

1. **Ingest the 56 md files** as a new `knowledge` `document_kind` with product-line-resolved metadata; add it to `requiredDocumentKinds` (or a `retrieveKnowledge` helper in `product-guidance.ts`). *Highest ROI, unblocked, fills the corpus's missing content category.* Admin ingest flow (S3 `retool-360/v1-markdown-files`, modeled on the SDS pipeline) is designed in **`BEX-2.0-Markdown-Ingest-Admin-Panel-Design.md`**; the fact-join is in **`BEX-2.0-Structured-Fact-Join-Design.md`**.
2. **Product alias/synonym table** → resolve "Squeaky®", "Game Time®", "pH7Q" to `product_line_key`; feeds the resolver and lets `search_product_docs`/tools anchor by name.
3. **Structured-fact join** → new fetch keyed on `entity_id`/`product_line_key`, merged into `CuratedSource`; back it with the existing (currently near-empty) `rag.document` fact columns and a future `product_efficacy` table. *This is the actual reconciliation fix.*
4. **Intent-driven curation** → let the SME tool pass `limit`/`maxPerDocument`/`requiredDocumentKinds`; add explicit multi-entity handling for comparisons.
5. **Eval sets** from "Top 100 / Q&A" as a regression gate (harness already holds 2,788 items).
6. **Efficacy structured lane** when source docs are ready; until then, gate efficacy answers to "no verified data" rather than answering from prose.
7. **Housekeeping** — drop dead `embedding`/`embedding_model` columns; link the 839 orphan SDS docs; activate the dormant `filter_product_key` only once a product tier exists.

   > **CLOSED 2026-09-02 (B0-203).** All three verified against the live DB.
   > 1. **Dead columns: already gone.** Dropped by B0-218 (`20260715094000_sync_sds_chunks_drop_dead_embedding_cols.sql`). `rag.document_chunk` has no `embedding` / `embedding_model` today, `src/types/supabase.rag.ts` is regenerated clean, and nothing in `src/` references either name.
   > 2. **Orphan SDS: the backlog is a scope problem, not a linking problem.** The count is 1,110 (not 839). 697 sit outside the `Betco SDS/` policy prefix (Basic/Raw Material/etc., already deactivated by the B0-243 purge). Of the 413 the path policy calls in-scope, **299 are French, Spanish or Italian sheets mis-recorded as `language_code = 'EN'`** — filed as `<code>FR.pdf` / `<code>SP.pdf` under `Chemtrec SDS files ready to transfer/` and `Archive SDS/`, which the folder-keyword filter misses. 254 of them *would* match a product line if the suffix were stripped, and doing so would attach foreign-language safety data to English product lines — so they are declined, not linked. This is exactly the false-negative class `policy.ts` warns about, and it wants a follow-up rescope/purge ticket. The remaining ~108 are Specials/custom blends (`SP*`, `MSP*`, `WTP*`, `GTS*`, `RSS*`), `F0*` kit and promo-pack sheets, purchased reagents, supplier sheets and two non-SDS artifacts (a Chemtrec submission form, an ADA compliance doc) — **none of their codes exist in `legacy.prod_line` at all** (5,109 rows, 1,703 distinct ids, all 1,703 materialised into `rag.entity`), so there is nothing to link them to. Backfill: `scripts/b0203-orphan-sds-link.mjs`.
   > 3. **`filter_product_key`: already live, decision is to keep it.** See the superseding note above.

**One-line summary:** the find-then-assemble pipeline you described already exists and is solid; the win is joining **structured facts** on `product_line_key` (not more prose), ingesting the missing **knowledge** document kind, and making the curation knobs **intent-driven** — none of it a rebuild.

---

## 5. Security finding (carried from v2 — still open)

Row-Level Security is disabled on 43 tables, including `agent_conversations`, `agent_messages`, `audit_logs`, and the entire `rag` corpus — anyone with the anon key can read/modify every row. Code confirms server paths run through the Supabase **service role** (`getSupabaseServiceRoleClient()`), so enabling RLS won't break them, but policies must be added before enabling. This is roadmap goal #4 and is live in production. Full `ALTER … ENABLE ROW LEVEL SECURITY` + starter-policy script available on request.

---

## 6. Reconciliation with the existing RAG docs

Three prior docs live in `src/docs/`: `rag-specification.md` (end-state design), `rag-execution-plan.md` (May 2026 roadmap), and `rag-data-relationships.md` (source→RAG data map). They remain useful, but they predate the current `dev` code and the live DB and have drifted. This section reconciles them so the six docs read as one set.

### 6.1 Terminology map (their term → live term)

| Prior docs | Live schema / code |
|---|---|
| `rag.chunk` | **`rag.document_chunk`** |
| `document_kind` = `'product'` / `'tds'` | **`'product_line_profile'`** (no `'tds'` exists) |
| "embeddings_large column implies model version" | correct — `embedding_large` (halfvec 3072) is the **only** populated vector; the old `embedding` column is dead |
| "RRF fusion" (spec §5.1) | hybrid via `match_*_chunks_hybrid` RPCs (confirm fusion method in RPC body) |

### 6.2 Stale figures (snapshots disagree with each other and with live)

| Metric | data-relationships | execution-plan (May) | **Live (July, measured)** |
|---|---|---|---|
| `rag.document` | 4,248 | 3,157 SDS + 1,703 profiles | **4,661** (2,958 SDS + 1,703 profiles) |
| chunks | 49,532 | 35,080–40,238 | **26,825** (100% on `embedding_large`) |
| SDS entity-link | 2,973 / 4,248 (70%) | 2,119 / 3,157 (67%) | **2,119 / 2,958 SDS**; 3,822 / 4,661 all docs |

The corpus **shrank** (further SP/FR purge + re-chunk) since those docs — treat all three prior snapshots as historical; this assessment's numbers are current.

### 6.3 Status drift — execution-plan phases already shipped in code

The May plan lists these as "Not done"/"Queued"; the code says otherwise:

- **1.1 entity enrichment** — *partially done*: `entity.metadata` now has `dilution_code` (155 lines), `coverage_sq_ft` (145), descriptions (~550).
- **1.3 `section_type`** — *done*: `document_chunk.section_type` exists with the GHS categories.
- **2.1 entity-scoped search** — *done*: `match_product_chunks(_hybrid)` take `filter_product_line_key`; `search.ts` passes it.
- **2.2 section-type filtering** — *done*: `sectionType` plumbed through `search.ts` → `product-knowledge.ts` → tools (`inferSectionTypeFrom*`).
- **2.3 entity hydration** — *done*: `entity-context.ts` (`fetchEntityContexts`/`buildEntityContextBlock`) **is** the spec §5.5 / plan §2.3 "structured product block."
- **4.1 ingestion pipeline** — *no longer fully deferred*: the SDS admin pipeline (`admin/sds/pipeline.ts`) exists; the markdown-ingest design extends that pattern.

### 6.4 How my three docs relate (no duplication)

- **This assessment** supersedes the prior snapshots as the current, code+DB-grounded state; keep the spec as the *aspirational* end-state reference.
- **`BEX-2.0-Structured-Fact-Join-Design.md`** *evolves* spec §3.4/§5.5 and plan §1.1/§2.3: it takes their loose `entity.metadata` enrichment and promotes it to **typed, cited** tables (`product_line_fact`) plus a **`product_efficacy`** model the prior docs don't cover at all.
- **`BEX-2.0-Markdown-Ingest-Admin-Panel-Design.md`** *realizes* plan Phase 4.1 for a new `knowledge` source, modeled on the shipped SDS pipeline.

**Recommendation:** refresh the `Current State Snapshot` table in `rag-execution-plan.md` and the counts in `rag-data-relationships.md` from the live figures in §6.2, and rename `rag.chunk` → `rag.document_chunk` in the spec. I can patch those in place on request.
