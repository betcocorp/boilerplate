# SDS sections are silently dropped at chunking

Status: **open defect, unfixed** — found 2026-09-11. No ticket yet.

`rag.chunk_sds_document_text` discards any SDS section that contains no newline. Because these SDS bodies are extracted from two-column PDFs, a whole section routinely lands on a single line — so the discard is not an edge case. **18,183 of 30,641 sections (59%) are dropped, and 16.4M of 30.9M characters of SDS body text never reach retrieval.** The loss is structurally biased toward the *value* column, which is where the regulated content lives: first-aid instructions are absent from every chunk of 896 of the 1,128 documents that contain them.

This was found while building the RAG evaluation process ([`rag-evaluation-process.md`](./rag-evaluation-process.md)) — not by that process, which does not exist yet. It is the clearest argument for it.

---

## Impact

Measured against `rag.document.body_text` versus every chunk of the same document (SDS documents that have chunks at all — 1,162 of them):

| Regulated content | Present in body, absent from every chunk |
| --- | --- |
| "Get medical attention" (first aid) | **896 of 1,128 (79%)** |
| GHS "Signal word" | 468 |
| CAS numbers | 453 |

What this looks like in practice, using `01e3a537` (Betco Triforce, 35,207 chars of body → 14 chunks totalling 15,783 chars):

- Sections **1** (identification), **3** (composition), **6** (accidental release), **10** (stability) and **13** (disposal) produce **zero** chunks.
- Sections 4, 5 and 7 retain only the *label* column — `Eye contact Skin contact Inhalation : : :` — while the *value* column carrying the instruction (`Get medical attention immediately…`, 2,125 chars) is dropped.

So retrieval can establish that an SDS **has** a first-aid section, and cannot say what the first aid **is**. Worse than absence: the surviving label-only chunk is a strong lexical match for "first aid skin contact", so it will rank for exactly the query it cannot answer. A hybrid search scores it well on BM25 and a cross-encoder sees plausible-looking section text. Nothing downstream can tell that the answer was removed at ingest.

---

## Scope: SDS only

Every other document kind was checked with the same method. SDS is the only one with section loss.

Per-document coverage (`sum(chunk_text) / body_text`, documents that have chunks):

| kind | docs | mean | median | under 50% | under 90% |
| --- | --- | --- | --- | --- | --- |
| product_line_profile | 1,703 | 101.6% | 100.0% | 0 | 9 |
| **sds** | **1,162** | **35.9%** | **41.4%** | **866** | **1,136** |
| label | 789 | 94.6% | 95.3% | 0 | 28 |
| efficacy | 146 | 114.3% | 113.9% | 0 | 0 |
| knowledge | 107 | 98.9% | 96.5% | 0 | 15 |
| fastdraw_dilution | 39 | 100.0% | 100.0% | 0 | 0 |

866 SDS documents fall below 50% coverage. **No document of any other kind does.** The non-SDS documents under 90% are all small (236-1,969 chars) and none falls below 76%; inspection shows the shortfall is whitespace normalization and markdown syntax stripping, not missing content. Ratios above 100% (efficacy, profiles) are heading duplication and chunk overlap, which is expected.

This split follows the code. SDS is chunked by `rag.chunk_sds_document_text`, which is the only chunker that splits on `Section N.` markers and therefore the only one making an assumption about where a section's heading ends. `label` and `knowledge` go through the TypeScript `~/lib/rag/markdown-chunking.ts` (heading-aware markdown splitting); `product_line_profile` and `efficacy` have their own SQL sync functions that do not do section parsing. Those chunkers have other defects — degenerate 1-2 character chunks, single paragraphs exceeding the size budget — but none of them silently discards content.

### A false positive worth recording

An initial probe of `label` documents appeared to show the same defect: 294 of 789 labels contained "DIRECTIONS FOR USE" in `body_text` but in no `chunk_text`, and 48 were missing "FIRST AID". Both were artifacts of the query, not the corpus.

The SDS chunker prepends its heading *into* `chunk_text` (`v_final_text := v_heading || E'\n' || v_sub_body`), so searching `chunk_text` alone is sufficient there. `markdown-chunking.ts` instead stores the heading in the separate `heading` column and the breadcrumb in `section_path`, so a section title lives outside `chunk_text` by design. Widening the predicate to `chunk_text OR heading OR section_path` drops both label figures to **zero**.

The SDS finding was then re-run under the same widened predicate as a control. It is unchanged at 896 of 1,128 — the text is genuinely in no column of any chunk.

---

## Methodology

Recorded in full because two similar-looking findings in this corpus turned out to be intended behaviour, and the difference was only visible by reading the code that produced them.

