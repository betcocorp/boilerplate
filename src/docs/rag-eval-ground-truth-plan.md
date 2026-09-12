# RAG evaluation — ground-truth labelling plan

Status: **proposed** — 2026-09-11. No ticket yet.

Scope: how we create the relevance labels that Phase 1 of [`rag-evaluation-process.md`](./rag-evaluation-process.md) needs — which documents *should* have been retrieved for a given question. Covers the pilot only; the metrics that consume these labels are specified in that document, not this one.

Every number below was measured against the local `bex2` Supabase stack on 2026-09-11 (`docker exec supabase_db_bex2 psql -U postgres -d postgres`), not estimated.

---

## The pilot set has to change

The brief named `test-sets/product-specialist-25.csv`. **None of its 25 questions exist in `test_items`** — not one resolves by prompt match, and no row anywhere in the database mentions `Ford F-150`, `cryptocurrency`, `Broad Spectrum` or `1 Minute Disinfectant`.

All four files in `test-sets/` share an obsolete header: `question, should_answer, expected_result_type, canonical_product, reason_code, product_mention, question_category, source_style`. `should_answer` and `expected_result_type` are in `LEGACY_IGNORED_CSV_COLUMNS` (`~/lib/tests/csv.ts`) — dropped on import since B0-799/B0-931. More decisively, the files carry **no `ideal_response` and no concept columns**, so importing one today produces items with nothing to grade against: exactly the shape B0-826 purged from the database on 2026-09-03. These CSVs are historical artifacts, not a live dataset.

The live equivalent is **`Product Specialist Top 20 (Less Complex)`** — 20 items, `is_golden = true`, `intended_agent = 'product'`, all 20 carrying `minimum_concepts`, `expected_concepts`, `ideal_response` and `should_cite = true`. It also has **21 completed runs**, which no other product set comes close to, and that run history is what makes the candidate-harvesting analysis below possible at all.

**Recommendation: pilot on `Product Specialist Top 20 (Less Complex)`.** Treat `test-sets/*.csv` as dead unless someone intends to re-author them in the current schema, which is a separate piece of work with its own justification.

---

## What the data says

### Retrieval is wide and unstable

Across 21 completed runs of the 20-item set, 1,794 chunk references resolve to 221 distinct documents and 283 distinct chunks. Per question that is an average of **16 distinct documents** (range 2–64) — but only **4.6 references in any single run**. The union is wide because the runs disagree, not because each run retrieves a lot.

Measuring how often a given document is retrieved for a given question, across those 21 runs:

| Document appears in | Question-document pairs | Share |
| --- | --- | --- |
| Every run | 19 | 6% |
| 50–99% of runs | 48 | 15% |
| 20–49% of runs | 53 | 17% |
| Under 20% of runs | 200 | **62%** |

Roughly one document per question is retrieved consistently. Nearly two thirds of everything ever retrieved appears in fewer than one run in five — that is noise, and labelling it would mean reviewing 16 documents per question to reject 13 of them.

A frequency floor fixes the volume problem: at **≥50% of runs** the candidate set is 67 pairs, or **3.4 documents per question**. That is a reviewable amount of work. It does not fix the correctness problem.

### Harvested candidates are confidently wrong

For *"Can I use pH7Q on stainless steel?"*, the documents retrieved in ≥50% of runs are:

| Document | Kind | Share of runs |
| --- | --- | --- |
| Betco Sustainability in Action | `knowledge` | 62% |
| Ready-To-Use Stainless Steel Cleaner & … | `product_line_profile` | 52% |

The item's own `ideal_response` ends `Source: pH7Q product label.` Neither harvested document is that. The second is a keyword collision — the phrase "stainless steel" matched a *different product* — and the first is a sustainability brochure.

Then the corpus itself: `rag.document` holds **no pH7Q label and no pH7Q product-line profile at all**, only `efficacy` (2) and `fastdraw_dilution` (2) rows. The document the reference answer requires does not exist to be retrieved.

