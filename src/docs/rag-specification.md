# BEX RAG System — Technical Specification

> **Purpose:** Define the end-state architecture, data model, and operational behavior of the BEX retrieval-augmented generation system. This document is the authoritative reference for what the system should look like when complete.
>
> **Updated 2026-07-15 (live reconciliation — see `BEX-2.0-Corpus-Assessment-and-Reconciliation-Strategy.md` §6).** Naming/values reconciled to the live schema: the chunk table is `rag.document_chunk` (renamed throughout this doc); live `document_kind` values are `sds`, `product_line_profile`, and `knowledge` (there is no `tds`/`product`); the live vector column is `embeddings_large` (halfvec 3072) — the old 1536 `embedding` column is dead. Live counts: 4,661 documents, 26,825 chunks. Structured facts now live in `rag.product_line_fact` / `rag.product_efficacy`; name→line resolution via `rag.product_alias`.

---

## 1. Goals

BEX is an AI assistant for commercial cleaning professionals. The RAG layer is responsible for surfacing accurate, specific product and safety information from Betco's document corpus in response to natural-language queries.

**The system must:**
- Return the correct SDS section (hazard, dilution, first aid, ingredients, application) for a given product and query intent
- Handle vague or multi-part queries without losing precision on product identity
- Distinguish between product lines, SKU variants, and regulatory document versions
- Surface structured data (dilution ratios, coverage, dwell time) in a form the LLM can use directly
- Remain accurate as the document corpus and product catalog evolve

**The system must not:**
- Confuse chemically similar products from different product lines
- Surface non-English SDS content as primary results (English is the operational language)
- Lose context when a user's query spans multiple intents (e.g., "dilution for X and shelf life of Y")

---

## 2. Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| Top-1 match rate (eval set) | ≥ 90% | Search eval runs in admin UI |
| Top-5 match rate (eval set) | ≥ 97% | Search eval runs |
| Entity link coverage | 100% of ingestable SDS docs | `rag.document.entity_id IS NULL` count |
| Avg similarity score | ≥ 0.78 | `test_results.avg_similarity` |
| P95 query latency | < 800 ms | `timings.totalMs` in search result |
| Chunk token coverage | 100% | `rag.document_chunk.token_count IS NULL` count |
| Stale content age | < 90 days | last ingestion timestamp vs current date |

---

## 3. Data Architecture

### 3.1 Entity Model

Entities represent canonical product lines — the single unit of identity that anchors all SDS documents, product variants, and marketing data.

```
rag.entity
├── id                  UUID PK
├── entity_type         'product_line'
├── canonical_key       UUID  (= legacy prod_line.ProdLineKey)
├── product_line_key    UUID  (same as canonical_key for product_line type)
├── title               product line display name
└── metadata (jsonb)
    ├── prod_line_id         alphanumeric line ID (e.g. "4020")  ← primary join key
    ├── dilution_code        structured dilution string from legacy
    ├── coverage_sq_ft       numeric coverage from legacy
    ├── description          product line description (from prod_line_descr)
    ├── short_description    short form description
    ├── directions_of_use    full directions text (from product_direction_of_use)
    ├── web_available        boolean
    ├── variant_count        integer
    └── source_schema        'legacy'
```

**Design rule:** one entity per product line, regardless of how many SKU variants (sizes, packaging) exist. Variants are tracked in `variant_product_keys` but do not get their own entity records.

### 3.2 Document Model

```
rag.document
├── id                  UUID PK
├── document_kind       'sds' | 'product_line_profile' | 'knowledge'
├── entity_id           → rag.entity.id  (required for sds/product)
├── document_key        unique string key
├── source_url          canonical URL to the source PDF or page
└── metadata (jsonb)
    ├── product_code         product line ID (e.g. "4020")
    ├── language_code        'EN' | 'ES' | 'FR' | 'CAN'
    ├── variant_suffix       null | 'CAN' | 'SP' | 'FR' | 'BO'
    ├── source_system        'aws_sds' | 'legacy_cms' | 'manual'
    ├── ingested_at          ISO timestamp of last ingestion
    └── title                document display title
```