### 1. The symptom, from an unrelated measurement

A corpus-sizing pass compared `body_text` length against summed `chunk_text` length per document kind. Every kind sat at 95-100% coverage except SDS, at **36%** (30,978,231 body chars → 11,193,126 chunk chars across the 1,162 chunked SDS documents). A coverage figure that far out of line with every sibling kind is either a deliberate selection rule or a defect; nothing about the number itself says which.

### 2. Ruling out "intended behaviour" first

This corpus had already produced two false alarms, both of which looked exactly like ingest defects:

- **796 non-English documents with zero chunks** — intended. `~/lib/rag/retrieval-language.ts` documents that the `rag.sync_*_chunks` functions refuse a non-EN `p_language_code` and the match RPCs require `upper(d.language_code) = 'EN'`.
- **1,201 English SDS with zero chunks** — intended. Every one has `source_record.is_active = false`; the sync filters inactive source records. These are superseded documents.

Both were dismissed only after finding the line that causes them. The same bar was applied here, which is why the investigation targeted the chunking function rather than the symptom.

Note this also narrowed the question usefully: the 36% figure is **not** about documents that produce no chunks. Those were already excluded. It is about documents that chunk *partially*, which points at per-section logic rather than at a document-level filter.

### 3. Locating the live code path

`rag.chunk_sds_document_text` is defined in four migrations (`20260520170145`, `20260602121000`, `20260725091000`, `20260725093000`). Reading the first one found would have described behaviour that is no longer live, so the live definition was confirmed directly:

```
docker exec supabase_db_bex2 psql -U postgres -d postgres -c "\df rag.chunk_sds_document_text"
```

which also corrected an assumption about the argument order — `p_title` is the **fourth** parameter, not the second:

```
p_body_text text, p_max_chars integer DEFAULT 1600,
p_overlap_chars integer DEFAULT 150, p_title text DEFAULT NULL
```

matching `20260725093000_fix_chunk_sds_document_text_signature.sql`, the latest definition.

### 4. Reading the function

The section loop splits the body on `Section N.` markers, then decides what is heading and what is body (`20260725093000:69-87`):

```sql
v_first_line := split_part(v_section_text, E'\n', 1);

IF v_first_line ~ '(?:Section|Secci[oó]n|SECTION)\s+\d{1,2}' THEN
  v_heading := trim(v_first_line);
  v_body := CASE
    WHEN strpos(v_section_text, E'\n') > 0
      THEN trim(substring(v_section_text FROM strpos(v_section_text, E'\n') + 1))
    ELSE ''
  END;
```

The assumption is that a section's heading occupies its own line. When the section has **no newline**, the entire section — heading and content together — is assigned to `v_heading`, and `v_body` becomes the empty string.

What follows then drops it without a trace:

1. `v_paragraphs := regexp_split_to_array('', E'\\n{2,}')` yields `{''}`, so `v_para_n` is **1**, not 0 — the `IF v_para_n = 0 THEN CONTINUE` guard at `:92-94` does not fire.
2. The paragraph loop hits `CONTINUE WHEN v_para IS NULL OR length(v_para) = 0` at `:103` and accumulates nothing, so `v_sub_parts` stays `'{}'`.
3. Both emit blocks are guarded by `IF array_length(v_sub_parts, 1) > 0` (`:110` and `:136`). `array_length` of an empty array is **NULL**, not 0, so both are false.

No chunk is emitted, no error is raised, and the caller has no way to distinguish this from a section that legitimately had nothing in it. `v_heading` — which at this point holds the whole section text — is simply discarded with the loop iteration.

The prior version reached the same outcome more visibly, via an explicit `CONTINUE WHEN length(v_body) < 20` (`20260602121000:136`).

### 5. Minimal reproduction

Static reading of PL/pgSQL is not proof. The function is pure — it returns a table and touches nothing — so it can be called directly with synthetic input. Two calls, identical content, differing only by one newline character:

```sql
-- A: section on one line
select count(*) from rag.chunk_sds_document_text(
  'Section 4. First aid measures Eye contact : Get medical attention immediately. Skin contact : Wash with soap.',
  1600, 150, 'Test Product');
--> 0 chunks, 0 chars

-- B: identical text, newline after the heading
select count(*) from rag.chunk_sds_document_text(
  E'Section 4. First aid measures\nEye contact : Get medical attention immediately. Skin contact : Wash with soap.',
  1600, 150, 'Test Product');
--> 1 chunk, 131 chars
```

This is the load-bearing evidence. Everything else is corroboration.

### 6. Quantifying against the real corpus

Two independent measurements, so that neither the mechanism nor the impact rests on the other:

- **Mechanism, at corpus scale** — applying the same section split to every SDS body and counting sections with no newline: **18,183 of 30,641 sections, 16.4M of 30.9M characters.**
- **Impact, measured without reference to the mechanism** — for each regulated phrase, count documents where the phrase appears in `body_text` but in none of that document's `chunk_text`:

```sql
select count(*) filter (where not exists (
         select 1 from rag.document_chunk c
         where c.document_id = s.id and c.chunk_text ilike '%Get medical attention%'))
from (select d.id, d.body_text from rag.document d
      where d.document_kind = 'sds'
        and exists (select 1 from rag.document_chunk c where c.document_id = d.id)
        and d.body_text ilike '%Get medical attention%') s;
```

The second measurement makes no assumption about *why* the text is missing. That it agrees with the first is what makes the causal claim safe.

### 7. Ruling out a stale local database

All measurement was against a local Supabase instance whose `supabase_migrations.schema_migrations` table is empty — it was restored from a dump, not built from the migration chain, and it is demonstrably missing at least one column the migrations add (`rag.document.corpus_scope`, from `20260725102000_add_corpus_scope_to_document_b0283.sql`). A defect observed there could be an artifact of that staleness rather than a real one.

Two checks settle it: the live `pg_get_functiondef` output matches `20260725093000` exactly, and no migration on disk after that one redefines the function. **The defect is in the committed code, not in this database.** Production has it.

### 8. The compounding discovery

Because the fix is a chunker change, the obvious next question is whether existing rows would be re-chunked. They would not. The current candidate predicate is zero-chunk-only (`20260902191000_guard_non_english_chunk_sync_b0804.sql:116-117`):

```sql
(ds.is_active AND ds.has_chunkable_text AND ds.existing_chunk_count = 0)
OR (NOT ds.is_active AND ds.existing_chunk_count > 0)
```

A staleness arm existed and was removed. `20260522121000_sds_rechunk_legacy.sql:87-92` had:

```sql
ds.existing_chunk_count = 0
OR ds.latest_chunk_updated_at IS NULL
OR ds.latest_chunk_updated_at < ds.document_updated_at
```

It was dropped in `20260602121000:296` and never restored. The consequence is visible in the data — grouping the 1,162 chunked SDS by which chunk generation they carry (`section_path` containing `section_N` = current, otherwise first-generation):

| Generation present | Documents |
| --- | --- |
| Both generations | 841 |
| First-generation only | 254 |
| Current only | 67 |

254 documents have never been re-chunked by the current function at all, and **841 carry two generations of chunks simultaneously** — the old chunks were never deleted when new ones were written. That is a second, separate problem: retrieval can surface stale chunk text alongside current text for the same document.

(An earlier pass reported this split as 805/355. That figure counted documents per chunk row rather than per document and is superseded by the table above.)

---

## What to fix

Three parts, and **the first is useless without the second**.

1. **The chunker** (`rag.chunk_sds_document_text`). When `strpos(section, E'\n') = 0`, treat the text following the matched `Section N.` prefix as the body instead of assigning the whole line to `v_heading` and emptying the body. Add a final fallback that emits the section when the paragraph loop yields nothing, so that no future input shape can be dropped in silence.
2. **The re-chunk predicate** (`rag.sync_sds_chunks`). Restore the staleness arm, then force a pass by touching `document.updated_at` for SDS. Without this the fix applies to nothing that already exists.
3. **The duplicate generations.** Decide whether re-chunking replaces a document's chunks or adds to them. 841 documents currently say "adds".

Size: roughly one day, plus a full re-chunk and re-embed run over ~1,162 documents. The re-embed is the long pole.

**Do not ship 1 without 2.** A chunker fix that changes no existing row reads as "fixed" on every test that exercises the function directly, and changes nothing about what retrieval can reach.

---

## Why this matters to the evaluation work

This defect is the case for [`rag-evaluation-process.md`](./rag-evaluation-process.md), stated more concretely than that document manages on its own.

- **Entity recall** (its fourth metric) over CAS numbers, EPA registration numbers and contact-time phrases would have caught this immediately, and would have kept catching it. Instead it sat undetected in the regulated corpus.
- **Faithfulness** results measured before the fix are suspect in a specific direction. An answer stating a regulated fact that matches no retrieved chunk may not be a fabrication — the supporting text may have been dropped at ingest. Any quoted-span or faithfulness triage run against SDS-backed answers should be redone after the re-chunk, and until then those failures should be treated as unattributed rather than as model hallucination.
- It is also a worked example of the gap the process is meant to close: today a wrong answer to "what is the first aid for skin contact with Triforce" would be investigated as a generation problem, because nothing in the harness can say that retrieval was never able to answer it.
