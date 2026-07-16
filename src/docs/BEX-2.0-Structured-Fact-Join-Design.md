# BEX 2.0 — Structured-Fact Join: Design

**Prepared for:** Tom Bird
**Date:** July 15, 2026
**Status:** Design proposal (grounded in `dev` @ `9ae36e57` + live DB `gbkobtatfsjibkxebvdw`)
**Problem addressed:** Retrieval reconciles *documents* but not *facts*. Dilution and kill-claim answers are produced from prose today. This is the top item from the reconciliation assessment.

**Relationship to existing docs:** evolves `rag-specification.md` §3.4/§5.5 and `rag-execution-plan.md` §1.1/§2.3 — their `entity.metadata` enrichment + `entity-context.ts` hydration is the starting point; this promotes it to **typed, cited** tables and adds a **`product_efficacy`** model those docs don't cover. See `BEX-2.0-Corpus-Assessment-and-Reconciliation-Strategy.md` §6 for the full doc reconciliation.

---

## 1. Problem, precisely

The product-support retrieval path (`ragQueryForProductKnowledgeWithMeta` → `assembleDocumentBodies`) returns **full document text** per source. Every `RagSearchMatch`/`CuratedSource` already carries `entity_id`, `product_line_key`, and `product_key`, but nothing joins **typed facts**:

- The `rag.document` fact columns (`dilution_oz_per_gal`, `contact_time_seconds`, `chemistry_class`, `product_application`, `epa_registration`, generated `epa_registrant`) are read by **no retrieval code** — grep finds them only in generated types and `cross-reference-lookup.ts` (REC-3). They're also near-empty (dilution 0, contact 0, epa 1 of 4,661).
- There is **no efficacy table** at all (organism/claim × dilution × contact-time).

Result: a "what kills Norovirus and at what dilution?" question is answered from paragraphs inside an SDS body — the confidently-wrong failure mode, and a compliance risk.

## 2. What already exists to build on (extend, don't rebuild)

There is already a **structured-fact surface** — it's just thin and sourced from loose JSON:

- `lib/rag/entity-context.ts` → `fetchEntityContexts(entityIds)` reads `rag.entity.metadata` and exposes `dilutionCode` + `coverageSqFt`; `buildEntityContextBlock()` renders a `## Product Context` markdown block (with `**Dilution:**` / `**Coverage:**` lines) that `product-tools.ts` returns as `entityContextBlock` on **every** tool result.
- It's keyed on `entity_id` — the exact key the resolver (`resolveProductLineFromMatches`) already locks onto and that flows through `CuratedSource.entityId`.

So the seam is real and already wired into the prompt. The gaps in it: (a) it reads a display string `dilution_code` (e.g. "2/1"), not a numeric/typed value; (b) it carries **no efficacy data**; (c) it's backed by untyped JSONB, not a table we can query/validate.

Live-data reality for backfill (from `rag.entity`, 1,703 product lines):

| metadata key | populated | use |
|---|---|---|
| `prod_line_id`, `product_line_key`, `variant_product_keys`, `variant_count` | 1,703 | identity + **SKU/variant list per line** |
| `dilution_code` | 155 | seed `dilution` fact |
| `coverage_sq_ft` | 145 | seed `coverage` fact |
| `short_description` / `description` | ~550 | already surfaced |

`variant_product_keys` matters: dilution/efficacy can differ by SKU (concentrate vs RTU), and that variant identity is present even though there's no product-tier entity yet.

## 3. Design principles

1. **Facts are typed, product-line-grained, and cited** — never embedded. Semantic search resolves the *entity*; a deterministic join pulls the *facts*.
2. **Join on `entity_id`** (the resolved product-line entity). Zero new resolution logic — reuse what `product-knowledge.ts` already produces.
3. **Every fact row cites its source** (`source_record_id` / `document_id`) so the validator can ground it and the UI can link it. Betco stays the system of record; the SDS/matrix PDFs are provenance.
4. **Absence is an answer.** If a fact isn't in the table, the tool returns "no verified data" — it must **not** fall through to prose. This is the compliance guardrail.
5. **Additive & contract-first.** New tables, new optional fields on existing result types, new Zod schemas first. No change to stored conversation/data shapes.