**Design rule:** every SDS document must have `entity_id` set. Documents with an unresolvable `product_code` (B1xxx series not in entity table) require the entity record to be created before the document can be linked.

### 3.3 Chunk Model

```
rag.document_chunk
├── id                   UUID PK
├── document_id          → rag.document.id
├── product_line_key     UUID  (→ rag.entity.product_line_key, denormalized for query perf)
├── chunk_index          integer  (position within document)
├── heading              text | null  (resolved GHS section heading)
├── section_path         text[]  (breadcrumb from document root, e.g. ["Section 7", "Handling"])
├── section_type         text | null  ← NEW: normalized semantic category
├── chunk_text           raw text content
├── token_count          integer  (ceil(len / 4), always populated)
├── embeddings_large     halfvec(3072)  (text-embedding-3-large)
└── metadata (jsonb)
    ├── has_dilution_info    boolean  (chunk mentions a dilution ratio)
    ├── has_hazard_info      boolean  (chunk is in Section 2/3 GHS)
    ├── has_first_aid        boolean  (chunk is in Section 4 GHS)
    └── surface_types        text[]   (floor, carpet, bathroom, etc. — if detectable)
```

**`section_type` values** (normalized from SDS GHS headings):
| section_type | GHS source sections |
|---|---|
| `identification` | Section 1 |
| `hazard` | Section 2 |
| `composition` | Section 3 |
| `first_aid` | Section 4 |
| `fire_fighting` | Section 5 |
| `spill_response` | Section 6 |
| `handling_storage` | Section 7 |
| `exposure_ppe` | Section 8 |
| `physical_properties` | Section 9 |
| `stability` | Section 10 |
| `toxicology` | Section 11 |
| `regulatory` | Sections 14–15 |
| `application` | Non-GHS: usage / directions |
| `dilution` | Non-GHS: dilution / concentration |

### 3.4 Metadata Enrichment Sources

| Data | Source table | Join path | Status |
|---|---|---|---|
| Product line title | `legacy.prod_line` | `entity.canonical_key` = `prod_line.ProdLineKey` | Ingested |
| Dilution code | `legacy.products` | `entity.metadata->>'prod_line_id'` = `products.DSLProdLn` | Not yet enriched |
| Coverage (sq ft/gal) | `legacy.products` | Same | Not yet enriched |
| Full description | `legacy.prod_line_descr` | Product line key | Not yet enriched |
| Directions of use | `legacy.product_direction_of_use` | TBD (join key unresolved) | Not yet enriched |
| Section type tag | Derived from `heading` / `section_path` | Rule-based mapping | Not yet applied |
| Dilution/hazard flags | Derived from `chunk_text` | Keyword/regex classification | Not yet applied |

---

## 4. Ingestion Pipeline

### 4.1 SDS Documents (AWS source)

```
AWS S3 / sds.betco.com
  │
  ▼
PDF extraction (section-aware chunker)
  │  - Detect GHS section boundaries from headings
  │  - Preserve section_path breadcrumb per chunk
  │  - Assign chunk_index within document
  │
  ▼
rag.document  (upsert by document_key)
  │  - Set document_kind = 'sds'
  │  - Extract product_code from filename convention: "{code}[VARIANT].pdf"
  │  - Detect language_code from variant suffix
  │
  ▼
Entity linking  (run on every new/updated document)
  │  - Pass 1: exact  product_code = entity.metadata->>'prod_line_id'
  │  - Pass 2: base-code strip (remove CAN/SP/FR/BO/FR2 suffix) then match
  │  - If still unlinked: create entity record if product line data exists
  │
  ▼
rag.document_chunk  (upsert by chunk_key)
  │  - Classify section_type from heading/section_path
  │  - Set has_dilution_info, has_hazard_info, has_first_aid flags
  │  - Compute token_count
  │
  ▼
Embedding  (text-embedding-3-large → halfvec(3072))
  │  - Embed chunk_text (plain text, no prefix injection)
  │  - Cache embedding in search_embedding table
  │
  ▼
Index maintenance  (HNSW + BM25 tsvector)
```

