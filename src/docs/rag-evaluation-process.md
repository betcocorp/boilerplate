# RAG evaluation process

Status: **partly implemented** — proposed 2026-09-11, reconciled against the code 2026-09-12. No ticket yet.

Phase 0 is implemented and uncommitted. Phase 3 is implemented and uncommitted, in `evals/rag/`. Phases 1 and 2 are not started and are blocked on ground-truth labels, of which there are none (`test_items.expected_sources` is populated on 0 of 1,031 items). Where this doc's original proposal and the code now disagree, the divergence is stated inline and marked **Reconciled 2026-09-12** — the code is the authority, this doc records why it moved.

Scope: how we measure whether *retrieval* is working, and whether answers are *grounded in what was retrieved*. Answer-content grading (concept coverage, declines, routing) already exists and is out of scope except where the two must not collide — see [What already exists](#what-already-exists).

All four metrics below are implemented in TypeScript in this repo, on the existing grader infrastructure (`~/lib/tests/*`) — no external eval service, no Python sidecar, one grading budget.

Companion docs: [`semantic-search.md`](./semantic-search.md), [`rag-specification.md`](./rag-specification.md), [`cross-reference-recommendations.md`](./cross-reference-recommendations.md).

---

## Why this doc

The `/admin/tests` harness answers *"did the assistant say the right things?"*. It does not answer either of the two questions that decide whether the RAG pipeline is healthy:

1. **Did retrieval put the right chunks in front of the model?**
2. **Did the answer's claims actually come from those chunks?**

A repo-wide search for `recall@`, `precision@`, `ndcg`, `mrr`, `faithfulness`, `groundedness` and `context relevance` returns nothing. Today the only retrieval signal is `evaluateSearchPass` (`~/lib/tests/search-run-executor.ts`):

```ts
// no constraint                  -> pass if any result was returned
// expected_canonical_product set -> pass if ANY match has that product_line_key
```

That is binary, rank-insensitive, and blind to whether the top chunk or the fortieth carried the answer. Every retrieval change we have shipped — RRF fusion, Cohere reranking (B0-280), over-fetch `limit × 5`, multi-intent expansion, near-duplicate suppression, knowledge-category exclusions (B0-780), the approximate query-embedding cache — was merged without a metric that could have detected it making retrieval *worse*.

For a regulated corpus (dilution ratios, EPA/DIN registration numbers, contact times, ppm) the ungrounded-claim case is a safety defect, not a quality score. That is the gap this process closes.

---

## What already exists

Do not rebuild these. The new metrics plug into them.

| Capability | Where |
| --- | --- |
| Golden test sets, CSV items, run history | `~/lib/tests/repository.ts`, `/admin/tests` |
| Concept grading (pass/fail axis) | `~/lib/tests/criteria-grader.ts`, `grading.ts` |
| Decline grading | `~/lib/tests/decline-grader.ts` |
| Run comparison, new-failure/fix diffing | `~/lib/tests/run-comparison*.ts` |
| Failure root-cause analysis | `~/lib/tests/failure-root-cause.ts` |
| Trend series and score deltas | `~/lib/tests/golden-set-trend.ts`, `report-metric-trend.ts` |
| Routing / signal accuracy | `~/lib/tests/routing-comparison.ts`, `signal-accuracy.ts`, `alias-routing.ts` |
| CI gate (fresh run per PR) | `scripts/run-eval-gate.ts`, `.github/workflows/eval-gate.yml` |
| Grader model + cost config | `~/lib/tests/item-grading-model.ts`, `TEST_ITEM_GRADING_MODEL` setting |
| Run export | `scripts/export-eval-json.ts` |

**Concept coverage stays the pass/fail gate.** The four metrics below are *diagnostics on retrieval*, reported alongside. Running two independent LLM verdicts as competing pass gates buys disagreement and double grading cost, not signal.

---

## Prerequisite: persist retrieved context text

**Every metric below is blocked on this. It is the first piece of work.**

What we persist today is a reference, not the text:

```ts
// ~/lib/workflows/product-support/product-support-schemas.ts
export const retrievedDocumentChunkRefSchema = z.object({
  document_id: z.string(),
  chunk_id: z.string().nullable(),
  document_kind: z.string().nullable().optional(),
  document_title: z.string().nullable().optional(),
  product_line_key: z.string().nullable().optional(),
});
```

No `chunk_text`. The tool trace is not a substitute — `~/lib/audit/trace.ts` caps `outputPreview` at 4000 chars and flags `outputTruncated`, and B0-390 notes the previews are sliced at write time precisely across the label/SDS text (dilution ratios, EPA numbers, ppm, contact times) that these metrics need to read.

**Fix:** resolve `chunk_id → rag.document_chunk.chunk_text` at *export* time, not at write time. The ids are already persisted; the corpus is immutable per ingest; storing the text twice inflates `test_result_items` for no gain. An export-time join keeps the runtime path untouched.

Ordered contexts matter. `context_precision` is a ranking metric — the export must preserve the order the model saw, post-rerank, not a set.

---

## The four metrics

### 1. Faithfulness — are the answer's claims supported by the retrieved chunks?

**Method.** Decompose the answer into atomic, pronoun-free statements; judge each one against the retrieved context as supported / not supported; score = supported ÷ total.

**Why it matters most here.** This is the metric that catches the model answering a dilution or disinfection question from training knowledge. That is exactly the failure the mandatory-retrieval guardrail in `product-support-prompts.ts` exists to prevent (and which AGENTS.md records being removed by accident twice, B0-352 / B0-530). Right now nothing measures whether the guardrail holds; this does.

**Two adaptations we must make, and must not skip:**

- **Severity weighting.** The standard formulation is an unweighted mean. "Betco makes cleaning products" (true, trivial) offsets "dilute 1:64" (wrong, regulated). A 0.8 whose one failing statement is a contact time is a safety defect, not an 80%. Classify each statement as `regulated` (dilution, EPA/DIN, contact time, ppm, PPE, surface approval) or `general`, report both means, and gate only on the regulated one.
- **Per-chunk attribution.** The standard formulation flattens contexts with `"\n".join(...)` and loses which chunk grounded which claim. We already carry `document_id` / `chunk_id` per ref; keeping the attribution turns "faithfulness 0.7" into "this claim came from nowhere" — the difference between a number and a debuggable finding.

**Cheaper companion, worth having:** verbatim quoted-span matching (fraction of quoted spans in the answer that appear literally in a source passage). Deterministic, zero LLM, catches fabricated citations outright. Good as a fast pre-filter before paying for statement decomposition.

### 2. Context precision — is the right chunk near the top?

**Method.** Per retrieved chunk, judge whether it was useful in arriving at the answer; then average precision over the ranked list.

**Read the formula before trusting the name.** The usual denominator is the count of *relevant chunks retrieved*, not total relevant:

```ts
const denominator = relevantRetrieved; // NOT the total number of relevant chunks
const score = sumOfPrecisionAtRelevantRanks / denominator;
```

So one relevant chunk at rank 1 scores **1.0** even if nine others were missed. It is a **ranking** measure with no recall sensitivity — not precision in the IR sense.

That is still the right measurement for us: it is a direct test of whether Cohere rerank + RRF + `limit × 5` over-fetch are ordering correctly, which is the largest unmeasured surface in `search.ts`. **But it must not be labelled "precision" on the dashboard.** Call it *rank quality*. Anything else gets misread every time.

#### Terms, with definitions

Seven distinct numbers get loosely called "precision" or "rank quality" in conversation. They are not interchangeable, and two of them differ only in a denominator that changes what the metric can detect. Every reported figure must name which of these it is.

Throughout: *relevant* means the candidate's `document_id` is in the item's judged-relevant set (document-level, see §3). A candidate list is the fused, ranked list of retrieved chunks; `k` is a cut-off into it.

| Term | Definition | What it detects | What it cannot |
| --- | --- | --- | --- |
| **hit@k** | 1 if any relevant document appears in the top `k`, else 0 | Total misses. The coarsest useful signal | Anything about ordering or completeness |
| **recall@k** | distinct relevant documents in the top `k` ÷ total judged-relevant | Whether retrieval found what exists | Where in the list they landed |
| **precision@k** | relevant candidates in the top `k` ÷ `min(k, list length)` | Dilution of the window the model reads | Whether anything was missed |
| **MRR** | mean over items of `1 / rank of first relevant`, 0 if none | How fast the model reaches something useful | Everything after the first hit |
| **AP (recall-sensitive)** | Σ precision-at-each-new-relevant-hit ÷ **total judged-relevant** | Ordering *and* completeness in one number | — |
| **MAP-retrieved** | Σ precision-at-each-new-relevant-hit ÷ **relevant documents actually retrieved** | Pure ordering, independent of recall | Missed documents — scores 1.0 with one hit at rank 1 and nine missed |
| **nDCG@k** | graded DCG over the top `k` ÷ IDCG of the ideal ordering | Ordering weighted by *how* relevant, not just whether | Requires graded labels (0/1/2), which cost more to produce |

**Reconciled 2026-09-12 — the implemented AP is recall-sensitive, which is the opposite of what §2 originally specified.** This doc proposed `denominator = relevantRetrieved` (MAP-retrieved). `evals/rag/rank-metrics.ts` divides by the count of judged-relevant documents instead, so failing to retrieve a relevant document costs AP rather than being silently dropped from the average. The reason is the docling migration: SDS chunk count rises ~6x, and the question the gate must answer is whether that retrieved *better* or merely *more*. A denominator that ignores misses cannot answer it. MAP-retrieved remains the right number for isolating rerank ordering from recall, and is worth adding back as a separate, separately-named metric — it is not currently implemented.

**Three defences against chunk fragmentation**, all in `rank-metrics.ts` and all present because a 6x finer chunking otherwise inflates these numbers for free: recall counts distinct documents; AP credits a document only at its first chunk; nDCG credits a document's gain once but lets the duplicate consume a position, so fragmentation dilutes nDCG rather than inflating it.

**Fusion and basis are explicit parameters, and every reported number carries them.** A turn may issue several retrieval calls, so `evals/rag/fuse.ts` collapses them by one of `best_rank` (union, each document at its best position — the default, and what the model actually saw), `first_call` (isolates the retriever from the agent's decision to search again) or `concat`. The ranking basis is `retrieved` or `reranked`. Where a call has no `rerank_rank`, the whole call falls back to retrieved order and the result is flagged `basisIsPure: false` — a list half-ordered by cross-encoder and half by cosine is not an ordering, and a "reranked" figure must never be read as pure when it is not.

**Finding, surfaced while implementing Phase 0 — the rerank ordering never reaches the model.** `search.ts` sorts the candidate pool by cross-encoder score, and `selectCuratedMatches` then re-sorts the survivors by cosine `similarity`. Reranking therefore changes *which* chunks survive the `limit × 5` over-fetch, but not the order they are presented in. Whether that is intended is a separate question from this doc, and not one to answer by guessing — it is precisely what rank quality exists to measure. Phase 0 captures `rerank_rank` so the measurement is possible; nothing about the ordering behaviour was changed.

**Cost.** This is one LLM verdict *per chunk*. With `limit × 5` over-fetch, a single test item can mean 40+ calls. Our implementation must run those concurrently and cap the judged candidate list (judge the final reranked top-k the model actually saw, not the raw over-fetch pool).

### 3. Context recall — does the retrieved set contain what the ideal answer needs?

**Method.** Requires a reference (ideal) answer. Classify each reference sentence as attributable to the retrieved context; score = attributable ÷ total.

**Two things to be clear about:**

- This is recall *of the reference answer's claims*, not corpus recall@k. It cannot tell us a relevant chunk exists that we failed to retrieve. For true recall@k we need labeled relevant chunk ids — see below.
- It is **blocked on references**, independent of tooling. `test_items.idealResponse` is populated on some rows only. Curating references for the golden sets is a prerequisite and a real cost; scope it explicitly rather than discovering it mid-implementation.

**The id-based variant is nearly free and we should do it first.** Given a labeled set of relevant documents per question, recall and precision are set arithmetic — no LLM, deterministic, instant, and it *does* catch the missed-document case that the reference-based version cannot. We already persist retrieved `chunk_id`s and `document_id`s. The only new input is the label.

**Reconciled 2026-09-12 — labels are `document_id`, not `chunk_id`.** This doc originally specified labelled relevant `chunk_id`s. That was reversed for two independent reasons. First, key stability: `document_key` survives a re-ingest where `chunk_key` embeds `chunk_index` and re-points whenever boundaries move. Second, and decisively, the docling migration re-chunks every SDS from scratch, so every SDS `chunk_id` changes at cutover — chunk-keyed labels would die at exactly the moment they are needed to compare before against after, after the domain-review hours had already been spent. Labels live in `test_items.expected_sources uuid[]`, which already has schema, CSV round-trip and a document picker, and has never been used.

The cost of going document-level is that a document can be retrieved while the passage answering the question is in a region no chunk covers — the live SDS defect exactly. §4 entity recall is what closes that blind spot, which raises it from a nice-to-have to a required companion rather than a fourth metric of equal standing.

Recommended order: **id-based recall/precision first** (cheap, deterministic, catches the real regression), reference-based recall second (needs curation).

### 4. Entity recall — did retrieval surface the specific regulated facts?

**Method.** Extract entities from the reference and from the retrieved context; score = overlap ÷ reference entities.

**The textbook formulation fails on this corpus.** It reduces to a raw set intersection:

```ts
const referenceSet = new Set(referenceEntities);
const overlap = contextEntities.filter((e) => referenceSet.has(e)).length;
const score = overlap / referenceEntities.length;
```

LLM extraction followed by **raw string comparison, no normalization**. Our entities are `1:64`, `EPA Reg. No. 6836-78`, `10 minutes`, `DIN 02246787`, `200 ppm`. `"1:64"` vs `"1 to 64"`, `"6836-78"` vs `"EPA Reg. No. 6836-78"`, `"10 min"` vs `"10 minutes"` — each scores as a miss. The metric would systematically under-report and we would spend the quarter debugging the grader instead of the retriever.

**We must write this one ourselves**, reusing normalizers we already own:

- `~/lib/rag/betco-product-name.ts` — product name canonicalization
- `~/lib/rag/formulation-variant-rules.ts` — variant/formulation equivalence
- `sdsProductDedupeKey`, `normalizeSdsTitleToProductCode` (`~/lib/rag/search.ts`)
- `scripts/extract-label-dilution.ts` — dilution ratio parsing

Entity *classes* should be explicit and typed (`dilution_ratio`, `epa_reg`, `din`, `contact_time`, `ppm`, `product_name`, `surface`), each with its own normalizer and its own recall number. A single blended "entity recall" hides that EPA numbers are at 0.95 and contact times at 0.4.

**Reconciled 2026-09-12 — five of the seven classes exist; three are specified and not built.** `evals/rag/normalize.ts` implements `epa_registration`, `din`, `dilution`, `contact_time` and a catch-all `literal`. `ppm`, `product_name` and `surface` currently fall through to `literal`, which means they are matched but get no normalizer and no per-class number — the exact blending this section warns against. `product_name` is the most costly omission, since the normalizers to reuse already exist (`~/lib/rag/betco-product-name.ts`, `~/lib/rag/formulation-variant-rules.ts`) and product-name variance is high in this corpus. Closing the gap is small and should happen before entity recall is reported per class.

Normalizer decisions made while implementing, each argued in TSDoc at the implementation:

- **A sub-registration does not satisfy its parent.** `1839-95-10352` is a distributor product with its own label, directions and contact time; matching it against a requirement for `1839-95` would let retrieval answer about one product using another's document. The relationship stays visible on the normalized value, so family-level matching is an explicit opt-in and never silent. Leading zeros are stripped, being padding rather than identity.
- **Dilution tolerance is 2% relative** (absolute floor 0.005 oz/gal), because the two sides round independently — `1:100` is 1.28 oz/gal and labels print `1.3`. 2% sits well below the gap between adjacent real dilutions (1:64 vs 1:60 is 6.7%). Ratios convert on the label convention `128 × c / w`, not the strict volumetric `128 / (w+c)`, because the label figure is what a human labeller transcribes.
- **Contact time is exact, no tolerance** — a dwell time is a registered claim, and every unit converts by an exact integer. Single-letter units (`10 m`, `10 s`) are rejected: in SDS text `m` is metres far more often than minutes.
- **No stemming on literals.** The error directions are asymmetric — a false negative gets investigated, a false positive asserts a regulated claim the corpus does not contain and looks like a pass.
- **Matching is per candidate, so an entity split across a chunk boundary is a miss.** That is the chunking defect showing through, not a scoring artifact, and it is signal the migration should move.

---

## Implementation plan

Each phase ships something usable on its own.

### Phase 0 — make retrieval observable — **implemented, uncommitted**

Two halves: capture what was being thrown away at write time, and join the text back at read time.

**Write-time (rank capture).** Rank had to be captured at the point it exists, because two separate steps destroy it before anything persists:

1. `search.ts` reranks, then discards `relevance_score` three lines later — rank survives only as array position.
2. `selectCuratedMatches` (`~/lib/retrieval/source-selection.ts`) immediately re-sorts the survivors by cosine `similarity`, erasing that position.
3. The workflow's `collectRetrievedDocumentChunksFromToolOutputs` then unions every call into a deduped Map, erasing call boundaries too.

So the fix stamps the ranking onto the rows as *data* rather than order, and carries it through the existing chokepoints:

- `RagSearchMatch` gains `rerank_score` / `rerank_rank`, set in the rerank block (`~/lib/rag/search.ts`).
- `CuratedSource` carries them through `buildCuratedSource` (`~/lib/retrieval/product-knowledge.ts`); synthetic sources get `null`, never `0`.
- `sourcePayload` emits them into the tool output (`~/lib/tools/product-tools.ts`).
- `retrievalCallRecordSchema` + `final_output.retrieval_calls` — per call, ordered, un-deduped (`product-support-schemas.ts`), written by `collectRetrievalCallsFromToolOutputs`.

`retrieved_document_chunks` is untouched. It remains the B0-635 forensic union that `/admin/observability`, `prompt-insights.ts` and `extractRetrievedDocumentChunks` read; `retrieval_calls` sits beside it.

**Read-time (text join).** `~/lib/tests/retrieval-dataset.ts` — a library, not script-only logic, so the Phase 2+ in-process grading pass reuses it:

- `fetchChunkTextByIds` — batched, uuid-screened (a synthetic id in a `.in('id', …)` filter makes Postgres throw the whole batch, the trap `assembleDocumentBodies` already documents).
- `resolveContext` / `summarizeCoverage` — classify every reference as `resolved` / `missing` / `synthetic` / `no_chunk_id`, so a stale join is visible instead of scored.
- `buildRetrievalEvalRecords` — one batched round trip per run, not per item.
- `extractRetrievalCalls` (`response-payload.ts`) returns `null` for pre-field payloads and `[]` for a turn that genuinely retrieved nothing. **Collapsing the two scores every historical run as having retrieved nothing** — a fabricated regression indistinguishable from a real one.

**CLI.** `scripts/export-retrieval-dataset.ts <runId> --out <dir>` writes JSONL; `--dry-run` reports coverage only. Warns below 90% resolution, because that reads as a retrieval collapse when it is actually a re-ingest.

No metrics computed. Deliverable: a run's retrieval is inspectable, and rank is no longer being discarded on every turn.

### Phase 1 — deterministic retrieval metrics — **not started, blocked on labels**

- Label relevant **documents** for one golden set. **Reconciled 2026-09-12: not `product-specialist-25.csv`.** That file is not in the database — none of the four `test-sets/*.csv` files matches any of the 1,031 `test_items` prompts by exact, normalized or fuzzy comparison, and all four carry the obsolete header with no `ideal_response` or concept columns. They are dead refusal-detection fixtures from a single 2026-07-14 commit and nothing reads the directory at runtime.
- Id-based recall and precision over those labels. Pure set arithmetic, no LLM.
- Quoted-span verbatim match. No LLM. **Implemented** (`~/lib/tests/quoted-span.ts`), and it carries less signal than pitched: 57% of answers quote nothing, and of 494 sampled spans only 21% appear in chunk text while 66% appear in a document title or heading. It measures citation hygiene more than grounding — report it, do not steer on it.
- Deliverable: retrieval regressions become visible on every run, at zero grading cost.

**The blocker is labels, and it is total.** `expected_sources` is populated on 0 of 1,031 items. Three decisions gate the labelling: how negative examples are treated (roughly a quarter of a typical set has no positive retrieval answer, and `expected_should_answer` was dropped by B0-932 so there is no signal to inherit); who does the domain review (4-5 h per 20 items, needs Betco product knowledge, currently unnamed); and which set. On the last, a question-class check on 2026-09-12 found the live golden roster — 5 sets, 106 items — contains **zero first-aid items and one disposal item**, so it cannot gate a migration whose central claim is about first-aid reachability. `Dilution Control Top 20` is a genuine dilution instrument (19 of 20 items); the only first-aid, disposal and hazard items in the database are 12 purpose-built items inside the archived, `is_golden = false` `Product Golden Test Set`.

Tooling note: `/api/admin/rag/document-search` now resolves a pasted uuid by id (2026-09-12). Before that the picker searched `title` and `document_key` only, so a labeller who found a document on `/admin/products/rag` could not paste its id into the picker at all — and Betco label titles are OCR-spaced (`p H 7Q`, not `pH7Q`), so title search does not find them either. There is still no way to write a reviewed batch of labels back to existing items: CSV upload always creates a new test set rather than updating one.

### Phase 2 — faithfulness — **not started, sequenced after the SDS fix**

**Must follow the SDS chunker fix, or the results are unattributable.** Roughly 53% of SDS body text never reaches retrieval (`sds-chunk-section-loss.md`), so until it is fixed a regulated claim matching no retrieved chunk may be dropped source text rather than a hallucination. Any quoted-span triage on SDS-backed answers has to be redone afterwards.

- Statement decomposition + per-statement grounding verdict on `completeStructuredWithUsage`, configured through `resolveItemGradingConfig` so cost lands in `/admin/cost` like every other grader.
- Severity classification (`regulated` vs `general`) and per-chunk attribution from day one — they are not a later refinement, they are what makes the number actionable.
- Deliverable: ungrounded regulated claims are detectable.

### Phase 3 — rank quality and entity recall — **implemented, uncommitted, in `evals/rag/`**

- Rank quality over the fused ranked list: `hit@k`, `recall@k`, `precision@k`, MRR, AP, graded `nDCG@k`, rank-of-first-relevant. Definitions and the AP-denominator divergence are in §2.
- Typed entity recall with our own normalizers, reported per entity — five of the seven specified classes, see §4.
- Rerank effect: signed displacement of relevant documents, MRR retrieved vs reranked and the lift between them, top-k crossings. This is what measures the §2 finding that rerank ordering never reaches the model.
- Deliverable: rerank and RRF changes can be defended with a number.

**Layering.** Acquisition (Phase 0, touches the DB) → metric core (pure: no DB, no network, no clock, no unseeded randomness) → runner (CLI, writes a JSON snapshot). The core is pure so metrics can be exercised against fixtures rather than against whatever the local database holds — which matters concretely, since the local DB is not built from migrations and carries stuck runs and counter drift. Snapshots are the unit of comparison precisely because a corpus re-ingest makes the chunk ids they came from dangle: a pre-migration baseline has to outlive the migration.

**Three disciplines the code enforces, each guarding against a way this measurement goes quietly wrong:**

- `retrieval_calls: null` (payload predates the field) is never read as `[]` (the turn retrieved nothing). Rank metrics skip the first. Every historical run is `null`, which is why rank data only starts accruing once Phase 0 ships — it cannot be backfilled.
- An episode below the coverage floor is `unscorable`, not low-scoring. Unresolved chunks are a stale join, and scoring them as misses reads a re-ingest as a retrieval collapse.
- An unlabelled item and a negative example both look like an empty relevant set, and are held apart. Conflating them is the failure that silently poisons recall. Negatives currently return `unscorable` with a `negative_example` marker rather than being scored, so the open decision stays open rather than being resolved by implementation accident.

Aggregates always report the unscorable count broken down by reason alongside the mean, because a mean over 6 of 20 episodes is a different claim from a mean over 20. Comparison is paired by item, with a bootstrap CI on the delta vector and a warning when the two sides' unscorable rates diverge by more than 10 points — the shape a stale-join migration produces.

Verification at time of writing: 206 tests across 10 files, `tsc --noEmit` clean, `eslint` clean.

### Phase 4 — surface and gate

- Persist scores into `test_result_items` (new jsonb column, or a `response_payload` subkey) so the existing trend infrastructure — `golden-set-trend.ts`, `report-metric-trend.ts`, `run-comparison-diff.ts` — renders them with no new charting.
- Extend `scripts/run-eval-gate.ts` with retrieval floors.
- Deliverable: retrieval quality is a merge gate.

---

## Gating rules

- **Concept coverage stays the pass/fail axis.** Retrieval metrics gate separately and are never aggregated into the concept score.
- **Regulated faithfulness gates hard.** An ungrounded regulated claim is a failure regardless of whether the answer scored well on concepts.
- **Rank quality and entity recall gate on deltas, not absolutes.** We have no calibrated baseline; a fixed floor would be invented. Gate on regression against the previous completed run, the same way `run-comparison` already works.
- **Do not set a threshold from a single curve.** B0-97 is the standing lesson: the cross-reference confidence score was tuned off a threshold curve and later measured at AUC 0.319 — no usable ability to rank correct above incorrect. Validate that a metric *separates known-good from known-bad runs* before it gates anything.

## Open questions

- Who curates reference (ideal) answers, and for which sets? Phase 3's reference-based recall is blocked on this and the cost is real.
- ~~Labeled relevant chunk ids: harvest or label independently?~~ **Settled: reference-anchored labelling, with harvest as a confirmatory second pass only.** Harvest bias is measured, not theoretical. On the pilot set, the controlling `VCT Maintenance Program` document was retrieved in 27% of runs for its question while a wrong LVT product hit 100%; `Wood Gym Floor FAQ Guide` was retrieved in 86% of runs for a kitchen-degreaser question. A harvest-anchored process would have recorded those as ground truth at maximum frequency.
- Which context-precision denominator gates: the recall-sensitive AP now implemented, MAP-retrieved as originally specified, or both reported separately? See §2 — they answer different questions and only one is built.
- Do `ppm`, `product_name` and `surface` get their own normalizers and per-class recall, or stay folded into `literal`? See §4.
- Judge the raw `limit × 5` over-fetch pool or the reranked top-k the model actually saw? Top-k measures what shipped; the full pool measures what the reranker had to work with. Probably both, reported separately.
- Does the approximate query-embedding cache (cos ≥ 0.95 short / ≥ 0.90 long, `search.ts`) change retrieval for near-miss queries? Untested today, and these metrics are the instrument that could finally answer it.