This single case decides decision 2 below. A harvest-anchored process would have recorded two irrelevant documents as ground truth, and the resulting recall metric would score **1.0** on a question where retrieval cannot possibly succeed. The metric would be actively lying, and lying in the direction that hides the problem.

It also shows what labelling is actually for here. The finding is not "retrieval ranked badly" — it is **"the corpus has a hole."** No amount of reranker tuning fixes that, and nothing in the current harness can surface it.

### Corpus coverage is uneven

Documents by kind: `sds` 3,159 · `product_line_profile` 1,703 · `label` 789 · `efficacy` 146 · `knowledge` 107 · `fastdraw_dilution` 39 (5,943 total). Coverage per product is inconsistent in a way that is invisible until you look product by product:

| Product named in a pilot question | What exists |
| --- | --- |
| Push | label, SDS, profile, fastdraw (complete) |
| GE Fight Bac | label, efficacy |
| Grease Solv | label only |
| BestScent | profile only |
| pH7Q | efficacy, fastdraw — **no label** |

Labelling will produce a by-product corpus gap report as a by-product of its real job. That report may be more immediately actionable than the metric it was created to enable.

### Documents are small enough to read — except `knowledge`

| Kind | Avg chunks | Max chunks | Avg chars |
| --- | --- | --- | --- |
| `product_line_profile` | 6.5 | 11 | 5,457 |
| `label` | 8.4 | 11 | 7,310 |
| `sds` | 8.7 | 15 | 9,395 |
| `efficacy` | 5.0 | 8 | 3,790 |
| `fastdraw_dilution` | 1.0 | 1 | 213 |
| `knowledge` | **36.2** | **303** | 16,393 |

A labeller confirming a label, SDS or profile reads 5–9 chunks — a few minutes. A `knowledge` document can be 303 chunks, and there is no reason to believe a labeller would read one honestly.

### The reference answers point at the right sources

13 of 20 `ideal_response` values contain an explicit `Source:` / `Sources:` line; 17 of 20 name a document kind ("label"), 4 mention SDS, 4 mention efficacy data. 13 of 20 are templates with placeholders (`[insert label-confirmed approved surfaces]`) rather than concrete prose.

That combination is close to ideal for this job: the reference does not give away the answer text, but it *does* say which document the answer must come from. It turns "search 5,943 documents" into "find the pH7Q label" — and, in that case, into "discover the pH7Q label does not exist."

One caveat found while reading them: the `Which of your disinfectants kill HIV-1?` reference instructs `[Insert the list of products with a **norovirus** claim…]`. A copy-paste error in the reference data itself. The references are a good labelling aid and are **not** themselves verified ground truth.

---

## Decisions

### 1. Document-level, not chunk-level

**Recommendation: document-level, stored in `test_items.expected_sources`.**

The dominant failure the pilot data exposes is *wrong document* and *missing document* (pH7Q), not *right document, wrong section*. Document-level labels detect both. Chunk-level labels would detect the same two failures and one more, at several times the cost.

| | Document-level | Chunk-level |
| --- | --- | --- |
| Storage | `expected_sources uuid[]` — exists | New column or table |
| Authoring UI | `DocumentPickerField` — exists | Nothing exists |
| CSV round-trip | `expected_sources` column — exists | Nothing exists |
| Reading burden | Title + kind, confirm by skim | 5–9 chunks typical, up to 303 for `knowledge` |
| Key stability | `document_key` — changes only when source identity changes | `document_key:chunk:<index>` — survives re-sync, **shifts whenever chunk boundaries move** |

The stability difference is the one that matters long-term. Both levels upsert on a natural key (`on conflict (document_key)`, `ON CONFLICT (chunk_key)`), so neither churns on an ordinary re-sync. But `chunk_key` embeds `chunk_index`, so any change to the chunker — or to a document's content that shifts a section boundary — silently re-points every chunk label after the shift. The label would still resolve; it would just be attached to different text. Document labels are immune to that.