### 4.2 Entity Enrichment (legacy source)

Runs independently of SDS ingestion. Enriches `rag.entity.metadata` from the legacy snapshot:

```
legacy.products   (grouped by DSLProdLn, pick active/web-available variant)
  │  - DilutionCode → entity.metadata.dilution_code
  │  - Coverage_Usable_Gal_Sq_Ft → entity.metadata.coverage_sq_ft
  │
legacy.prod_line_descr
  │  - FullDescr → entity.metadata.description
  │  - ShortDescr → entity.metadata.short_description
  │
legacy.product_direction_of_use  (once join key resolved)
  │  - Direction text → entity.metadata.directions_of_use
  │  - Also consider injecting as a dedicated 'product' document kind chunk
```

### 4.3 Re-ingestion Triggers

| Trigger | Action |
|---|---|
| New SDS PDF available in AWS | Ingest document, chunk, embed, link entity |
| Legacy product data refresh | Re-run entity enrichment for changed records |
| GHS heading backfill correction | Re-classify section_type on affected chunks |
| Embedding model upgrade | Full re-embed (track model version per chunk) |

---

## 5. Retrieval Pipeline

### 5.1 Query Processing

```
Raw user query
  │
  ▼
Normalize  (trim, collapse whitespace)
  │
  ▼
Cache lookup  (search_embedding by query_string / query_rewritten)
  │  Hit path: skip rewrite + embed → use cached embedding
  │  Near-miss path: cosine similarity on cached queries ≥ threshold
  │
  ▼  (cache miss)
Query rewrite  (gpt-4.1-mini, Betco domain prompt)
  │  - Expand abbreviations: RTU, VCT, LVT, SDS, GHS, EPA, HCS
  │  - Preserve product names/SKUs exactly
  │  - Add domain synonyms (degreaser → degreaser OR cleaner degreaser)
  │  - Output: one plain-text retrieval query ≤ 20 words
  │
  ▼
Multi-intent detection  (optional, gpt-4.1-mini)
  │  If query decomposes into distinct sub-intents:
  │  - Generate sub-queries in parallel
  │  - Embed each independently
  │  - Merge results by chunk_id (keep max similarity)
  │
  ▼
Embed  (text-embedding-3-large)
  │
  ▼
Hybrid search  (default)
  │  - Vector: cosine similarity via HNSW on halfvec(3072)
  │  - BM25: full-text search via tsvector
  │  - Fusion: Reciprocal Rank Fusion (RRF)
  │  - Scope: 'all' | 'products' | 'sds'
  │  - Filter: entity_id (when product context known), section_type (when intent specific)
  │
  ▼
Rerank  (Cohere rerank-v3.5, optional)
  │  - Applied when useReranker = true
  │  - Cross-encoder scoring against original query
  │
  ▼
Dedup  (SDS-specific)
  │  - Collapse identical SDS sections from variant language documents
  │  - Key: normalize(title) + chunk_index + normalize(text[0:280])
  │
  ▼
Return RagSearchResult
```

### 5.2 Retrieval Strategy Selection

| Scenario | Strategy |
|---|---|
| Default / general query | `hybrid` |
| High-precision regulatory query | `hybrid+reranked` |
| Product lookup by name/SKU | `hybrid` (product scope) |
| Multi-part query | `hybrid` with multi-intent fan-out |
| Latency-sensitive path | `vector` |

### 5.3 Entity-Scoped Search

When the orchestrator has identified a product context (e.g., user is asking follow-up questions about a specific product), pass `productLineKey` to narrow retrieval to that entity's documents.

```typescript
searchProductChunks({
  query: "dilution ratio for hard floors",
  productLineKey: "E089A9B2-...",  // entity.product_line_key
  scope: "sds",
  useHybrid: true,
})
```