## 4. Data model

Two new tables in the `rag` schema, both FK'd to `rag.entity(id)` (currently all `product_line`), with provenance and an optional `product_key` for future SKU-level facts.

```sql
-- Scalar attributes, ~1:1 per product line (variant-nullable for SKU-level overrides later)
create table rag.product_line_fact (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references rag.entity(id) on delete cascade,
  product_key        text,                    -- null = line-level; set = variant/SKU-level override
  dilution_oz_per_gal numeric,               -- typed (parse "2/1", "4 oz/gal" at ingest)
  dilution_display    text,                   -- human string preserved for citation ("2 oz per gallon")
  coverage_sq_ft      numeric,
  chemistry_class     text,                   -- quat | peroxide | hypochlorite | phenolic | alcohol | acid | other
  product_application text,                   -- disinfectant | degreaser | floor-finish | ...
  epa_registration    text,
  contact_time_seconds integer,
  source_record_id    uuid references rag.source_record(id),
  confidence          numeric default 1.0,
  updated_at          timestamptz not null default now(),
  unique (entity_id, product_key)
);

-- Efficacy matrix: many rows per line (organism/claim × conditions). Populated from the Claims PDF later.
create table rag.product_efficacy (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references rag.entity(id) on delete cascade,
  product_key        text,
  organism           text not null,           -- "Norovirus", "SARS-CoV-2", "Influenza A", ...
  claim_type         text,                    -- disinfect | sanitize | virucide | fungicide | tuberculocide
  dilution_oz_per_gal numeric,
  contact_time_seconds integer,
  epa_registration    text,
  source_record_id    uuid references rag.source_record(id),
  source_page         integer,
  confidence          numeric default 1.0,
  updated_at          timestamptz not null default now()
);

create index on rag.product_line_fact (entity_id);
create index on rag.product_efficacy (entity_id);
create index on rag.product_efficacy (lower(organism));
```

Relationship to the existing dormant `rag.document` columns: those stay as the **per-document extraction staging** target for REC-2/REC-3 (what a given SDS says). `product_line_fact`/`product_efficacy` are the **reconciled, canonical** per-line view the assistant reads. A later job promotes/aggregates document-level extractions → line-level facts with provenance. This keeps "one product, one answer" while preserving traceability.

## 5. Retrieval integration

New module `lib/retrieval/product-facts.ts`:

```ts
export type ProductLineFacts = {
  entityId: string;
  dilutionOzPerGal: number | null;
  dilutionDisplay: string | null;
  coverageSqFt: number | null;
  chemistryClass: string | null;
  productApplication: string | null;
  epaRegistration: string | null;
  contactTimeSeconds: number | null;
  efficacy: Array<{
    organism: string; claimType: string | null;
    dilutionOzPerGal: number | null; contactTimeSeconds: number | null;
    epaRegistration: string | null; sourceRecordId: string | null;
  }>;
};

export async function fetchProductLineFacts(entityIds: string[]): Promise<Map<string, ProductLineFacts>>;
```

Wire it into `ragQueryForProductKnowledgeWithMeta` alongside the existing `entityContextBlockForSources(...)` call (same `entityIds`, one extra batched query):

- Extend `ProductKnowledgeQueryResult` with `facts: Map<string, ProductLineFacts>` (or a `factsBlock: string | null` rendered for the prompt).
- Extend `buildEntityContextBlock` (or add `buildFactsBlock`) to render typed dilution + an efficacy table when present. This block is already injected into the prompt, so the model gets facts with **zero prompt-plumbing changes**.
- Include the facts block in whatever set the **validator** grounds against, so a cited dilution/kill-claim passes grounding.

## 6. Tool surface

Two changes in `lib/tools/`:

1. **Surface facts on existing tools.** Add a top-level `facts` object (keyed by `productLineKey`/`entityId`) to the `search_product_docs` / `get_product_spec` / `get_safety_constraints` payloads via `sourcePayload`'s caller. Cheap, and immediately improves grounded answers.
2. **Add a fact-only tool** for the high-risk questions:

```
get_efficacy_data(productId, organism?)  -> { ok, facts: { dilution, contactTime, epa, efficacy[] }, grounded: true } | { ok:true, facts:null, note:"no verified efficacy data on file" }
```

This tool does **not** run semantic prose retrieval — it resolves the line (`resolveProductLineKeyByName`) then reads `product_efficacy`/`product_line_fact`. If empty → explicit "no verified data" so the model defers instead of guessing. Add it to `productSupportTools`, `PRODUCT_TOOL_NAMES`, the Zod input schema, and the `executeProductTool` switch (the four-place sync the assessment flagged). Route the `dilution` SME (currently a stub) and kill-claim intents here.

## 7. Backfill & sequencing

1. **Migrations** for the two tables (contract-first: add to `src/supabase/migrations/`, regenerate `supabase.rag.ts`).
2. **Backfill now, from what exists:** populate `product_line_fact` for the 155 `dilution_code` + 145 `coverage_sq_ft` lines out of `entity.metadata` (parse `dilution_code` → numeric + keep display). Immediate, non-blocking win — typed dilution for the lines that have it.
3. **Wire REC-2/3:** point the existing SDS extraction at `rag.document.*` columns, then a promote step → `product_line_fact` with provenance.
4. **Efficacy (when source docs are ready):** parse the Betco Disinfectant Claims matrix → `product_efficacy` rows (organism × dilution × contact-time × EPA reg × source page). Until then `get_efficacy_data` correctly returns "no verified data."
5. **Retrieval + tool wiring** (§5–6) behind the fact fetch.
6. **Evals:** add kill-claim/dilution items to `/admin/tests`; assert the answer cites a fact row, not prose.

## 8. Touch-list (files)

- **New:** `src/lib/retrieval/product-facts.ts`; two migrations; (optional) `lib/tools/efficacy-lookup.ts`.
- **Edit:** `lib/retrieval/product-knowledge.ts` (fetch + attach facts), `lib/rag/entity-context.ts` (render facts block or split into `buildFactsBlock`), `lib/tools/product-tools.ts` (`sourcePayload` + new case), `lib/tools/definitions.ts` + `tool-schemas.ts` + `PRODUCT_TOOL_NAMES` (new tool), `workflows/product-support/validator.ts` (ground facts), `types/supabase.rag.ts` (regenerate).
- **Verify:** `pnpm exec tsc --noEmit` && `pnpm lint`.

## 9. Edge cases / risks

- **SKU vs line granularity** — dilution can vary by variant; `product_key` on both tables + `variant_product_keys` in metadata lets facts override at SKU level without a product-tier entity. Line-level is the default.
- **Multi-locale** — `source_record.source_locale` exists; keep facts locale-agnostic where numeric, cite the English source.
- **Orphan SDS (839)** — unlinked SDS won't contribute facts until linked to a line; tracked separately.
- **RLS** — new `rag` tables inherit the open-RLS posture; include them in the §5 security hardening, service-role read on the server path.
- **Stale facts** — `updated_at` + `confidence` + provenance let a future sync reconcile against Zeus when `legacy` is repopulated.

## 10. Proposed Jira breakdown (for review)

- **Epic:** Structured-fact reconciliation for product support.
  1. Migrations: `rag.product_line_fact` + `rag.product_efficacy` (+ regen types).
  2. Backfill `product_line_fact` from `entity.metadata` (dilution/coverage).
  3. `product-facts.ts` fetch + attach to `ProductKnowledgeQueryResult`.
  4. Render facts block into prompt context + validator grounding.
  5. `get_efficacy_data` fact-only tool (4-place sync) + route `dilution` SME.
  6. Eval set: dilution/kill-claim grounded-answer regression.
  7. (Blocked on source docs) Efficacy matrix → `product_efficacy` ingest.