**What is lost:** the "right document, wrong section" diagnosis — row 3 of the diagnostic matrix in the process doc. Phase 3's typed entity recall covers the same ground by a different route (did the specific EPA number / contact time survive into context), so this is a deferral, not a gap. Phase 0's export already persists both `document_id` and `chunk_id`, so chunk-level labelling remains available later with no rework.

### 2. Reference-anchored labelling, with harvest as a second pass only

**Recommendation: hybrid, but anchored on `ideal_response` — not on what retrieval returned.**

The order matters more than the ingredients. The workflow is:

1. Read the question and its `ideal_response`; note the source it names ("the pH7Q product label").
2. Search the corpus for that document via the existing picker. Record it if it exists. **If it does not exist, record that** — the item is flagged as a corpus gap and excluded from recall scoring until the gap is closed or the reference is corrected.
3. *Then* show the ≥50% harvested candidates. Accept any that are genuinely relevant and were missed; reject the rest.

Harvest-first would have produced two wrong documents for pH7Q with no prompt to question them. Reference-first produces the right answer, or an explicit "the right answer is not in the corpus."

**Bias being accepted, stated plainly:** the labeller is anchored on the reference answer's opinion of the correct source, and the references contain at least one known error. This trades retrieval bias (fatal — the metric can never reveal a systematic retrieval failure) for reference bias (survivable — a wrong reference produces one wrong label, visible on review, and correctable). Step 3 is what keeps a legitimately-retrieved document from being missed because the reference forgot to mention it.

### 3. Who does it, and how long

Two distinct roles. Conflating them is how this estimate goes wrong.

| Work | Role | Estimate |
| --- | --- | --- |
| Harvest + candidate export script, labelling sheet | Engineer | 2–3 h |
| Labelling 20 items | Domain reviewer | 4–5 h |
| Loading labels, spot-check, corpus-gap write-up | Engineer | 1–2 h |
| **Pilot total** | | **7–10 h** |

The per-item labelling figure is **12–15 minutes**, built from measured quantities: read prompt and reference (1–2 min) · corpus search for the named source (3–5 min) · skim the document to confirm it answers, 5–9 chunks at typical sizes (3–5 min) · review 3.4 harvested candidates by title and kind (2–3 min) · record (1 min).

The labelling half needs Betco product knowledge and cannot be delegated to an engineer. Deciding whether an efficacy sheet carries a *labelled HIV-1 claim specifically*, or whether a stainless-steel surface list belongs to pH7Q or to a differently-named RTU product, is domain judgement. The pH7Q and norovirus findings above both came from reading the data closely — an engineer labelling by title match would have reproduced exactly the harvest error this plan exists to avoid.

### 4. Storage and review

**Use `test_items.expected_sources` unchanged.** It is `uuid[]` of `rag.document.id`, already read by the report path (`report/expected-sources.ts` resolves ids to titles, keeps unresolvable ids visibly marked rather than dropping them — the right behaviour for a purged document). No migration.

Two additions, both in the existing `metadata` jsonb rather than new columns:

- `metadata.expected_sources_provenance` — `{ labeledBy, labeledAt, method: 'reference_anchored' | 'harvest_confirmed', corpusGap: boolean }`. Without this, a label six months old is indistinguishable from a guess, and the corpus-gap items are indistinguishable from unlabelled ones.
- `metadata.expected_sources_rejected` — the candidate documents the labeller explicitly rejected. A rejected document is not the same as one never considered, and this is what makes a *precision* denominator meaningful rather than assumed.

Review: re-label a 20% sample independently after the first pass and compare. Agreement below ~80% means the labelling instructions are underspecified and the whole pass needs revisiting — better to learn that at 20 items than at 199. Thereafter, treat labels as reviewable whenever the corpus is re-ingested, since a document that stops resolving is a signal, not an error to suppress.

### 5. Tooling gap — one real one

