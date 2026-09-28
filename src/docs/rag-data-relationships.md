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

## Efficacy corpus — formula ↔ product crosswalk (B0-231/232/233, added 2026-07-22)

```
rag.efficacy_formula_product  (new, empty until B0-232 backfills real data)
┌────────────────────────────────────────────────────────┐
│ id                    UUID PK                          │
│ formula_code          text, e.g. "M000795" (M000xxx)   │
│ product_line_key      text → rag.entity.product_line_key│
│ sku                   text (nullable — SKU-level link) │
│ registrant_role       'primary' | 'sub'                │
│ is_active             boolean                          │
└────────────────────────────────────────────────────────┘
        ▲ formula_code                    ▲ product_line_key
        │                                  │
rag.document (document_kind='efficacy')    rag.entity (entity_type='product_line')
  metadata->>'formula_code'                same key as SDS/product_line_profile docs
  is_current, lifecycle_status
  (active | never_activated | unused | superseded)
  superseded_by_document_id, cites_data_from_document_id
        │ document_id (1:many)
        ▼
rag.document_chunk (section_type ∈ bactericidal_efficacy |
  virucidal_activity | fungistatic | organism_contact_time)
```

### 4 — Product → current efficacy lab report (answer-time)
```
rag.entity.product_line_key
  = rag.efficacy_formula_product.product_line_key  (is_active = true)
    → formula_code
      = rag.document.metadata->>'formula_code'  (document_kind='efficacy',
                                                   is_current=true, lifecycle_status='active')
```
Exposed via `rag.get_current_efficacy_for_product(product_line_key)` and, with citation
(lab, Project #, S3 source) and a sub-registrant fallback (B0-234), via
`fetchCurrentEfficacyLabReport()` in `src/lib/retrieval/efficacy-lab-report.ts`.

Status: **crosswalk table + document-model + RPC/search wiring are all live; the table
itself is empty** — B0-223 (Master Efficacy Version Data parse) and B0-232 (SKU mapping
backfill) are the still-blocked data-entry steps that populate it.

Distinct from `rag.product_efficacy` (pre-existing, B0-185/196): that table holds
structured per-organism kill-claim facts with no `formula_code`/lab/version/citation
concept. It remains a secondary/fallback grounding source; this crosswalk + the
`efficacy` document kind is the citable, regulatorily-defensible primary source once
populated.

---

## Product page URL derivation (B0-1073/1074/1075/1077, added 2026-09-23)

Bex can cite a live betco.com product page alongside an internal source (SDS, label,
product_line_profile). The URL is **derived**, never stored or hand-maintained, and never a
"friendly" slug URL.

**URL form:**
```
https://www.betco.com/ProductsDetail?productID=<uppercase legacy.prod_line."ProdLineKey" GUID>
```
e.g. line `311` (Fight Bac RTU) → `https://www.betco.com/ProductsDetail?productID=CA352FDA-543F-4D28-BB61-371247F351D4`.

**Predicate — which lines get a URL at all:** `legacy.products."OnWeb" = 1`. Since B0-1089 the
column is `integer NOT NULL DEFAULT 0` with a CHECK constraint allowing only `0` or `1` (the
nulls and ~27 rows of column-shifted export text it used to carry were normalized to `0`). The
item→line link is `lower(legacy.products_attr."AttrTable") = 'prodline'` (both `ProdLine` and
`Prodline` spellings exist live).

**Join path (query-time):**
```
rag.entity.product_line_key
  = rag.product_line_web_url.product_line_key   (view, B0-1074 — derives the URL above)
    left join rag.product_line_web_url_check    (table, B0-1077 — soft-404 verification state)
      on product_line_key, withhold web_url when status IN ('soft_404','error')
```
`fetchProductLineWebUrls()` in `~/lib/retrieval/document-assembly.ts` (B0-1075) is the single
call site; it attaches `productPageUrl` onto a `CuratedSource` only when that source's OWN
`productLineKey` matches (never inferred from a query's resolved line), and only for a check
status of `ok` or **no check row yet** (unverified is surfaced; only a CONFIRMED-broken link is
withheld — see the inline comment on `fetchProductLineWebUrls` for the judgment call).

**Coverage** (live count, verified 2026-09-23): **288 of 1,703** distinct `product_line_key`
values in `rag.entity` (17%) resolve to a web-visible line — `select count(distinct
product_line_key) from rag.entity where entity_type = 'product_line'` vs. `select count(*) from
rag.product_line_web_url`. This ~17% is BY DESIGN, not a defect: most product lines in the legacy
catalog (discontinued, private-label, co-pack, internal) never had a betco.com page.

**Why friendly `/products/<slug>` URLs are not derivable:** betco.com's SEO/marketing team
maintains slug URLs independently of `legacy.prod_line`. Per the B0-1073 epic's own prior spike
(not re-derived here — see the epic and its linked Confluence "URL Rewrite System and Product URL
Grammar" page for the underlying analysis), reconciling `legacy` title-like text against
betco.com's sitemap slugs matched only 57%/39% of candidates across the two columns tried, with
the remainder failing on ™/® mangling (the legacy text carries literal `™`/`®` glyphs the site's
slugifier drops or transliterates differently) and other free-text drift. The GUID `ProductsDetail`
URL is the only form that is 100% mechanically derivable from `legacy` with no fuzzy text
matching. (Also see the "Product web URLs are fabricated" project note: prior to this epic, 0 of
~9,103 products had a real URL anywhere in the DB — `betco.com/sitemap.xml` was the only
authoritative slug source, and even that only partially reconciles.)

**Soft-404 signature (why a link checker exists at all):** betco.com never returns a non-200 for a
bad product page. A missing/stale line redirects to `/404/500.htm?aspxerrorpath=/ProductsDetail`
and serves an exactly-**3,957-byte** body titled `Betco.com 500 Error` (`<h1>Something Went
Wrong</h1>`), with HTTP status **200**. A live run of `scripts/verify-product-line-web-urls.mjs`
on 2026-09-23 checked all 288 derived URLs and found **256 `ok`, 32 `soft_404`, 0 `error`** — two
of the 32 are the `H619`/`H620` Triton dispensers called out in B0-1077's own ticket description;
the other 30 are additional drift discovered by the checker (the `legacy` snapshot is January
2026 — see "Data staleness risks" below). `rag.product_line_web_url_check` holds the current
verdict per line; the checker re-runs weekly via the `verify-product-line-web-urls` Vercel cron.

For anyone reading legacy-side URLs directly (not through the derivation above): per the same
B0-1073 spike, the ERP-id rule Betco's own site uses for its human-readable ids is `ProdLineID`
for a product line and, at the SKU level, the `SKU` with a trailing `-00` stripped (otherwise the
hyphen is removed entirely) — noted here for context only; Bex does not use this rule anywhere,
since the GUID form above needs no such transcription.

---

## Data staleness risks

| Source | Snapshot date | Risk |
|---|---|---|
| SDS PDFs (AWS) | ~Feb–Mar 2026 | Formulation changes, GHS updates not reflected |
| Legacy product data | January 2026 | New products, discontinued SKUs, dilution changes |
| RAG entity table | Derived from legacy Jan 2026 | Same staleness as legacy |
| RAG embeddings | Current (all 26,825 chunks embedded on `embeddings_large`) | Accurate to SDS snapshot |

**Not synchronized** — no live pipeline between AWS/legacy CMS and the RAG database. All data is point-in-time.