This translates to an RPC filter `WHERE product_line_key = $productLineKey` before similarity ranking.

### 5.4 Section-Type Filtering (future)

When query intent clearly maps to a GHS section:

| Query intent detected | section_type filter |
|---|---|
| "is it safe / hazards" | `hazard` |
| "dilution / how much to use" | `dilution` |
| "first aid / swallowed / eyes" | `first_aid` |
| "ingredients / what's in it" | `composition` |
| "how to apply / directions" | `application` |
| "storage / shelf life" | `handling_storage` |

Filter applied as an additional `AND section_type = $type` in the RPC before ranking.

### 5.5 Context Assembly for LLM

After retrieval, before passing to the LLM:

1. **Hydrate entity data** — for each unique `entity_id` in matches, fetch `title`, `dilution_code`, `coverage_sq_ft`, `description` from `rag.entity.metadata`. Prepend as a structured product context block.
2. **Deduplicate across document kinds** — if both a product doc and an SDS doc return the same information, prefer the SDS chunk (more authoritative for safety/regulatory).
3. **Annotate source** — each chunk passed to the LLM includes `document_kind`, `heading`, `section_path` as metadata so the LLM can cite correctly.

---

## 6. Evaluation Framework

### 6.1 Eval Set Structure

A test in the admin eval framework consists of:
- A list of `test_items`, each with a `prompt` (the query) and optionally an `expected_product_code` or `expected_section_type`
- A `run_options` config (`useHybrid`, `useReranker`, `useMultiIntent`)
- Stored `retrieval_strategy` for A/B comparison

### 6.2 Test Categories

| Category | Example queries | Pass criterion |
|---|---|---|
| Direct product lookup | "Symplicity bathroom cleaner dilution" | Top-1 matches correct entity |
| Section-specific | "First aid for Floor Science ingestion" | Top-1 is `first_aid` section |
| Abbreviation handling | "RTU ratio for VCT floors" | Returns results (not empty) |
| Multi-product query | "Dilution for 309 and 473" | Both products in top-5 |
| Vague/colloquial | "Green cleaner for tile" | ≥ 1 result, similarity ≥ 0.72 |
| Negative / no match | "How do I change my password" | Empty results or low similarity |

### 6.3 A/B Comparison Workflow

1. Run same test with two different `run_options` configurations
2. Compare `avg_similarity`, `passed_items`, `elapsed_ms` across `retrieval_strategy` values
3. Promote winning strategy as the new default in the application

---

## 7. Operational Considerations

### 7.1 Data Freshness

The system is not live-synchronized. Ingestion is triggered manually or on a schedule:
- **SDS content:** re-ingest when Betco updates the AWS SDS dump (~quarterly)
- **Legacy product data:** re-enrich entities when the legacy snapshot is refreshed
- **Target cadence:** monthly re-ingestion check; full re-embed only on model version change

### 7.2 Embedding Model Versioning

All chunks carry an implicit model version via the embedding column name (`embeddings_large` = `text-embedding-3-large`). If the model is upgraded:
- Add a new halfvec column (or update in place with a migration flag)
- Re-embed all chunks in batches
- Do not mix model versions in a single RPC call

### 7.3 Missing Entity Coverage

SDS documents that cannot be linked to an entity (because the product line does not exist in `rag.entity`) must be handled as follows:
- Documents remain in `rag.document` and are searchable by text
- They will not be returned in entity-scoped searches
- Remediation: create the missing entity record from legacy data or manual entry

Current unlinked categories:
- `B1xxx` product series (~600 SDS docs) — product lines exist in SDS but not in entity table
- Null `product_code` docs (203) — ingestion parsing gap, needs PDF re-processing

### 7.4 Language Policy

English (US) is the primary retrieval language. Non-English SDS variants (CAN, SP, FR, BO) are retained in the corpus for completeness but are excluded from search results by the deduplication pass that prefers the base-code English version. Language filtering at query time has been removed (the 5 ES documents in the corpus represent 0.16% and do not justify per-query DB overhead).