Most of what is needed exists and should not be rebuilt. `GET /api/admin/rag/document-search` does title and entity search with sensible caps (20 results, `?ids=` hydration up to 50). `DocumentPickerField` handles multi-select, badge rendering and uuid round-tripping. `csv.ts` imports and exports `expected_sources`. The edit dialog is wired. For picking documents by name, this is sufficient today.

**The gap: the picker shows `title` and `document_kind` only — no body, no snippet.** A labeller cannot tell from `pH7Q Disinfectant Cleaner Deodorizer — Fas…` whether that document contains an approved-surfaces list. Verification currently requires leaving the UI and querying Postgres.

Two options, and the cheap one is better:

- **Labelling sheet (recommended, ~2 h).** Extend the Phase 0 exporter to emit one HTML or CSV sheet per pilot: question, `ideal_response`, the ≥50% harvested candidates with title, kind and first-chunk text, and a column for the decision. The labeller works in the sheet; an engineer loads the results via the existing CSV import. Reuses `retrieval-dataset.ts`, adds no UI surface, and produces an auditable artifact of what the labeller actually saw.
- **Body preview in the picker (~1 day).** Better long-term ergonomics for ongoing maintenance, but it is a new UI surface, a new endpoint for chunk text, and a permissions question — none of it justified by a 20-item pilot.

Build the sheet. Revisit the picker only if labelling becomes a recurring activity.

### 6. Scale-out to 199 — the approach survives, the harvest does not

`Product Golden Test Set` (199 items) breaks the candidate-harvesting half of this plan for a reason that is easy to miss:

- **It has 2 completed runs.** Frequency thresholding over 2 runs is meaningless — every document that appeared at all appears in ≥50% of runs. The measured "4.2 candidates per item" for that set is an artifact of the sample size, not a signal. The 20-item pilot works because it has 21 runs.
- **32 of 199 items have no retrieval history at all**, so there is nothing to harvest for them regardless.

The reference-anchored path is unaffected — it depends on `ideal_response`, which is populated across the set, not on run history. So step 3 of the workflow degrades to "no candidates available" for most of the 199 and the labelling is purely reference-driven. That is *more* rigorous, and slower.

Scaling linearly at 12–15 min/item, 199 items is **40–50 person-hours of domain time**. That is the number that decides whether this is viable, and it should be put in front of whoever owns that time before the pilot starts, not after. Two mitigations worth considering at that point, neither needed for the pilot:

- Run the 199-item set several times first, purely to build enough retrieval history for candidate harvesting to work. Cheap in engineering time, expensive in model spend, and it re-introduces the harvest bias that the pH7Q case argues against — acceptable only because step 3 is confirmatory, never authoritative.
- Label a stratified subset rather than all 199. Recall computed over 60 well-chosen items is a usable trend line; recall over 199 half-attentively labelled items is not.

---

## What the pilot should be judged on

Not "did we produce 20 labels." The pilot succeeds if it answers three questions:

1. **Is 12–15 min/item real?** If it is 30, the 199-item plan is 100 hours and needs rethinking before anyone commits to it.
2. **Do two labellers agree?** Below ~80% on the 20% re-label sample, the instructions are the problem, not the labellers.
3. **How many items turn out to be corpus gaps rather than retrieval failures?** The pH7Q case suggests this is not rare. If a large share of the pilot is gaps, the highest-value next step is corpus work, and the retrieval metrics matter less than this plan assumes.

## Open questions

- Who owns the domain time, for the pilot and for any scale-out? This plan has no answer and cannot proceed past the engineering half without one.
- When a reference answer names a source that does not exist in the corpus — pH7Q — is the defect in the corpus or in the reference? Someone with product knowledge has to rule, per case, and the ruling changes whether the item is excluded from scoring or kept as a known-failing case.
- Do the `test-sets/*.csv` files get re-authored in the current schema or deleted? They are the only artifacts in the repo that still describe a dataset shape the importer silently discards.
