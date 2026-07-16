# RAG / SDS / Legacy Data Relationships

> **Data freshness** — SDS PDFs sourced from AWS (~Feb–Mar 2026 dump). Legacy product data snapshot taken January 2026. Neither source is live-synchronized; both are point-in-time.
>
> **Updated 2026-07-15 (live reconciliation — see `BEX-2.0-Corpus-Assessment-and-Reconciliation-Strategy.md` §6).** Live counts: `rag.document` 4,661 (2,958 sds + 1,703 product_line_profile); `rag.document_chunk` 26,825 (all on `embeddings_large`); entity-link ~82% overall. The `rag.chunk` name below is now `rag.document_chunk`.

---

## Schema overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  SOURCE SYSTEMS                                                              │
│                                                                              │
│  AWS S3 (SDS PDFs)            Legacy CMS DB (January 2026 snapshot)         │
│  ─────────────────            ─────────────────────────────────────         │
│  Betco SDS portal             legacy.products                                │
│  sds.betco.com/sds/…          ProductsKey (UUID PK)                         │
│  Parsed → rag.document        DSLProdLn  ◄──── product line ID              │
│                               DilutionCode, Coverage_Usable_Gal_Sq_Ft       │
│                               Title, H1, H2, MetaDescription                │
│                               SKU, SLDescr                                  │
│                                                                              │
│                               legacy.documents                               │
│                               DocumentsKey (UUID PK)                        │
│                               DocTypesKey = CB585A6F… → SDS type            │
│                               FileName  = "{product_code}[VARIANT].pdf"     │
│                               LinkName  = base URL to SDS portal            │
│                               LanguageKey → language variant                 │
│                                                                              │
│                               legacy.related_products                        │
│                               Links products ↔ product lines only           │
│                               (does NOT link to documents)                   │
│                                                                              │
│                               legacy.prod_line_descr                         │
│                               FullDescr, ShortDescr per product line         │
│                                                                              │
│                               legacy.product_direction_of_use                │
│                               Rich usage / dilution directions text          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## RAG schema

```
rag.entity  (1,703 rows — entity_type = 'product_line')
┌────────────────────────────────────────────────────────┐
│ id                    UUID PK                          │
│ canonical_key         = product_line_key (UUID)        │
│ product_line_key      UUID → legacy.prod_line.ProdLine │
│ title                 product line name                │
│ metadata->>'prod_line_id'   ◄── alphanumeric line ID  │
│                             e.g. "4020", "H615", "668" │
└────────────────────────────────────────────────────────┘
        ▲                         ▲
        │ entity_id               │ product_line_key
        │                         │
rag.document  (4,661 — 2,958 sds + 1,703 product_line_profile)
┌────────────────────────────────────────────────────────┐
│ id                    UUID PK                          │
│ document_kind         'sds' | 'product_line_profile'   │
│ entity_id             → rag.entity.id  (~82% populated)│
│ metadata->>'product_code'  e.g. "4020", "248SP"        │
│ metadata->>'title'                                     │
│ metadata->>'source_url'    full PDF URL                │
└────────────────────────────────────────────────────────┘
        │
        │ document_id  (1:many)
        ▼
rag.document_chunk  (26,825 rows — all embedded on embeddings_large)
┌────────────────────────────────────────────────────────┐
│ id                    UUID PK                          │
│ document_id           → rag.document.id                │
│ product_line_key      UUID → rag.entity.product_line_key│
│ chunk_text            raw text                         │
│ embeddings_large      halfvec(3072)                    │
│ token_count           integer (all populated)          │
│ heading, section_path, chunk_index                     │
└────────────────────────────────────────────────────────┘
```

---

## Cross-schema join paths

### 1 — SDS chunk → product entity (search-time)
```
rag.document_chunk.document_id
  → rag.document.entity_id
    → rag.entity.id
```
Status: **~82% of documents linked** (3,822 / 4,661); SDS-specific 2,119 / 2,958. (May-2026 snapshot reported 2,973 / 4,248.)

### 2 — SDS document → legacy product line (enrichment)
```
rag.document.metadata->>'product_code'   (e.g. "4020")
  = rag.entity.metadata->>'prod_line_id'
  = legacy.products.DSLProdLn
```
Use this to pull `DilutionCode`, `Coverage_Usable_Gal_Sq_Ft`, marketing copy from `legacy.products`.

### 3 — Legacy SDS catalog → product (legacy-side only)
```
legacy.documents.FileName  strip ".pdf" + variant suffix (CAN/SP/FR/BO)
  = legacy.products.DSLProdLn
```
`related_products` does NOT link documents to products — it only links products to product lines.

---

## entity_id backfill — coverage breakdown

| Category | Docs | Notes |
|---|---|---|
| Exact `product_code` match | 1,709 | Direct `product_code` = `prod_line_id` |
| Base-code match (stripped variant suffix) | 1,264 | e.g. `248SP` → `248`, `309CAN` → `309` |
| **Total linked** | **2,973 (70%)** | `entity_id` now populated |
| No `product_code` in metadata | 203 | Ingestion gap — SDS parsed without code |
| `B1xxx` codes not in entity table | ~600 | Sub-brand product lines not yet in RAG entities |
| Other unresolved codes | ~472 | Amazon ASINs, GTS/RSS/FMP brand codes, misc |
| **Total unlinked** | **1,275 (30%)** | |

---

## Language variants in the corpus

SDS documents exist in multiple languages. The `product_code` in RAG metadata includes the variant suffix:

| Suffix | Language/Region | Example |
|---|---|---|
| *(none)* | English (US) | `248` |
| `CAN` | English (Canada) | `248CAN` |
| `SP` | Spanish | `248SP` |
| `FR` | French | `248FR` |
| `BO` | *unknown* | `248BO` |

Only 5 Spanish SDS documents (81 chunks, 0.16% of corpus) exist — English is effectively the full corpus for search purposes. Language filtering was removed from the search pipeline.

---

## Data staleness risks

| Source | Snapshot date | Risk |
|---|---|---|
| SDS PDFs (AWS) | ~Feb–Mar 2026 | Formulation changes, GHS updates not reflected |
| Legacy product data | January 2026 | New products, discontinued SKUs, dilution changes |
| RAG entity table | Derived from legacy Jan 2026 | Same staleness as legacy |
| RAG embeddings | Current (all 26,825 chunks embedded on `embeddings_large`) | Accurate to SDS snapshot |

**Not synchronized** — no live pipeline between AWS/legacy CMS and the RAG database. All data is point-in-time.
